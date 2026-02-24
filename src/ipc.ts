import { type FSWatcher, existsSync, mkdirSync, readdirSync, statSync, watch } from "fs";
import { readFile, unlink } from "fs/promises";
import { join, resolve } from "path";
import * as log from "./log.js";
import {
	createImmediateTaskEvent,
	createOneShotTaskEvent,
	createPeriodicTaskEvent,
	deleteScheduledTask,
	isValidTimezone,
	pauseScheduledTask,
	resumeScheduledTask,
	validatePeriodicSchedule,
} from "./tasks.js";
import type { WhatsAppBot } from "./whatsapp.js";

const DEBOUNCE_MS = 100;
const MAX_IPC_FILE_BYTES = 256 * 1024;
const IPC_FILENAME_PATTERN = /^ipc-[a-z0-9_-]+-[0-9]{10,}-[a-z0-9]+\.json$/i;

interface IpcScheduleTaskImmediate {
	type: "immediate";
	text: string;
}

interface IpcScheduleTaskOneShot {
	type: "one-shot";
	text: string;
	at: string;
}

interface IpcScheduleTaskPeriodic {
	type: "periodic";
	text: string;
	schedule: string;
	timezone: string;
}

type IpcScheduleTask = IpcScheduleTaskImmediate | IpcScheduleTaskOneShot | IpcScheduleTaskPeriodic;

interface IpcScheduleTaskMessage {
	type: "schedule_task";
	task: IpcScheduleTask;
}

interface IpcCancelTaskMessage {
	type: "cancel_task";
	taskId: string;
}

interface IpcPauseTaskMessage {
	type: "pause_task";
	taskId: string;
}

interface IpcResumeTaskMessage {
	type: "resume_task";
	taskId: string;
}

interface IpcOutboundMessage {
	type: "message";
	text: string;
}

type IpcMessage =
	| IpcScheduleTaskMessage
	| IpcCancelTaskMessage
	| IpcPauseTaskMessage
	| IpcResumeTaskMessage
	| IpcOutboundMessage;

export class IpcWatcher {
	private watcher: FSWatcher | null = null;
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private processingPaths: Set<string> = new Set();
	private ipcDir: string;

	constructor(
		private workspaceDir: string,
		private wa: WhatsAppBot,
	) {
		this.ipcDir = join(workspaceDir, "ipc");
	}

	start(): void {
		if (!existsSync(this.ipcDir)) {
			mkdirSync(this.ipcDir, { recursive: true });
		}

		log.logInfo(`IPC watcher starting, dir: ${this.ipcDir}`);
		this.scanExisting();

		this.watcher = watch(this.ipcDir, { recursive: true }, (_eventType, filename) => {
			if (!filename) return;
			const relativePath = filename.toString();
			if (!this.shouldProcessRelativePath(relativePath)) return;
			this.debounce(relativePath, () => this.handleFileChange(relativePath));
		});

		log.logInfo("IPC watcher started");
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this.processingPaths.clear();
		log.logInfo("IPC watcher stopped");
	}

