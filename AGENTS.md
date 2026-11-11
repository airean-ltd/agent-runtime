# Agent Runtime

Runtimes for running coding agents inside a sandbox and streaming what they do as a stable event log. AIREAN's apps depend on it as a package, so a change to an export, an event or an environment variable is a change for them too. The README describes every part and how an app uses it.

## Toolchain

Node 24 and pnpm 12.6.0, with TypeScript only: no bundler, and no lint or format step yet.

Before a PR, run `pnpm ready`: typecheck, tests (`vitest`), then the build. CI runs the same.

## Layout

Each directory under `src/` is one export of the package, imported by its path, such as `@eankhbayar/agent-runtime/core`. The README's first section lists them all.

- `src/contract`, `src/models`, `src/dispatch` and the definitions in `src/data` use no Node APIs, so a web app or Convex can import them. Each has its own `tsconfig.<name>.json` without Node's types, which `pnpm typecheck` runs; keep Node imports out of them.
- `src/pi/runner` and `src/pi-durable/runner` run inside the sandbox. The rest of `src/` runs on the host.
- `src/testing` holds the fakes an app's tests use. Change a fake with the interface it stands in for.
- `gateway/` is the egress gateway's image, `infra/cloud-run/` the scripts that set up dispatch and deploy a job, and `smoke/cloud-run/` a real run against Cloud Run. None of the three runs in CI.
- Tests sit beside their code as `*.test.ts`.

## Releases

A release is a git tag that carries its built `dist/`; `dist/` stays out of `main`. Apps install a tag, such as `github:airean-ltd/agent-runtime#v0.14.0`.

- A PR that changes what the package does bumps `version` in `package.json`, and adds an "Upgrading from" section to the README when an app has to change something.
- `pnpm release` tags `v<version>` from `main` and pushes it. It publishes the package, so a person runs it, or asks for it.

<!-- hq:start -->
## AIREAN HQ

Docs live in HQ. Run `hq sync` before starting; it writes them to `.hq/docs/` (gitignored). This repo is HQ project `AGENT`.

- Team rules: read `.hq/docs/team/` first. They apply to every task.
- Start work with the `start_ticket` tool. It gives you the ticket, its specs, the branch and the checks.
- Need a doc that isn't in `.hq/docs/`? Use `search_docs` / `get_doc`.
- Never edit a doc to keep the change. Send it with `propose_doc_change`.
- Found more work? File it with `propose_ticket`; don't do it in this PR.
<!-- hq:end -->
