import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertPlainTree, extractPlainTar, readPlainFile } from "./plain-files.ts";

const temp = (name: string) => mkdtemp(path.join(tmpdir(), `agent-runtime-${name}-`));
const env = { ...process.env, COPYFILE_DISABLE: "1" };

/** Packs `dir` with the system tar, as a sandbox would. */
async function pack(dir: string, members: string[], format?: string): Promise<string> {
  const archive = path.join(await temp("archive"), "a.tar");
  const formatArgs = format ? [`--format=${format}`] : [];
  execFileSync("tar", [...formatArgs, "-C", dir, "-cf", archive, ...members], { env });
  return archive;
}

describe("extractPlainTar", () => {
  it("unpacks directories and regular files, long names included", async () => {
    const dir = await temp("src");
    const deep = path.join("a".repeat(60), "b".repeat(60), "c".repeat(60));
    await mkdir(path.join(dir, deep), { recursive: true });
    await writeFile(path.join(dir, deep, "file.jsonl"), "deep\n");
    await writeFile(path.join(dir, "top.txt"), "top\n");
    for (const format of [undefined, "pax", "ustar"]) {
      const into = await temp("into");
      // ustar cannot hold the 180-character directory, so it gets only the top file.
      const members = format === "ustar" ? ["top.txt"] : ["."];
      await extractPlainTar(await pack(dir, members, format), into, 1024 * 1024);
      expect(await readFile(path.join(into, "top.txt"), "utf8")).toBe("top\n");
      if (format !== "ustar")
        expect(await readFile(path.join(into, deep, "file.jsonl"), "utf8")).toBe("deep\n");
    }
  });

  it("refuses a symlink, whatever it points at", async () => {
    const dir = await temp("src");
    await symlink("/etc/passwd", path.join(dir, "leak.txt"));
    const into = await temp("into");
    await expect(extractPlainTar(await pack(dir, ["leak.txt"]), into, 1024)).rejects.toThrow(
      "leak.txt is a symlink",
    );
    expect(await readdir(into)).toEqual([]);
  });

  it("refuses a hard link", async () => {
    const dir = await temp("src");
    await writeFile(path.join(dir, "a"), "x");
    await link(path.join(dir, "a"), path.join(dir, "b"));
    await expect(
      extractPlainTar(await pack(dir, ["a", "b"]), await temp("into"), 1024),
    ).rejects.toThrow("is a hard link");
  });

  it("refuses a path that leaves the directory", async () => {
    // A tar made by hand: one member named ../escaped.
    const header = Buffer.alloc(512);
    header.write("../escaped", 0);
    header.write("0000644\0", 100);
    header.write("00000000001\0", 124);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const body = Buffer.alloc(512);
    body.write("x");
    const archive = path.join(await temp("archive"), "a.tar");
    await writeFile(archive, Buffer.concat([header, body, Buffer.alloc(1024)]));
    const into = await temp("into");
    await expect(extractPlainTar(archive, into, 1024)).rejects.toThrow(
      "points outside the archive",
    );
    expect(await readdir(path.dirname(into))).not.toContain("escaped");
  });

  it("stops at its size cap, and at an archive cut short", async () => {
    const dir = await temp("src");
    await writeFile(path.join(dir, "big"), Buffer.alloc(10_000));
    const archive = await pack(dir, ["big"]);
    await expect(extractPlainTar(archive, await temp("into"), 5_000)).rejects.toThrow(
      "more than 5000 bytes",
    );
    const whole = await readFile(archive);
    const cut = path.join(await temp("archive"), "cut.tar");
    await writeFile(cut, whole.subarray(0, 4096));
    await expect(extractPlainTar(cut, await temp("into"), 100_000)).rejects.toThrow("ends early");
  });
});

/** A ustar archive made by hand, header by header, for members no tar would write. */
async function rawTar(members: { name: string; type: string; link?: string }[]): Promise<string> {
  const blocks = members.map(({ name, type, link }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124);
    header.write(type, 156);
    if (link) header.write(link, 157);
    header.write("ustar\u000000", 257);
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return header;
  });
  const archive = path.join(await temp("archive"), "a.tar");
  await writeFile(archive, Buffer.concat([...blocks, Buffer.alloc(1024)]));
  return archive;
}

/** One archive of `[dir, member]` pairs in order, as a sandbox could build by hand. */
async function packFrom(...parts: [string, string][]): Promise<string> {
  const archive = path.join(await temp("archive"), "a.tar");
  parts.forEach(([dir, member], i) =>
    execFileSync("tar", [i === 0 ? "-cf" : "-rf", archive, "-C", dir, member], { env }),
  );
  return archive;
}