	private debounce(relativePath: string, fn: () => void): void {
		const existing = this.debounceTimers.get(relativePath);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			relativePath,
			setTimeout(() => {
				this.debounceTimers.delete(relativePath);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		const stack: string[] = [this.ipcDir];

		while (stack.length > 0) {
			const dir = stack.pop();
			if (!dir || !existsSync(dir)) {
				continue;
			}

			let entries: string[] = [];
			try {
				entries = readdirSync(dir);
			} catch (err) {
				log.logWarning(`Failed to read IPC directory: ${dir}`, err instanceof Error ? err.message : String(err));
				continue;
			}

			for (const entry of entries) {
				const fullPath = join(dir, entry);
				let isDirectory = false;
				try {
					isDirectory = statSync(fullPath).isDirectory();
				} catch {
					continue;
				}

				if (isDirectory) {
					stack.push(fullPath);
					continue;
				}

				const relativePath = fullPath.slice(this.ipcDir.length + 1);
				if (!this.shouldProcessRelativePath(relativePath)) {
					continue;
				}
				void this.processFile(relativePath);
			}
		}
	}

	private shouldProcessRelativePath(relativePath: string): boolean {
		const normalized = relativePath.replace(/\\/g, "/");
		if (normalized.endsWith(".tmp")) {
			return false;
		}
		if (!normalized.endsWith(".json")) {
			return false;
		}
		const parts = normalized.split("/").filter((part) => part.length > 0);
		if (parts.length !== 2) {
			return false;
		}
		const filename = parts[1];
		return IPC_FILENAME_PATTERN.test(filename);
	}

	private handleFileChange(relativePath: string): void {
		const absolutePath = join(this.ipcDir, relativePath);
		if (!existsSync(absolutePath)) {
			return;
		}
		void this.processFile(relativePath);
	}

	private async processFile(relativePath: string): Promise<void> {
		const resolved = this.resolveIpcFile(relativePath);
		if (!resolved) {
			log.logWarning(`Ignoring invalid IPC file path: ${relativePath}`);
			return;
		}

		const { chatJid, filePath, filename } = resolved;
		if (this.processingPaths.has(filePath)) {
			return;
		}
		this.processingPaths.add(filePath);

		try {
			try {
				const size = statSync(filePath).size;
				if (size > MAX_IPC_FILE_BYTES) {
					log.logWarning(`IPC file too large (${size} bytes), deleting`, `${chatJid}/${filename}`);
					await this.deleteFile(filePath, relativePath);
					return;
				}
			} catch (err) {
				if (isNodeErrorWithCode(err) && err.code === "ENOENT") {
					return;
				}
				log.logWarning(`Failed to stat IPC file: ${relativePath}`, err instanceof Error ? err.message : String(err));
				return;
			}

			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch (err) {
				log.logWarning(`Failed reading IPC file: ${relativePath}`, err instanceof Error ? err.message : String(err));
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch (err) {
				log.logWarning(`Invalid IPC JSON: ${relativePath}`, err instanceof Error ? err.message : String(err));
				await this.deleteFile(filePath, relativePath);
				return;
			}

			try {
				const message = parseIpcMessage(parsed);
				await this.dispatch(chatJid, message);
				log.logInfo(`Processed IPC file: ${chatJid}/${filename} (${message.type})`);
			} catch (err) {
				log.logWarning(`Failed processing IPC file: ${chatJid}/${filename}`, err instanceof Error ? err.message : String(err));
			} finally {
				await this.deleteFile(filePath, relativePath);
			}
		} finally {
			this.processingPaths.delete(filePath);
		}
	}

	private resolveIpcFile(relativePath: string): { chatJid: string; filename: string; filePath: string } | null {
		const normalized = relativePath.replace(/\\/g, "/");
		if (normalized.startsWith("/") || normalized.includes("..")) {
			return null;
		}

		const parts = normalized.split("/").filter((part) => part.length > 0);
		if (parts.length !== 2) {
			return null;
		}

		const [chatJid, filename] = parts;
		if (!IPC_FILENAME_PATTERN.test(filename)) {
			return null;
		}

		const filePath = resolve(this.ipcDir, chatJid, filename);
		const ipcDirResolved = resolve(this.ipcDir);
		if (!filePath.startsWith(`${ipcDirResolved}/`) && filePath !== ipcDirResolved) {
			return null;
		}

		return { chatJid, filename, filePath };
	}

	private async dispatch(chatJid: string, message: IpcMessage): Promise<void> {
		if (message.type === "message") {
			await this.wa.postMessage(chatJid, message.text);
			return;
		}

		if (message.type === "cancel_task") {
			const deleted = await deleteScheduledTask(this.workspaceDir, chatJid, message.taskId);
			if (!deleted.ok) {
				throw new Error(deleted.error);
			}
			return;
		}

		if (message.type === "pause_task") {
			const paused = await pauseScheduledTask(this.workspaceDir, chatJid, message.taskId);
			if (!paused.ok) {
				throw new Error(paused.error);
			}
			return;
		}

		if (message.type === "resume_task") {
			const resumed = await resumeScheduledTask(this.workspaceDir, chatJid, message.taskId);
			if (!resumed.ok) {
				throw new Error(resumed.error);
			}
			return;
		}

		if (message.task.type === "immediate") {
			await createImmediateTaskEvent(this.workspaceDir, chatJid, message.task.text);
			return;
		}

		if (message.task.type === "one-shot") {
			if (!/(Z|[+-]\d{2}:\d{2})$/i.test(message.task.at)) {
				throw new Error("One-shot 'at' timestamp must include timezone offset");
			}
			const atTime = new Date(message.task.at).getTime();
			if (!Number.isFinite(atTime)) {
				throw new Error("One-shot 'at' timestamp is invalid");
			}
			if (atTime <= Date.now()) {
				throw new Error("One-shot 'at' timestamp must be in the future");
			}

			await createOneShotTaskEvent(this.workspaceDir, chatJid, message.task.text, message.task.at);
			return;
		}

		if (!isValidTimezone(message.task.timezone)) {
			throw new Error(`Invalid timezone: ${message.task.timezone}`);
		}

		const periodicValidation = validatePeriodicSchedule(message.task.schedule, message.task.timezone);
		if (!periodicValidation.ok) {
			throw new Error(`Invalid periodic schedule: ${periodicValidation.error || "unknown error"}`);
		}

		await createPeriodicTaskEvent(
			this.workspaceDir,
			chatJid,
			message.task.text,
			message.task.schedule,
			message.task.timezone,
		);
	}

	private async deleteFile(filePath: string, relativePath: string): Promise<void> {
		try {
			await unlink(filePath);
		} catch (err) {
			if (isNodeErrorWithCode(err) && err.code === "ENOENT") {
				return;
			}
			log.logWarning(`Failed to delete IPC file: ${relativePath}`, err instanceof Error ? err.message : String(err));
		}
	}
}

export function createIpcWatcher(workspaceDir: string, wa: WhatsAppBot): IpcWatcher {
	return new IpcWatcher(workspaceDir, wa);
}

export function parseIpcMessage(value: unknown): IpcMessage {
	if (!isRecord(value)) {
		throw new Error("IPC payload must be an object");
	}

	const type = getString(value, "type");
	if (!type) {
		throw new Error("Missing IPC message type");
	}

	if (type === "message") {
		const text = getNonEmptyString(value, "text", "Message text is required");
		return { type: "message", text };
	}

	if (type === "cancel_task") {
		const taskId = getNonEmptyString(value, "taskId", "taskId is required for cancel_task");
		return { type: "cancel_task", taskId };
	}

	if (type === "pause_task") {
		const taskId = getNonEmptyString(value, "taskId", "taskId is required for pause_task");
		return { type: "pause_task", taskId };
	}

	if (type === "resume_task") {
		const taskId = getNonEmptyString(value, "taskId", "taskId is required for resume_task");
		return { type: "resume_task", taskId };
	}

	if (type === "schedule_task") {
		const taskValue = value.task;
		if (!isRecord(taskValue)) {
			throw new Error("schedule_task requires a task object");
		}

		const taskType = getString(taskValue, "type");
		if (!taskType) {
			throw new Error("schedule_task task.type is required");
		}

		const text = getNonEmptyString(taskValue, "text", "schedule_task task.text is required");

		if (taskType === "immediate") {
			return { type: "schedule_task", task: { type: "immediate", text } };
		}

		if (taskType === "one-shot") {
			const at = getNonEmptyString(taskValue, "at", "schedule_task one-shot task.at is required");
			return { type: "schedule_task", task: { type: "one-shot", text, at } };
		}

		if (taskType === "periodic") {
			const schedule = getNonEmptyString(
				taskValue,
				"schedule",
				"schedule_task periodic task.schedule is required",
			);
			const timezone = getNonEmptyString(
				taskValue,
				"timezone",
				"schedule_task periodic task.timezone is required",
			);
			return { type: "schedule_task", task: { type: "periodic", text, schedule, timezone } };
		}

		throw new Error(`Unknown schedule_task task.type: ${taskType}`);
	}

	throw new Error(`Unknown IPC message type: ${type}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
	const value = obj[key];
	return typeof value === "string" ? value : null;
}

function getNonEmptyString(obj: Record<string, unknown>, key: string, errorMessage: string): string {
	const value = getString(obj, key);
	if (!value || value.trim().length === 0) {
		throw new Error(errorMessage);
	}
	return value.trim();
}

interface NodeErrorWithCode {
	code?: string;
}

function isNodeErrorWithCode(value: unknown): value is NodeErrorWithCode {
	return typeof value === "object" && value !== null && "code" in value;
}
