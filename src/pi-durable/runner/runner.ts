// Runs inside the sandbox: one pi-durable conversation answering one prompt.
// It reads the same environment as the pi runner (../../pi/runner/runner.ts)
// and writes the same run events, so a project switches runtime by switching
// the command its image runs.
//
// What differs is the session. pi-durable commits every step to a SQLite file
// in the workspace's .sessions, where `executeRun` saves and restores a
// thread's session. The prompt goes in with RUN_ID as its request id, so a
// later attempt of the same run (after a pause, or a release on shutdown)
// finds the run it started and carries it on from its last checkpoint instead
// of asking the model again from the top. A different RUN_ID on the same
// session is the thread's next message.
//
// Experimental, as pi-durable is: its API changes between releases.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineExtension,
  type EntryId,
  type EntryRecord,
  Harness,
  LiveDoc,
  type LiveState,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

import type { EmitRunEvent } from "../../contract/events.ts";
import { dataPromptSection } from "../../data/commands.ts";
import { loadDataCommands } from "../../pi/runner/data.ts";
import { createEmitter } from "../../pi/runner/events.ts";
import { registerModel, resolveModelConfig } from "../../pi/runner/model-config.ts";
import { ConversationEvents } from "./events.ts";

export const DURABLE_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;
export type DurableBuiltinTool = (typeof DURABLE_BUILTIN_TOOLS)[number];

const BUILTINS: Record<DurableBuiltinTool, () => ToolRegistration> = {
  read: () => createReadTool() as ToolRegistration,
  bash: () => createBashTool() as ToolRegistration,
  edit: () => createEditTool() as ToolRegistration,
  write: () => createWriteTool() as ToolRegistration,
};

/** Where the agent works, handed to the project's prompt, tools and check. */
export type DurableRunnerContext = {
  workspace: string;
  /** Files the user should see go here, registered with `save_output`. */
  outputsDir: string;
  emit: EmitRunEvent;
  env: NodeJS.ProcessEnv;
};

export type DurableRunnerOptions = {
  systemPrompt: (ctx: DurableRunnerContext) => string;
  /** The project's own tools, as pi-durable tools; each is enabled alongside `builtinTools`. */
  customTools?: (ctx: DurableRunnerContext) => ToolRegistration[];
  /** pi-durable's built-in tools to enable. Default: all of `DURABLE_BUILTIN_TOOLS`. */
  builtinTools?: readonly DurableBuiltinTool[];
  /** Used when LLM_PROVIDER and LLM_MODEL are not set (and LLM_API is not). */
  defaultModel: { provider: string; model: string };
  /** Extra `--check` probes; what it returns is added to the check notice. */
  check?: (ctx: DurableRunnerContext) => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** For the data command list; defaults to the global fetch. */
  fetch?: typeof fetch;
};

/** The limits the dispatcher gave this run, echoed back for the trace view. */
function runLimits(env: NodeJS.ProcessEnv): unknown {
  if (!env.RUN_LIMITS) return null;
  try {
    return JSON.parse(env.RUN_LIMITS);
  } catch {
    return null;
  }
}