describe("extractPlainTar with links", () => {
  const links = { links: true };

  it("keeps symlinks as they were, wherever they point, and executable bits", async () => {
    const dir = await temp("src");
    await mkdir(path.join(dir, "venv/bin"), { recursive: true });
    await symlink("/usr/bin/python3", path.join(dir, "venv/bin/python3"));
    await symlink("python3", path.join(dir, "venv/bin/python"));
    await writeFile(path.join(dir, "venv/bin/pip"), "#!/bin/sh\n", { mode: 0o4755 });
    await writeFile(path.join(dir, "notes.txt"), "n");
    await symlink("../../notes.txt", path.join(dir, "venv/bin/up"));
    const into = await temp("into");
    await extractPlainTar(await pack(dir, ["."]), into, 1024, links);
    expect(await readlink(path.join(into, "venv/bin/python3"))).toBe("/usr/bin/python3");
    expect(await readlink(path.join(into, "venv/bin/python"))).toBe("python3");
    expect(await readlink(path.join(into, "venv/bin/up"))).toBe("../../notes.txt");
    // The executable bit, and nothing else: no setuid.
    expect((await stat(path.join(into, "venv/bin/pip"))).mode & 0o7777).toBe(0o755);
    expect((await stat(path.join(into, "notes.txt"))).mode & 0o111).toBe(0);
  });

  it("refuses a file under a symlink, in either order, and writes nothing through it", async () => {
    const outside = await temp("outside");
    const linkDir = await temp("src");
    await symlink(outside, path.join(linkDir, "a"));
    const realDir = await temp("src");
    await mkdir(path.join(realDir, "a"));
    await writeFile(path.join(realDir, "a/x"), "planted");
    for (const archive of [
      await packFrom([linkDir, "a"], [realDir, "a/x"]),
      await packFrom([realDir, "a/x"], [linkDir, "a"]),
    ]) {
      await expect(extractPlainTar(archive, await temp("into"), 1024, links)).rejects.toThrow(
        "a/x is under the symlink a",
      );
      expect(await readdir(outside)).toEqual([]);
    }
  });

  it("refuses a symlink under a symlink, so making one never goes through another", async () => {
    const outside = await temp("outside");
    const first = await temp("src");
    await symlink(outside, path.join(first, "a"));
    const second = await temp("src");
    await mkdir(path.join(second, "a"));
    await symlink("/etc/passwd", path.join(second, "a/b"));
    const archive = await packFrom([first, "a"], [second, "a/b"]);
    await expect(extractPlainTar(archive, await temp("into"), 1024, links)).rejects.toThrow(
      "a/b is under the symlink a",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a symlink where the archive already has something", async () => {
    const asDir = await temp("src");
    await mkdir(path.join(asDir, "a"));
    const asLink = await temp("src");
    await symlink("/tmp", path.join(asLink, "a"));
    await expect(
      extractPlainTar(await packFrom([asDir, "a"], [asLink, "a"]), await temp("into"), 1024, links),
    ).rejects.toThrow("a is in the archive twice");
  });

  it("makes a hard link a copy, and refuses one to a file the archive does not hold", async () => {
    const dir = await temp("src");
    await writeFile(path.join(dir, "a"), "shared");
    await link(path.join(dir, "a"), path.join(dir, "b"));
    const into = await temp("into");
    await extractPlainTar(await pack(dir, ["a", "b"]), into, 1024, links);
    expect(await readFile(path.join(into, "b"), "utf8")).toBe("shared");
    expect((await stat(path.join(into, "b"))).nlink).toBe(1);
    // A hard link to a file outside the archive, such as the job's own.
    const archive = await rawTar([{ name: "b", type: "1", link: "etc/passwd" }]);
    await expect(extractPlainTar(archive, await temp("into"), 1024, links)).rejects.toThrow(
      "links to a file the archive does not hold",
    );
  });

  it("still refuses a link whose own path leaves the directory, and devices", async () => {
    const outside = await temp("outside");
    const into = path.join(outside, "into");
    await mkdir(into);
    const escaping = await rawTar([{ name: "../escaped", type: "2", link: "/etc/passwd" }]);
    await expect(extractPlainTar(escaping, into, 1024, links)).rejects.toThrow(
      "points outside the archive",
    );
    expect(await readdir(outside)).toEqual(["into"]);
    const device = await rawTar([{ name: "null", type: "3" }]);
    await expect(extractPlainTar(device, into, 1024, links)).rejects.toThrow('null is of type "3"');
  });
});

describe("readPlainFile and assertPlainTree", () => {
  it("pass a symlink with links, unread, but not a tree that is one", async () => {
    const dir = await temp("tree");
    const big = path.join(await temp("big"), "big");
    await writeFile(big, Buffer.alloc(10_000));
    await symlink(big, path.join(dir, "big"));
    await expect(assertPlainTree(dir, 100)).rejects.toThrow("big is not a regular file");
    // Not followed, so the file it names counts for nothing.
    await assertPlainTree(dir, 100, { links: true });
    const pointer = path.join(await temp("tree"), "workspace");
    await symlink(dir, pointer);
    await expect(assertPlainTree(pointer, 100, { links: true })).rejects.toThrow(
      "is not a regular file or directory",
    );
  });

  it("read a regular file and refuse a symlink to one", async () => {
    const dir = await temp("files");
    await writeFile(path.join(dir, "ok.txt"), "fine");
    await symlink(path.join(dir, "ok.txt"), path.join(dir, "link.txt"));
    expect((await readPlainFile(path.join(dir, "ok.txt"), 100)).toString()).toBe("fine");
    await expect(readPlainFile(path.join(dir, "link.txt"), 100)).rejects.toThrow("is a symlink");
    await expect(readPlainFile(path.join(dir, "ok.txt"), 2)).rejects.toThrow("larger than 2 bytes");
    await expect(readPlainFile(dir, 100)).rejects.toThrow("not a regular file");
  });

  it("refuse a tree holding a symlink, or that is one", async () => {
    const dir = await temp("tree");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "a"), "a");
    await assertPlainTree(dir, 100);
    await symlink("/etc", path.join(dir, "sub", "etc"));
    await expect(assertPlainTree(dir, 100)).rejects.toThrow("sub/etc is not a regular file");
    const pointer = path.join(await temp("tree"), "sessions");
    await symlink(dir, pointer);
    await expect(assertPlainTree(pointer, 100)).rejects.toThrow(
      "is not a regular file or directory",
    );
    await expect(assertPlainTree(path.join(dir, "sub"), 0)).rejects.toThrow("more than 0 bytes");
  });
});
