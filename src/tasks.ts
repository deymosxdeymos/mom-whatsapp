import { Cron } from "croner";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { MomEvent } from "./events.js";
import {
	readTaskRunRecords,
	summarizeTaskRunsByTaskId,
	type TaskRunRecord,
	type TaskRunStatus,
} from "./task-runs.js";

export type TaskStatus = "active" | "paused";

export interface ScheduledTaskRecord {
	id: string;
	filename: string;
	event: MomEvent;
	status: TaskStatus;
	nextRunIso: string | null;
	runCount: number;
	lastRunAtIso: string | null;
	lastRunStatus: TaskRunStatus | null;
	lastRunError: string | null;
}

export interface TaskHistoryRecord {
	runAtIso: string;
	durationMs: number;
	status: TaskRunStatus;
	error?: string;
}

export interface TaskCreateResult {
	id: string;
	filename: string;
	path: string;
}

export interface PeriodicValidationResult {
	ok: boolean;
	nextRunIso: string | null;
	error?: string;
}

export type TaskMutationResult = { ok: true; filename: string } | { ok: false; error: string };

interface ParsedTaskFile {
	event: MomEvent;
	status: TaskStatus;
}

export function getEventsDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

export function getDefaultTaskTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
		return true;
	} catch {
		return false;
	}
}

