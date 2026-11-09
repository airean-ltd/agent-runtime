import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { saveOutput } from "../../pi/runner/save-output.js";
/**
 * pi-durable's `save_output`: the same tool as the pi runtime's, registering a
 * result file with an `artifact` event. It is not replay-safe, so a call a
 * crash cut off is reported to the model as interrupted rather than emitting
 * its artifact twice.
 */
export function createDurableSaveOutputTool(opts) {
    const { outputsDir, emit } = opts;
    return defineTool({
        name: "save_output",
        description: opts.description ??
            `Register a file you wrote under ${outputsDir} as a result for the user.`,
        parameters: obj({
            path: str({ description: `Path of the file, inside ${outputsDir}` }),
            kind: oneOf(opts.kinds),
            caption: str({ description: "One sentence describing what the file shows" }),
        }),
        execute: async (args) => ({
            output: [{ type: "text", text: await saveOutput(outputsDir, emit, args) }],
        }),
    });
}
