// Keeps an agent's session between runs on a platform that cannot keep the
// sandbox: a Cloud Run job's sandboxes end with the execution, so the thread's
// next run starts in a new one. executeRun restores the session directory into
// the sandbox before the runner starts and saves it after the runner exits.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { assertPlainTree, extractPlainTar } from "./plain-files.ts";

/** The most a stored session may hold. */
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/**
 * Where sessions are kept, by key (usually the thread). Both sides are local
 * directories; executeRun copies them into and out of the sandbox.
 */
export interface SessionStore {
  /** Replaces whatever is stored under `key` with the contents of the directory `from`. */
  save(key: string, from: string): Promise<void>;
  /**
   * Fills the existing directory `into` with what is stored under `key`.
   * Resolves false when nothing is, as for a thread's first run; rejects when
   * the store could not be read, so a run does not start over by mistake.
   */
  restore(key: string, into: string): Promise<boolean>;
  /**
   * Optional, for executeRun's `session.stream`: stores an archive the job
   * never unpacks. `write` writes it to the new file it is given and resolves
   * false when there was nothing to write, which keeps what is stored. A
   * failed write keeps it too.
   */
  saveArchive?(
    key: string,
    write: (file: string) => Promise<boolean>,
    opts: { gzip: boolean },
  ): Promise<boolean>;
  /** Optional, with `saveArchive`: the file holding the key's archive, or null when there is none yet. */
  archive?(key: string, opts: { gzip: boolean }): Promise<string | null>;
}

/** A key as a file name: letters, digits, `.`, `_` and `-` kept, anything else %-encoded. */
export function sessionFileName(key: string): string {
  if (!key) throw new Error("A session key cannot be empty");
  const safe = [...Buffer.from(key, "utf8")]
    .map((byte, i) => {
      const c = String.fromCharCode(byte);
      // A leading dot would hide the file, and a save's temporary file starts with one.
      const kept = /[A-Za-z0-9_-]/.test(c) || (c === "." && i > 0);
      return kept ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${safe}.tar`;
}

function tar(args: string[], tarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // COPYFILE_DISABLE keeps macOS tar from adding ._ files for extended attributes.
    const child = spawn(tarPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)),
    );
  });
}

export type DirectorySessionStoreOptions = {
  /** The tar binary; default `tar` on PATH. */
  tar?: string;
  /**
   * Keep symlinks, as links that are never followed: for a store of whole
   * workspaces, which hold venvs and node_modules. Use it with executeRun's
   * `session.links`. Default false.
   */
  links?: boolean;
  /** The most one session may hold. Default 256 MiB. */
  maxBytes?: number;
};

/**
 * One tar file per key under `rootDir`, which may be a Cloud Storage FUSE
 * mount (a job's sessions bucket, mounted read-write). A save writes a temporary
 * file and renames it over the key's, which replaces the object whole, so a
 * restore reads one save or another, never a mix. Two runs of the same key
 * that end together both save; the last rename wins and the other's turns are
 * lost from the session, so a thread should not run twice at once. A save
 * refuses a directory holding anything but directories and regular files, and
 * a restore creates nothing else; with `links`, symlinks too, kept as links.
 */
export class DirectorySessionStore implements SessionStore {
  readonly rootDir: string;
  private readonly tarPath: string;
  private readonly links: boolean;
  private readonly maxBytes: number;

  constructor(rootDir: string, options: DirectorySessionStoreOptions = {}) {
    this.rootDir = rootDir;
    this.tarPath = options.tar ?? "tar";
    this.links = options.links ?? false;
    this.maxBytes = options.maxBytes ?? MAX_SESSION_BYTES;
  }

  /** Where the key's session is kept. */
  pathFor(key: string): string {
    return path.join(this.rootDir, sessionFileName(key));
  }

  async save(key: string, from: string): Promise<void> {
    const target = this.pathFor(key);
    if (!(await lstat(from).catch(() => null))?.isDirectory()) {
      throw new Error(`No session directory at ${from}`);
    }
    // Without `links`, a link would be archived as one, or followed into
    // whatever it names. tar archives a symlink as a link and never follows it.
    await assertPlainTree(from, this.maxBytes, { links: this.links });
    await mkdir(this.rootDir, { recursive: true });
    const temp = path.join(
      this.rootDir,
      `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await tar(["-C", from, "-cf", temp, "."], this.tarPath);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** A plain tar is the same file a directory save writes; gzip adds `.gz`. */
  archivePath(key: string, opts: { gzip: boolean }): string {
    return opts.gzip ? `${this.pathFor(key)}.gz` : this.pathFor(key);
  }

  async saveArchive(
    key: string,
    write: (file: string) => Promise<boolean>,
    opts: { gzip: boolean },
  ): Promise<boolean> {
    const target = this.archivePath(key, opts);
    await mkdir(this.rootDir, { recursive: true });
    // Written in place on the store's volume and renamed over the key's, so a
    // restore reads one archive or another, never a part of one.
    const temp = path.join(
      this.rootDir,
      `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      if (!(await write(temp))) {
        await rm(temp, { force: true });
        return false;
      }
      await rename(temp, target);
      return true;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async archive(key: string, opts: { gzip: boolean }): Promise<string | null> {
    const file = this.archivePath(key, opts);
    const found = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return found ? file : null;
  }

  async restore(key: string, into: string): Promise<boolean> {
    const source = this.pathFor(key);
    const found = await stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!found) return false;
    // Read as untrusted too: only directories and regular files come out, and
    // with `links` symlinks made as links.
    await extractPlainTar(source, into, this.maxBytes, { links: this.links });
    return true;
  }
}
