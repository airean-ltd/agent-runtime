import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { EmitRunEvent } from "../../contract/events.ts";
/**
 * Emits each change to one conversation once. `seen` marks what a previous
 * process already reported, so a resumed run starts its log where the
 * committed state is, not from the beginning of the transcript.
 */
export declare class ConversationEvents {
    /** The answer text emitted so far for the generation now streaming. */
    private streamed;
    private retrying;
    private readonly compactions;
    private readonly emit;
    constructor(emit: EmitRunEvent);
    /** Takes the state a watch attached at as already reported. */
    seen(live: LiveState | undefined): void;
    /** Entries committed since the last call, oldest first. */
    entries(entries: readonly EntryRecord[]): void;
    /** The conversation's `pi.live` after the entries of the same change. */
    live(live: LiveState | undefined): void;
    private flush;
    private assistant;
    private toolResult;
}