async function run(options: DurableRunnerOptions, emit: EmitRunEvent): Promise<void> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const workspace = env.WORKSPACE ?? "/workspace";
  const outputsDir = path.join(workspace, "outputs");
  const agentDir = path.join(workspace, ".pi");
  const sessionFile = path.join(workspace, ".sessions", "durable.sqlite");
  const modelConfig = resolveModelConfig(env, options.defaultModel);
  const { provider: providerId, model: modelId } = modelConfig;
  const thinkingLevel = (env.THINKING_LEVEL ?? "high") as "low" | "medium" | "high";
  const ctx: DurableRunnerContext = { workspace, outputsDir, emit, env };
  const context = BACKGROUND_CONTEXT;

  await mkdir(outputsDir, { recursive: true });
  // pi's model runtime is a pi-ai Models, so model handling is the pi
  // runner's: no models.json, a custom provider for LLM_API, the run token.
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
  });
  registerModel(modelRuntime, modelConfig);
  const catalogModel = modelRuntime.getModel(providerId, modelId);

  if (argv.includes("--check")) {
    emit("notice", {
      kind: "check",
      runtime: "pi-durable",
      node: process.version,
      model: catalogModel ? `${catalogModel.provider}/${catalogModel.id}` : null,
      ...(modelConfig.kind === "custom"
        ? {
            api: modelConfig.api,
            baseUrl: modelConfig.baseUrl,
            contextWindow: modelConfig.contextWindow,
            maxTokens: modelConfig.maxTokens,
          }
        : {}),
      ...(await options.check?.(ctx)),
    });
    if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
    return;
  }

  const prompt = env.PROMPT;
  if (!prompt) throw new Error("PROMPT is required");
  if (!env.RUN_ID)
    throw new Error("RUN_ID is required: it keeps a later attempt from asking twice");
  if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
  if (env.LLM_API_KEY) await modelRuntime.setRuntimeApiKey(providerId, env.LLM_API_KEY);
  // A custom model already carries its base URL; a catalog one is pointed at
  // the gateway through its provider.
  if (modelConfig.kind === "catalog" && env.LLM_BASE_URL) {
    modelRuntime.registerProvider(providerId, { baseUrl: env.LLM_BASE_URL });
  }

  const data = await loadDataCommands(env, options.fetch);
  // The bash tool runs commands with this environment, so the CLI finds these there.
  const shellEnv = data
    ? { ...process.env, AGENT_DATA_URL: data.url, AGENT_DATA_TOKEN: data.token }
    : process.env;
  const systemPrompt = [options.systemPrompt(ctx), data ? dataPromptSection(data.list) : ""]
    .filter(Boolean)
    .join("\n\n");

  const tools = [
    ...(options.builtinTools ?? DURABLE_BUILTIN_TOOLS).map((name) => BUILTINS[name]()),
    ...(options.customTools?.(ctx) ?? []),
  ];
  const names = tools.map((tool) => tool.name);
  const clash = names.find((name, i) => names.indexOf(name) !== i);
  if (clash) throw new Error(`Two tools are named ${clash}`);
  // Only what this extension brings: pi-durable discovers nothing from the
  // image or the workspace, so no file there can change the instructions.
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "runner",
      tools,
      sections: [section("preamble", () => systemPrompt, { tag: false })],
    }),
  );

  await mkdir(path.dirname(sessionFile), { recursive: true });
  const harness = await Harness.open(
    await openNodeSqliteStorage(sessionFile),
    {
      models: modelRuntime,
      registry,
      identity: { attribution: null },
      env: () => new NodeExecutionEnv({ cwd: workspace, shellEnv }),
      settings: { compaction: { enabled: true }, retry: { maxRetries: 2 } },
      onReport: (report) => console.error(`pi-durable ${report.kind}: ${String(report.error)}`),
    },
    context,
  );
  // SIGTERM is how a sandbox is stopped. Closing first lets pi-durable store
  // what is pending and resend an interrupted model request next attempt,
  // where a crash would count it as a failed attempt.
  const onTerm = () => {
    void harness.close(context).finally(() => process.exit(143));
  };
  process.once("SIGTERM", onTerm);

  try {
    const agent = {
      model: { provider: providerId, modelId },
      thinkingLevel,
      cwd: workspace,
    } as const;
    const root = await harness.root(context, { agent });
    await root.configure(agent, context); // a thread's next run may use another model

    const events = new ConversationEvents(emit);
    const live = () =>
      harness.snapshot(LiveDoc, root.id, context) as Promise<LiveState | undefined>;
    // What this process reports starts at what is committed now; a previous
    // attempt reported what came before.
    const newest = await root.entries({ order: "descending" }, 1, undefined, context);
    let last: EntryId | undefined = newest.items[0]?.id;
    events.seen(await live());

    // One catch-up at a time, read from storage, so a change is reported once
    // whichever call sees it.
    let syncing = Promise.resolve();
    const sync = () => {
      syncing = syncing.then(async () => {
        const added: EntryRecord[] = [];
        let cursor;
        do {
          const page = await root.entries(
            { minEntryId: last, order: "ascending" },
            200,
            cursor,
            context,
          );
          added.push(...page.items.filter((entry) => entry.id !== last));
          cursor = page.next;
        } while (cursor !== undefined);
        if (added.length > 0) last = added.at(-1)!.id;
        events.entries(added);
        events.live(await live());
      });
      return syncing;
    };

    const watch = await root.watch(context, { min: 1 });
    watch.start(async (call) => {
      if (call.kind === "value") await sync();
    });

    emit("run_started", {
      runId: env.RUN_ID,
      runtime: "pi-durable",
      model: `${catalogModel.provider}/${catalogModel.id}`,
      sessionFile,
      limits: runLimits(env),
      dataCommands: data?.list.commands.map((command) => command.name) ?? [],
    });
    const submission = await root.submit(
      { type: "input", content: prompt, requestId: env.RUN_ID },
      context,
    );
    harness.resume();
    const settled = await submission.wait(context);
    await watch.stop();
    await sync();

    const failure = (await live())?.runFailure;
    const error =
      settled.status === "done"
        ? undefined
        : [settled.reason ?? failure?.reason ?? "unanswered", failure?.detail]
            .filter(Boolean)
            .join(": ");
    emit("run_finished", { status: error ? "failed" : "succeeded", error, sessionFile });
  } finally {
    process.off("SIGTERM", onTerm);
    await harness.close(context);
  }
}

/** The runner's whole `main`: a failure becomes a `run_finished` event and exit code 1. */
export async function runDurableAgent(options: DurableRunnerOptions): Promise<void> {
  const emit = createEmitter();
  try {
    await run(options, emit);
  } catch (error: unknown) {
    emit("run_finished", {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
