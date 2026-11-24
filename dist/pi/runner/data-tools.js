// The data commands as typed tools, for a project whose agent has no shell
// (runAgent's `dataAccess: "tools"`). Each command becomes one pi tool named
// after it with `_` for `-`, whose parameters are the command's arguments. A
// call goes to the gateway's /data route with the run's token, as the CLI's
// does, and the gateway checks the arguments again.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
/** The tool name a command is offered as: `thread-history` is `thread_history`. */
export function dataToolName(command) {
    return command.replaceAll("-", "_");
}
function argSchema(arg) {
    const options = arg.description ? { description: arg.description } : {};
    const schema = arg.type === "string"
        ? Type.String(options)
        : arg.type === "number"
            ? Type.Number(options)
            : Type.Boolean(options);
    return arg.required && arg.default === undefined ? schema : Type.Optional(schema);
}
function errorOf(body, status) {
    const error = body?.error;
    return typeof error === "string" ? error : `the gateway answered ${status}`;
}
function dataTool(command, data, fetchImpl) {
    return defineTool({
        name: dataToolName(command.name),
        label: command.name,
        description: command.description,
        parameters: Type.Object(Object.fromEntries(command.args.map((arg) => [arg.name, argSchema(arg)]))),
        execute: async (_toolCallId, params) => {
            const args = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
            const res = await fetchImpl(`${data.url}/data/${encodeURIComponent(command.name)}`, {
                method: "POST",
                headers: { authorization: `Bearer ${data.token}`, "content-type": "application/json" },
                body: JSON.stringify(args),
            });
            const text = await res.text();
            let body;
            try {
                body = text ? JSON.parse(text) : null;
            }
            catch {
                body = { error: text || res.statusText };
            }
            // Thrown, pi shows the agent the message as the tool's error.
            if (!res.ok)
                throw new Error(errorOf(body, res.status));
            return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], details: {} };
        },
    });
}
/** One typed tool per data command the gateway serves. */
export function createDataTools(data, fetchImpl = fetch) {
    return data.list.commands.map((command) => dataTool(command, data, fetchImpl));
}
/** The system prompt's section on the data tools; empty when there are none. */
export function dataToolsPromptSection(list) {
    if (list.commands.length === 0)
        return "";
    return [
        "## Live data",
        "",
        "Besides your files, these tools read live data for this conversation. Each returns JSON.",
        "",
        ...list.commands.map((command) => `- \`${dataToolName(command.name)}\`: ${command.description}`),
    ].join("\n");
}
