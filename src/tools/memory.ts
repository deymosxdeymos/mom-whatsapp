import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { appendMemoryBullet, getMemoryNotePath, getScopePath } from "../workspace-files.js";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_READ_LINES = 40;
const MAX_RESULTS = 10;
const SNIPPET_CONTEXT_LINES = 2;
const MAX_SNIPPET_CHARS = 500;

const memorySearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what memory you're recalling and why (shown to user)" }),
	query: Type.String({ description: "Search query for memory recall" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
});

const memoryGetSchema = Type.Object({
	label: Type.String({ description: "Brief description of what memory note you're opening and why (shown to user)" }),
	path: Type.String({ description: "Memory file path returned by memory_search" }),
	from: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
	lines: Type.Optional(Type.Number({ description: "Number of lines to read" })),
});

const memoryWriteSchema = Type.Object({
	label: Type.String({ description: "Brief description of what fact or preference you're saving (shown to user)" }),
	text: Type.String({ description: "The memory to persist for this chat" }),
	note: Type.Optional(
		Type.String({
			description: "Optional note name. If set, appends to channel memory/<note>.md instead of channel MEMORY.md",
		}),
	),
});

type MemoryFile = {
	hostPath: string;
	visiblePath: string;
};

type SearchResult = {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
};

export function createMemorySearchTool(params: {
	workspaceHostPath: string;
	workspacePath: string;
	channelId: string;
}): AgentTool<typeof memorySearchSchema> {
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search workspace and channel memory files (`MEMORY.md` and `memory/*.md`) for prior facts, preferences, running jokes, and context before answering questions about earlier conversations.",
		parameters: memorySearchSchema,
		execute: async (_toolCallId: string, args: { label: string; query: string; maxResults?: number }) => {
			const query = args.query.trim();
			if (!query) {
				throw new Error("Query is required");
			}

			const files = collectMemoryFiles(params);
			const results = searchMemoryFiles(files, query, args.maxResults);
			const text =
				results.length === 0
					? "No memory matches found."
					: results
							.map(
								(result, index) =>
									`${index + 1}. ${result.path}#L${result.startLine}${result.endLine > result.startLine ? `-L${result.endLine}` : ""}\n${result.snippet}`,
							)
							.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { results },
			};
		},
	};
}

export function createMemoryGetTool(params: {
	workspaceHostPath: string;
	workspacePath: string;
	channelId: string;
}): AgentTool<typeof memoryGetSchema> {
	return {
		name: "memory_get",
		label: "memory_get",
		description:
			"Read a specific memory file returned by memory_search. Use this after searching so you only load the exact memory note you need.",
		parameters: memoryGetSchema,
		execute: async (
			_toolCallId: string,
			args: { label: string; path: string; from?: number; lines?: number },
		) => {
			const files = collectMemoryFiles(params);
			const file = files.find((entry) => entry.visiblePath === args.path);
			if (!file) {
				throw new Error(`Memory path not found: ${args.path}`);
			}

			const content = readFileSync(file.hostPath, "utf-8");
			const allLines = splitFileLines(content);
			const startLine = Math.max(1, args.from ?? 1);
			const lineCount = Math.max(1, Math.min(args.lines ?? DEFAULT_READ_LINES, 200));

			if (startLine > allLines.length && allLines.length > 0) {
				throw new Error(`Start line ${startLine} is beyond end of file (${allLines.length} lines)`);
			}

			const slice = allLines.slice(startLine - 1, startLine - 1 + lineCount);
			const endLine = startLine + Math.max(0, slice.length - 1);
			const text = slice.join("\n");
			const suffix =
				endLine < allLines.length ? `\n\n[More lines available. Use from=${endLine + 1} to continue]` : "";

			return {
				content: [{ type: "text", text: text + suffix }],
				details: { path: file.visiblePath, startLine, endLine },
			};
		},
	};
}

