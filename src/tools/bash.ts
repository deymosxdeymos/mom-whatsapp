import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate unique output file paths for bash output.
 */
function getOutputFilePaths(
	workspaceHostPath: string,
	workspacePath: string,
): { hostPath: string; visiblePath: string } {
	const id = randomBytes(8).toString("hex");
	const fileName = `mom-bash-${id}.log`;
	const hostDir = join(workspaceHostPath, ".mom-whatsapp", "bash-output");
	mkdirSync(hostDir, { recursive: true });

	return {
		hostPath: join(hostDir, fileName),
		visiblePath:
			workspacePath === workspaceHostPath
				? join(hostDir, fileName)
				: `${workspacePath}/.mom-whatsapp/bash-output/${fileName}`,
	};
}

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(
	executor: Executor,
	paths: { workspaceHostPath: string; workspacePath: string },
): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a workspace file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			let fullOutputPath: string | undefined;

			const result = await executor.exec(command, { timeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			// Apply tail truncation
			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";
			if (truncation.truncated) {
				try {
					const outputPaths = getOutputFilePaths(paths.workspaceHostPath, paths.workspacePath);
					writeFileSync(outputPaths.hostPath, output, "utf-8");
					fullOutputPath = outputPaths.visiblePath;
				} catch {
					fullOutputPath = undefined;
				}
			}

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath,
				};
				const fullOutputSuffix = fullOutputPath
					? ` Full output: ${fullOutputPath}`
					: " Full output could not be persisted.";

				// Build actionable notice
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${fullOutputSuffix}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputSuffix}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputSuffix}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
