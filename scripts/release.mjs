// Tags a release that carries its built `dist/`, so a project can depend on
// `github:airean-ltd/agent-runtime#v<version>` without building anything.
// `dist/` stays out of main: the tag points at a commit one step off it.
//
//   pnpm release          build, tag v<package.json version>, push main and the tag
//
// The Release workflow runs this on every push to main whose version has no
// tag yet, so bumping `version` in a PR is all a release takes. There it pushes
// the tag alone: main is already on the remote, and may have moved since.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;

if (out("git", ["status", "--porcelain"])) throw new Error("Commit or discard your changes first.");
if (out("git", ["branch", "--show-current"]) !== "main") throw new Error("Release from main.");
if (out("git", ["tag", "--list", tag])) throw new Error(`${tag} exists; bump the version.`);

run("pnpm", ["ready"]);
run("git", ["checkout", "--quiet", "--detach"]);
try {
  run("git", ["add", "--force", "dist"]);
  run("git", ["commit", "--quiet", "-m", `Release ${tag}`]);
  run("git", ["tag", tag]);
} finally {
  run("git", ["checkout", "--quiet", "main"]);
}
run("git", ["push", "origin", ...(process.env.CI ? [] : ["main"]), tag]);
console.log(`Released ${tag}`);
