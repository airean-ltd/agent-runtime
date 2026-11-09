import type { EmitRunEvent } from "../../contract/events.ts";
/**
 * pi-durable's `save_output`: the same tool as the pi runtime's, registering a
 * result file with an `artifact` event. It is not replay-safe, so a call a
 * crash cut off is reported to the model as interrupted rather than emitting
 * its artifact twice.
 */
export declare function createDurableSaveOutputTool(opts: {
    outputsDir: string;
    emit: EmitRunEvent;
    kinds: readonly [string, ...string[]];
    description?: string;
}): import("@earendil-works/pi-durable").ToolRegistration<import("@earendil-works/pi-schema").Schema<{
    path: string;
    kind: string;
    caption: string;
}>, import("@earendil-works/chord").JsonValue>;
