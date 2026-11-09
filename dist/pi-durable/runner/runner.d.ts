import { type ToolRegistration } from "@earendil-works/pi-durable";
import type { EmitRunEvent } from "../../contract/events.ts";
export declare const DURABLE_BUILTIN_TOOLS: readonly ["read", "bash", "edit", "write"];
export type DurableBuiltinTool = (typeof DURABLE_BUILTIN_TOOLS)[number];
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
    defaultModel: {
        provider: string;
        model: string;
    };
    /** Extra `--check` probes; what it returns is added to the check notice. */
    check?: (ctx: DurableRunnerContext) => Promise<Record<string, unknown>>;
    env?: NodeJS.ProcessEnv;
    argv?: readonly string[];
    /** For the data command list; defaults to the global fetch. */
    fetch?: typeof fetch;
};
/** The runner's whole `main`: a failure becomes a `run_finished` event and exit code 1. */
export declare function runDurableAgent(options: DurableRunnerOptions): Promise<void>;
