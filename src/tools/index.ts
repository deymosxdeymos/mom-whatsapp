import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createAttachTool, type GetUploadFunction } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createMemoryGetTool, createMemorySearchTool, createMemoryWriteTool } from "./memory.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMomTools(
	executor: Executor,
	getUploadFunction: GetUploadFunction,
	workspaceHostPath: string,
	workspacePath: string,
	channelId: string,
): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createMemorySearchTool({ workspaceHostPath, workspacePath, channelId }),
		createMemoryGetTool({ workspaceHostPath, workspacePath, channelId }),
		createMemoryWriteTool({ workspaceHostPath, workspacePath, channelId }),
		createBashTool(executor, { workspaceHostPath, workspacePath }),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(getUploadFunction),
	];
}
