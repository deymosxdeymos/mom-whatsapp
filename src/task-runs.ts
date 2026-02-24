import { existsSync } from "fs";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

export type TaskRunStatus = "success" | "error";

export interface TaskRunRecord {
	taskId: string;
	filename: string;
	channelId: string;
	eventType: "immediate" | "one-shot" | "periodic";
	runAtIso: string;
	durationMs: number;
	status: TaskRunStatus;
	error?: string;
}

export interface TaskRunSummary {
	runCount: number;
	lastRunAtIso: string | null;
	lastStatus: TaskRunStatus | null;
	lastError: string | null;
}

const TASK_RUNS_FILENAME = "task-runs.jsonl";
const MAX_HISTORY_LINES = 5000;
const writeQueueByPath: Map<string, Promise<void>> = new Map();

export function getTaskRunsPath(workspaceDir: string): string {
	return join(workspaceDir, TASK_RUNS_FILENAME);
}

export async function appendTaskRunRecord(workspaceDir: string, record: TaskRunRecord): Promise<void> {
	const path = getTaskRunsPath(workspaceDir);
	return enqueueWrite(path, async () => {
		await mkdir(workspaceDir, { recursive: true });
		const line = JSON.stringify(record);
		await appendFile(path, `${line}\n`, "utf-8");
		await trimHistory(path);
	});
}

export async function readTaskRunRecords(workspaceDir: string, channelId: string): Promise<TaskRunRecord[]> {
	const path = getTaskRunsPath(workspaceDir);
	if (!existsSync(path)) {
		return [];
	}

	let content: string;
	try {
		content = await readFile(path, "utf-8");
	} catch {
		return [];
	}

	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const recentLines = lines.slice(-MAX_HISTORY_LINES);

	const records: TaskRunRecord[] = [];
	for (const line of recentLines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		const record = parseTaskRunRecord(parsed);
		if (!record || record.channelId !== channelId) {
			continue;
		}
		records.push(record);
	}

	return records;
}

export async function summarizeTaskRunsByTaskId(
	workspaceDir: string,
	channelId: string,
): Promise<Map<string, TaskRunSummary>> {
	const records = await readTaskRunRecords(workspaceDir, channelId);
	const summary = new Map<string, TaskRunSummary>();

	for (const record of records) {
		const current =
			summary.get(record.taskId) || {
				runCount: 0,
				lastRunAtIso: null,
				lastStatus: null,
				lastError: null,
			};

		current.runCount += 1;
		const currentTs = current.lastRunAtIso ? new Date(current.lastRunAtIso).getTime() : Number.NEGATIVE_INFINITY;
		const recordTs = new Date(record.runAtIso).getTime();
		if (!Number.isFinite(currentTs) || recordTs >= currentTs) {
			current.lastRunAtIso = record.runAtIso;
			current.lastStatus = record.status;
			current.lastError = record.status === "error" ? record.error || "unknown error" : null;
		}

		summary.set(record.taskId, current);
	}

	return summary;
}

function parseTaskRunRecord(value: unknown): TaskRunRecord | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const data = value as Record<string, unknown>;
	const taskId = typeof data.taskId === "string" ? data.taskId : null;
	const filename = typeof data.filename === "string" ? data.filename : null;
	const channelId = typeof data.channelId === "string" ? data.channelId : null;
	const eventType =
		data.eventType === "immediate" || data.eventType === "one-shot" || data.eventType === "periodic"
			? data.eventType
			: null;
	const runAtIso = typeof data.runAtIso === "string" ? data.runAtIso : null;
	const durationMs = typeof data.durationMs === "number" ? data.durationMs : null;
	const status = data.status === "success" || data.status === "error" ? data.status : null;
	const error = typeof data.error === "string" ? data.error : undefined;

	if (!taskId || !filename || !channelId || !eventType || !runAtIso || durationMs === null || !status) {
		return null;
	}

	return {
		taskId,
		filename,
		channelId,
		eventType,
		runAtIso,
		durationMs,
		status,
		error,
	};
}

function enqueueWrite(path: string, op: () => Promise<void>): Promise<void> {
	const previous = writeQueueByPath.get(path) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(op);
	writeQueueByPath.set(path, next);
	return next.finally(() => {
		if (writeQueueByPath.get(path) === next) {
			writeQueueByPath.delete(path);
		}
	});
}

async function trimHistory(path: string): Promise<void> {
	let content: string;
	try {
		content = await readFile(path, "utf-8");
	} catch {
		return;
	}

	const lines = content
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (lines.length <= MAX_HISTORY_LINES) {
		return;
	}

	const tail = lines.slice(-MAX_HISTORY_LINES);
	await writeFile(path, `${tail.join("\n")}\n`, "utf-8");
}
