import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createAttachTool, type GetUploadFunction } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMomTools(
	executor: Executor,
	getUploadFunction: GetUploadFunction,
	workspaceHostPath: string,
	workspacePath: string,
): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor, { workspaceHostPath, workspacePath }),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(getUploadFunction),
	];
}
