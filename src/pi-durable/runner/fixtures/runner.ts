// A minimal durable runner for tests: runDurableAgent with save_output and
// bash. Its environment picks the model.
import { createDurableSaveOutputTool, runDurableAgent } from "../index.ts";

await runDurableAgent({
  defaultModel: { provider: "kimi-coding", model: "kimi-for-coding" },
  systemPrompt: () => "You are a test agent.",
  builtinTools: ["bash"],
  customTools: ({ outputsDir, emit }) => [createDurableSaveOutputTool({ outputsDir, emit, kinds: ["table", "chart"] })],
});
