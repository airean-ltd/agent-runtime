import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../contract/events.ts";
import { createInProcessGateway, type InProcessGateway } from "../../core/gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "../../testing/fake-upstream.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/runner.ts");

type Reply = { text: string } | { call: { name: string; args: Record<string, unknown> } };
type Message = { role: string; content?: unknown; tool_call_id?: string };

/**
 * A Chat Completions endpoint that answers request n with `replies[n]`, then
 * with "Done.", recording each request's messages.
 */
async function startScriptedModel(replies: Reply[]) {
  const requests: Message[][] = [];
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d));
    req.on("end", () => {
      const n = requests.push((JSON.parse(body) as { messages: Message[] }).messages) - 1;
      const reply = replies[n] ?? { text: "Done." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if ("text" in reply) {
        res.write(chunk({ role: "assistant", content: reply.text }));
        res.write(chunk({}, "stop"));
      } else {
        const call = { index: 0, id: `call_${n}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } };
        res.write(chunk({ role: "assistant", tool_calls: [call] }));
        res.write(chunk({}, "tool_calls"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs the fixture in `workspace`; `stop` sends its signal once its file exists there. */
async function runRunner(
  workspace: string,
  env: Record<string, string>,
  stop?: { file: string; signal: NodeJS.Signals },
): Promise<{ code: number | null; events: RunEvent[] }> {
  const child = spawn(process.execPath, [fixture], {
    env: { PATH: process.env.PATH ?? "", HOME: workspace, PI_OFFLINE: "1", WORKSPACE: workspace, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  // A file the tool writes, since an event comes before the call's intent is stored.
  const poll = stop && setInterval(() => existsSync(path.join(workspace, stop.file)) && child.kill(stop.signal), 20);
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearInterval(poll);
  const events = out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return { code, events };
}

const userMessages = (messages: Message[]) => messages.filter((m) => m.role === "user");

describe("runDurableAgent", { timeout: 60_000 }, () => {
  let model: Awaited<ReturnType<typeof startScriptedModel>> | undefined;
  let upstream: FakeUpstream | undefined;
  let gateway: InProcessGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    await model?.close();
    await upstream?.close();
    gateway = model = upstream = undefined;
  });

  async function openaiThroughGateway(replies: Reply[]) {
    model = await startScriptedModel(replies);
    gateway = createInProcessGateway({ format: "openai", baseUrl: model.baseUrl, apiKey: "sk-provider", log: () => {} });
    const url = await gateway.listen();
    return { LLM_API: "openai", LLM_MODEL: "m", LLM_BASE_URL: url, LLM_API_KEY: await gateway.grant("run_1", 60_000) };
  }

  it("runs tools and writes the pi runner's events", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "durable-ws-"));
    await mkdir(path.join(workspace, "outputs"));
    await writeFile(path.join(workspace, "outputs/chart.png"), "png");
    const env = await openaiThroughGateway([
      { call: { name: "save_output", args: { path: "chart.png", kind: "chart", caption: "A chart" } } },
      { call: { name: "save_output", args: { path: "chart.png", kind: "nope", caption: "Bad kind" } } },
      { text: "Saved the chart." },
    ]);

    const { code, events } = await runRunner(workspace, { ...env, RUN_ID: "run_1", PROMPT: "Chart it." });

    expect(code).toBe(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(events.at(-1)!.payload).toMatchObject({ status: "succeeded" });
    expect(events.find((e) => e.type === "artifact")!.payload).toMatchObject({ kind: "chart", caption: "A chart", size: 3 });
    const ends = events.filter((e) => e.type === "tool_end").map((e) => e.payload);
    expect(ends).toMatchObject([
      { toolCallId: "call_0", toolName: "save_output", isError: false },
      { toolCallId: "call_1", toolName: "save_output", isError: true },
    ]);
    expect(String(ends[1]!.result)).toContain("kind");
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(3);
    const text = events.flatMap((e) => (e.type === "text_delta" ? [String(e.payload.delta)] : [])).join("");
    expect(text).toBe("Saved the chart.");
  });

  it.each([
    ["stopped", "SIGTERM", 143],
    ["killed", "SIGKILL", null],
  ] as const)("carries a %s run on in its next attempt without asking again, and takes a new run as the next message", async (_, signal, exitCode) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "durable-ws-"));
    const env = await openaiThroughGateway([
      { call: { name: "bash", args: { command: "touch started && sleep 30" } } },
      { text: "Gave up on sleeping." },
      { text: "Second answer." },
    ]);

    // The first attempt ends while its tool runs: stopped, as a sandbox is, or killed.
    const first = await runRunner(workspace, { ...env, RUN_ID: "run_1", PROMPT: "Sleep." }, { file: "started", signal });
    expect(first.code).toBe(exitCode);
    expect(first.events.some((e) => e.type === "run_finished")).toBe(false);
    expect(model!.requests).toHaveLength(1);

    // The next attempt of the same run reports only what is new.
    const second = await runRunner(workspace, { ...env, RUN_ID: "run_1", PROMPT: "Sleep." });
    expect(second.code).toBe(0);
    expect(second.events.at(-1)!.payload).toMatchObject({ status: "succeeded" });
    expect(second.events.some((e) => e.type === "tool_start")).toBe(false);
    expect(second.events.find((e) => e.type === "tool_end")!.payload).toMatchObject({ toolCallId: "call_0", isError: true });
    expect(model!.requests).toHaveLength(2);
    const resumed = model!.requests[1]!;
    // The prompt went in once, and the interrupted call came back to the model.
    expect(userMessages(resumed)).toHaveLength(1);
    expect(resumed.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_0" });

    // Another run on the same session is the thread's next message.
    const third = await runRunner(workspace, { ...env, RUN_ID: "run_2", PROMPT: "Again." });
    expect(third.code).toBe(0);
    expect(model!.requests).toHaveLength(3);
    expect(userMessages(model!.requests[2]!)).toHaveLength(2);
    const text = third.events.flatMap((e) => (e.type === "text_delta" ? [String(e.payload.delta)] : [])).join("");
    expect(text).toBe("Second answer.");
  });

  it("points a catalog model at the gateway", async () => {
    // kimi-coding/kimi-for-coding speaks Chat Completions.
    upstream = await startFakeUpstream({ apiKey: "sk-provider" });
    gateway = createInProcessGateway({ format: "openai", baseUrl: upstream.baseUrl, apiKey: "sk-provider", log: () => {} });
    const url = await gateway.listen();
    const workspace = await mkdtemp(path.join(tmpdir(), "durable-ws-"));

    const { code, events } = await runRunner(workspace, {
      LLM_BASE_URL: `${url}/v1`,
      LLM_API_KEY: await gateway.grant("run_1", 60_000),
      RUN_ID: "run_1",
      PROMPT: "Say hello.",
    });

    expect(code).toBe(0);
    expect(events[0]!.payload).toMatchObject({ runtime: "pi-durable", model: "kimi-coding/kimi-for-coding" });
    expect(events.at(-1)!.payload).toMatchObject({ status: "succeeded" });
    expect(upstream.requests[0]).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: "Bearer sk-provider" } });
  });

  it("refuses a run without a RUN_ID", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "durable-ws-"));
    const { code, events } = await runRunner(workspace, { LLM_API: "openai", LLM_MODEL: "m", LLM_BASE_URL: "http://g", PROMPT: "Hi." });
    expect(code).toBe(1);
    expect(events.at(-1)!.payload).toMatchObject({ status: "failed", error: expect.stringContaining("RUN_ID") });
  });
});
