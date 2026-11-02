import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DataCommandList } from "../../data/commands.ts";
import type { RunnerData } from "./data.ts";
/** The tool name a command is offered as: `thread-history` is `thread_history`. */
export declare function dataToolName(command: string): string;
/** One typed tool per data command the gateway serves. */
export declare function createDataTools(data: RunnerData, fetchImpl?: typeof fetch): ToolDefinition[];
/** The system prompt's section on the data tools; empty when there are none. */
export declare function dataToolsPromptSection(list: DataCommandList): string;