export function validatePeriodicSchedule(schedule: string, timezone: string): PeriodicValidationResult {
	try {
		const cron = new Cron(schedule, { timezone }, () => {
			// No-op validation callback.
		});
		const next = cron.nextRun();
		cron.stop();
		return { ok: true, nextRunIso: next ? next.toISOString() : null };
	} catch (err) {
		return {
			ok: false,
			nextRunIso: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function createImmediateTaskEvent(
	workspaceDir: string,
	channelId: string,
	text: string,
): Promise<TaskCreateResult> {
	return createTaskEvent(workspaceDir, {
		type: "immediate",
		channelId,
		text,
	});
}

export async function createOneShotTaskEvent(
	workspaceDir: string,
	channelId: string,
	text: string,
	at: string,
): Promise<TaskCreateResult> {
	return createTaskEvent(workspaceDir, {
		type: "one-shot",
		channelId,
		text,
		at,
	});
}

export async function createPeriodicTaskEvent(
	workspaceDir: string,
	channelId: string,
	text: string,
	schedule: string,
	timezone: string,
): Promise<TaskCreateResult> {
	return createTaskEvent(workspaceDir, {
		type: "periodic",
		channelId,
		text,
		schedule,
		timezone,
	});
}

export async function listScheduledTasks(workspaceDir: string, channelId: string): Promise<ScheduledTaskRecord[]> {
	const eventsDir = getEventsDir(workspaceDir);
	if (!existsSync(eventsDir)) {
		return [];
	}

	const runSummary = await summarizeTaskRunsByTaskId(workspaceDir, channelId);
	const files = (await readdir(eventsDir)).filter((filename) => filename.endsWith(".json")).sort();
	const records: ScheduledTaskRecord[] = [];

	for (const filename of files) {
		const filePath = join(eventsDir, filename);
		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			continue;
		}

		const taskFile = parseTaskFile(parsed);
		if (!taskFile || taskFile.event.channelId !== channelId) {
			continue;
		}

		const taskId = filename.replace(/\.json$/i, "");
		const summary = runSummary.get(taskId);
		records.push({
			id: taskId,
			filename,
			event: taskFile.event,
			status: taskFile.status,
			nextRunIso: taskFile.status === "paused" ? null : getNextRunIso(taskFile.event),
			runCount: summary?.runCount || 0,
			lastRunAtIso: summary?.lastRunAtIso || null,
			lastRunStatus: summary?.lastStatus || null,
			lastRunError: summary?.lastError || null,
		});
	}

	records.sort((a, b) => {
		const aTs = a.nextRunIso ? new Date(a.nextRunIso).getTime() : Number.POSITIVE_INFINITY;
		const bTs = b.nextRunIso ? new Date(b.nextRunIso).getTime() : Number.POSITIVE_INFINITY;
		if (aTs !== bTs) {
			return aTs - bTs;
		}
		return a.filename.localeCompare(b.filename);
	});

	return records;
}

export async function deleteScheduledTask(
	workspaceDir: string,
	channelId: string,
	identifier: string,
): Promise<TaskMutationResult> {
	const resolved = await resolveTaskFileForChannel(workspaceDir, channelId, identifier);
	if (!resolved.ok) {
		return resolved;
	}

	try {
		await unlink(resolved.filePath);
		return { ok: true, filename: resolved.filename };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to delete task: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export async function pauseScheduledTask(
	workspaceDir: string,
	channelId: string,
	identifier: string,
): Promise<TaskMutationResult> {
	return setTaskStatus(workspaceDir, channelId, identifier, "paused");
}

export async function resumeScheduledTask(
	workspaceDir: string,
	channelId: string,
	identifier: string,
): Promise<TaskMutationResult> {
	return setTaskStatus(workspaceDir, channelId, identifier, "active");
}

export async function listTaskHistory(
	workspaceDir: string,
	channelId: string,
	identifier: string,
	limit = 10,
): Promise<{ ok: true; taskId: string; records: TaskHistoryRecord[] } | { ok: false; error: string }> {
	const taskId = normalizeTaskIdentifier(identifier).replace(/\.json$/i, "");
	if (!taskId) {
		return { ok: false, error: "Missing task id." };
	}

	const records = await readTaskRunRecords(workspaceDir, channelId);
	const filtered = records
		.filter((record) => record.taskId === taskId)
		.sort((a, b) => new Date(b.runAtIso).getTime() - new Date(a.runAtIso).getTime())
		.slice(0, Math.max(1, limit))
		.map((record) => ({
			runAtIso: record.runAtIso,
			durationMs: record.durationMs,
			status: record.status,
			error: record.error,
		}));

	return { ok: true, taskId, records: filtered };
}

export async function listTaskFailures(
	workspaceDir: string,
	channelId: string,
	limit = 10,
): Promise<TaskRunRecord[]> {
	const records = await readTaskRunRecords(workspaceDir, channelId);
	return records
		.filter((record) => record.status === "error")
		.sort((a, b) => new Date(b.runAtIso).getTime() - new Date(a.runAtIso).getTime())
		.slice(0, Math.max(1, limit));
}

async function createTaskEvent(workspaceDir: string, event: MomEvent): Promise<TaskCreateResult> {
	const eventsDir = getEventsDir(workspaceDir);
	await mkdir(eventsDir, { recursive: true });

	const filename = buildTaskFilename(event.type);
	const filePath = join(eventsDir, filename);
	await writeFile(filePath, `${JSON.stringify({ ...event, paused: false }, null, 2)}\n`, "utf-8");

	return {
		id: filename.replace(/\.json$/i, ""),
		filename,
		path: filePath,
	};
}

function buildTaskFilename(eventType: MomEvent["type"]): string {
	const random = Math.random().toString(36).slice(2, 8);
	return `task-${eventType}-${Date.now()}-${random}.json`;
}

function normalizeTaskIdentifier(identifier: string): string {
	const trimmed = identifier.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
}

function parseMomEvent(value: unknown): MomEvent | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const data = value as Record<string, unknown>;
	const type = typeof data.type === "string" ? data.type : null;
	const channelId = typeof data.channelId === "string" ? data.channelId : null;
	const text = typeof data.text === "string" ? data.text : null;
	if (!type || !channelId || !text) {
		return null;
	}

	if (type === "immediate") {
		return { type: "immediate", channelId, text };
	}
	if (type === "one-shot") {
		const at = typeof data.at === "string" ? data.at : null;
		if (!at) return null;
		return { type: "one-shot", channelId, text, at };
	}
	if (type === "periodic") {
		const schedule = typeof data.schedule === "string" ? data.schedule : null;
		const timezone = typeof data.timezone === "string" ? data.timezone : null;
		if (!schedule || !timezone) return null;
		return { type: "periodic", channelId, text, schedule, timezone };
	}

	return null;
}

function parseTaskFile(value: unknown): ParsedTaskFile | null {
	const event = parseMomEvent(value);
	if (!event) {
		return null;
	}

	const data = value as Record<string, unknown>;
	const paused = data.paused === true;
	return {
		event,
		status: paused ? "paused" : "active",
	};
}

async function setTaskStatus(
	workspaceDir: string,
	channelId: string,
	identifier: string,
	status: TaskStatus,
): Promise<TaskMutationResult> {
	const resolved = await resolveTaskFileForChannel(workspaceDir, channelId, identifier);
	if (!resolved.ok) {
		return resolved;
	}

	if (resolved.taskFile.event.type === "immediate") {
		return { ok: false, error: "Immediate tasks cannot be paused or resumed." };
	}

	const parsed = resolved.parsed as Record<string, unknown>;
	parsed.paused = status === "paused";

	try {
		await writeFile(resolved.filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
		return { ok: true, filename: resolved.filename };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to update task: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function resolveTaskFileForChannel(
	workspaceDir: string,
	channelId: string,
	identifier: string,
): Promise<
	| { ok: true; filename: string; filePath: string; parsed: unknown; taskFile: ParsedTaskFile }
	| { ok: false; error: string }
> {
	const normalizedIdentifier = normalizeTaskIdentifier(identifier);
	if (!normalizedIdentifier) {
		return { ok: false, error: "Missing task id." };
	}
	if (normalizedIdentifier.includes("/") || normalizedIdentifier.includes("\\") || normalizedIdentifier.includes("..")) {
		return { ok: false, error: "Invalid task id." };
	}

	const eventsDir = getEventsDir(workspaceDir);
	const filePath = join(eventsDir, normalizedIdentifier);
	if (!existsSync(filePath)) {
		return { ok: false, error: `Task not found: ${normalizedIdentifier}` };
	}

	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch (err) {
		return {
			ok: false,
			error: `Failed to read task: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { ok: false, error: "Task file is invalid JSON." };
	}

	const taskFile = parseTaskFile(parsed);
	if (!taskFile) {
		return { ok: false, error: "Task file has invalid event format." };
	}

	if (taskFile.event.channelId !== channelId) {
		return { ok: false, error: "Task belongs to another chat." };
	}

	return {
		ok: true,
		filename: normalizedIdentifier,
		filePath,
		parsed,
		taskFile,
	};
}

function getNextRunIso(event: MomEvent): string | null {
	if (event.type === "immediate") {
		return null;
	}
	if (event.type === "one-shot") {
		return event.at;
	}

	const validation = validatePeriodicSchedule(event.schedule, event.timezone);
	if (!validation.ok) {
		return null;
	}
	return validation.nextRunIso;
}