export function createMemoryWriteTool(params: {
	workspaceHostPath: string;
	workspacePath: string;
	channelId: string;
}): AgentTool<typeof memoryWriteSchema> {
	return {
		name: "memory_write",
		label: "memory_write",
		description:
			"Persist an explicit remember request for this chat. Save stable facts to channel MEMORY.md, or append to a channel memory note when note is provided.",
		parameters: memoryWriteSchema,
		execute: async (_toolCallId: string, args: { label: string; text: string; note?: string }) => {
			const text = args.text.trim();
			if (!text) {
				throw new Error("Memory text is required");
			}

			const hostPath = args.note
				? getMemoryNotePath({
						workingDir: params.workspaceHostPath,
						channelId: params.channelId,
						scope: "channel",
						noteName: args.note,
					})
				: getScopePath({
						workingDir: params.workspaceHostPath,
						channelId: params.channelId,
						scope: "channel",
						kind: "memory",
					});
			await appendMemoryBullet(hostPath, text);
			const visiblePath = toVisiblePath(params.workspaceHostPath, params.workspacePath, hostPath);

			return {
				content: [{ type: "text", text: `Saved memory to ${visiblePath}` }],
				details: { path: visiblePath },
			};
		},
	};
}

function collectMemoryFiles(params: {
	workspaceHostPath: string;
	workspacePath: string;
	channelId: string;
}): MemoryFile[] {
	const channelHostPath = join(params.workspaceHostPath, params.channelId);
	const candidates = [
		join(params.workspaceHostPath, "MEMORY.md"),
		...listMarkdownFiles(join(params.workspaceHostPath, "memory")),
		join(channelHostPath, "MEMORY.md"),
		...listMarkdownFiles(join(channelHostPath, "memory")),
	];

	return candidates
		.filter((hostPath, index, all) => fileExists(hostPath) && all.indexOf(hostPath) === index)
		.map((hostPath) => ({
			hostPath,
			visiblePath: toVisiblePath(params.workspaceHostPath, params.workspacePath, hostPath),
		}));
}

function listMarkdownFiles(dirPath: string): string[] {
	try {
		return readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => join(dirPath, entry.name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

function fileExists(filePath: string): boolean {
	return existsSync(filePath);
}

function toVisiblePath(workspaceHostPath: string, workspacePath: string, hostPath: string): string {
	const rel = relative(workspaceHostPath, hostPath).replace(/\\/g, "/");
	return `${workspacePath}/${rel}`;
}

function searchMemoryFiles(files: MemoryFile[], query: string, maxResults?: number): SearchResult[] {
	const normalizedLimit = clampMaxResults(maxResults);
	const queryTerms = tokenize(query);
	const queryLower = query.toLowerCase();
	const matches: SearchResult[] = [];

	for (const file of files) {
		const content = readFileSync(file.hostPath, "utf-8");
		const lines = splitFileLines(content);

		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			const score = scoreLine(line, file.visiblePath, queryTerms, queryLower);
			if (score <= 0) {
				continue;
			}

			const startLine = Math.max(1, index + 1 - SNIPPET_CONTEXT_LINES);
			const endLine = Math.min(lines.length, index + 1 + SNIPPET_CONTEXT_LINES);
			const snippet = truncateSnippet(lines.slice(startLine - 1, endLine).join("\n"));
			matches.push({
				path: file.visiblePath,
				startLine,
				endLine,
				score,
				snippet,
			});
		}
	}

	return matches
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine)
		.slice(0, normalizedLimit);
}

function clampMaxResults(value?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_MAX_RESULTS;
	}
	return Math.max(1, Math.min(Math.floor(value), MAX_RESULTS));
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map((part) => part.trim())
		.filter((part) => part.length >= 2);
}

function splitFileLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function scoreLine(line: string, path: string, queryTerms: string[], queryLower: string): number {
	const lineLower = line.toLowerCase();
	let score = 0;

	if (lineLower.includes(queryLower)) {
		score += 10;
	}

	for (const term of queryTerms) {
		if (lineLower.includes(term)) {
			score += 3;
		}
		if (path.toLowerCase().includes(term)) {
			score += 1;
		}
	}

	return score;
}

function truncateSnippet(value: string): string {
	if (value.length <= MAX_SNIPPET_CHARS) {
		return value.trim();
	}
	return `${value.slice(0, MAX_SNIPPET_CHARS - 3).trimEnd()}...`;
}
