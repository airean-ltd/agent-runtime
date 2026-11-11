// The pi-durable adapter for the shared run contract. pi-durable has no event
// stream: a conversation is committed state, watched as it changes. This turns
// what each change adds (transcript entries, the streamed answer, retries and
// compactions in `pi.live`) into the same run_events shapes the pi runner
// emits, so the dispatcher and the web app cannot tell the two apart.

import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";

import { truncate } from "../../contract/events.ts";
import type { EmitRunEvent } from "../../contract/events.ts";

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
type ModelMessage = {
  role?: unknown;
  content?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
};

function blocks(message: ModelMessage | undefined): Block[] {
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
}

/** The text blocks of a message, joined; tool calls and thinking are left out. */
function textOf(message: ModelMessage | undefined): string {
  return blocks(message)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("");
}

/**
 * Emits each change to one conversation once. `seen` marks what a previous
 * process already reported, so a resumed run starts its log where the
 * committed state is, not from the beginning of the transcript.
 */
export class ConversationEvents {
  /** The answer text emitted so far for the generation now streaming. */
  private streamed = "";
  private retrying = false;
  private readonly compactions = new Set<unknown>();
  private readonly emit: EmitRunEvent;

  constructor(emit: EmitRunEvent) {
    this.emit = emit;
  }

  /** Takes the state a watch attached at as already reported. */
  seen(live: LiveState | undefined): void {
    this.streamed = textOf(live?.generation?.message as ModelMessage | undefined);
    this.retrying = live?.generation?.retry !== undefined;
    for (const status of live?.compactions ?? []) this.compactions.add(status.taskId);
  }

  /** Entries committed since the last call, oldest first. */
  entries(entries: readonly EntryRecord[]): void {
    for (const entry of entries) {
      const message = entry.model?.[0] as ModelMessage | undefined;
      if (message?.role === "assistant") this.assistant(message);
      else if (message?.role === "toolResult") this.toolResult(message);
    }
  }

  /** The conversation's `pi.live` after the entries of the same change. */
  live(live: LiveState | undefined): void {
    const text = textOf(live?.generation?.message as ModelMessage | undefined);
    // A retry starts the answer over; what it streams is new text.
    if (!text.startsWith(this.streamed)) this.streamed = "";
    this.flush(text);

    const retrying = live?.generation?.retry !== undefined;
    if (retrying && !this.retrying) this.emit("notice", { kind: "auto_retry_start" });
    this.retrying = retrying;

    const running = new Set<unknown>((live?.compactions ?? []).map((status) => status.taskId));
    for (const id of running) {
      if (!this.compactions.has(id)) this.emit("notice", { kind: "compaction_start" });
    }
    this.compactions.clear();
    for (const id of running) this.compactions.add(id);
  }

  private flush(text: string): void {
    if (text.length > this.streamed.length && text.startsWith(this.streamed)) {
      this.emit("text_delta", { delta: text.slice(this.streamed.length) });
      this.streamed = text;
    }
  }

  private assistant(message: ModelMessage): void {
    // Commits of the streamed answer are throttled, so its tail may arrive
    // only with the entry.
    const text = textOf(message);
    if (!text.startsWith(this.streamed)) this.streamed = "";
    this.flush(text);
    this.streamed = "";
    this.emit("turn_end", {
      usage: message.usage,
      stopReason: message.stopReason,
      error: message.errorMessage,
    });
    // The entry carries each call's arguments; the live tool slots do not.
    for (const block of blocks(message)) {
      if (block.type !== "toolCall") continue;
      this.emit("tool_start", {
        toolCallId: block.id,
        toolName: block.name,
        args: truncate(block.arguments),
      });
    }
  }

  private toolResult(message: ModelMessage): void {
    const text = textOf(message);
    this.emit("tool_end", {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError === true,
      result: text === "" ? undefined : truncate(text),
    });
  }
}
