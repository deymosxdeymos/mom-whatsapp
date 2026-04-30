// ChannelRuntime — per-channel job ledger and lifecycle.
// Ported from pi-chat's ConversationRuntime pattern.
//
// Responsibilities:
//  - Durable log records (inbound, job_queued, job_completed, job_failed)
//  - Pending job queue with serial execution
//  - Active job tracking and retry checkpointing
//  - Pending group history management
//  - Arm/disarm for reconnect catch-up

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GroupHistoryEntry } from "./group-history.js";
import { loadGroupHistory, removeGroupHistoryEntries } from "./group-history.js";
import type { AgentRunner, RunnerCheckpoint } from "./agent.js";
import type { ChannelStore } from "./store.js";
import type { WhatsAppEvent } from "./whatsapp/types.js";
import { acquireLock, releaseLock } from "./lock.js";

// ── Log record types ────────────────────────────────────────────────

interface ChatRecordBase {
	recordId: number;
	timestamp: string;
}

interface InboundRecord extends ChatRecordBase {
	type: "inbound";
	event: WhatsAppEvent;
	userName: string;
}

interface JobQueuedRecord extends ChatRecordBase {
	type: "job_queued";
	jobId: string;
	triggerRecordId: number;
}

interface JobCompletedRecord extends ChatRecordBase {
	type: "job_completed";
	jobId: string;
	triggerRecordId: number;
	outboundText?: string;
}

interface JobFailedRecord extends ChatRecordBase {
	type: "job_failed";
	jobId: string;
	triggerRecordId: number;
	error: string;
}

type ChannelLogRecord = InboundRecord | JobQueuedRecord | JobCompletedRecord | JobFailedRecord;

interface PendingJob {
	jobId: string;
	triggerRecordId: number;
	event: WhatsAppEvent;
}

// ── Runtime ─────────────────────────────────────────────────────────

export interface ChannelRuntimeState {
	channelId: string;
	running: boolean;
	stopRequested: boolean;
	recordCount: number;
	queueLength: number;
	hasActiveJob: boolean;
	armed: boolean;
}

export class ChannelRuntime {
	readonly channelId: string;
	readonly store: ChannelStore;
	readonly runner: AgentRunner;

	running = false;
	stopRequested = false;

	private records: ChannelLogRecord[] = [];
	private nextRecordId = 1;
	private pendingJobs: PendingJob[] = [];
	private activeJob: PendingJob | undefined;
	private armedAfterRecordId: number | undefined;

	private retryCheckpoint: RunnerCheckpoint | undefined;
	private lockPath: string;
	private logPath: string;

	constructor(channelId: string, runner: AgentRunner, store: ChannelStore, workingDir: string) {
		this.channelId = channelId;
		this.runner = runner;
		this.store = store;
		this.lockPath = join(workingDir, channelId, ".runtime-lock");
		this.logPath = join(workingDir, channelId, "runtime-log.jsonl");
	}

	// ── Initialization ───────────────────────────────────────────

	async initialize(): Promise<void> {
		const dir = join(this.store.getChannelDir(this.channelId), "..");
		await mkdir(join(dir, this.channelId), { recursive: true });
		await acquireLock(this.lockPath);
		await this.loadLog();
	}

	async dispose(): Promise<void> {
		await releaseLock(this.lockPath);
	}

	private async loadLog(): Promise<void> {
		try {
			if (!existsSync(this.logPath)) return;
			const content = await readFile(this.logPath, "utf8");
			this.records = content
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ChannelLogRecord)
				.sort((a, b) => a.recordId - b.recordId);
			this.nextRecordId = this.records.reduce((max, r) => Math.max(max, r.recordId), 0) + 1;
		} catch {
			this.records = [];
		}
	}

	private async appendRecord(record: ChannelLogRecord): Promise<void> {
		this.records.push(record);
		this.nextRecordId = Math.max(this.nextRecordId, record.recordId + 1);
		await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
	}

	// ── Arm / disarm (reconnect catch-up) ────────────────────────

	arm(): void {
		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
	}

	get isArmed(): boolean {
		return this.armedAfterRecordId !== undefined;
	}

	private getLastQueuedTriggerRecordId(): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type === "job_queued") last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	// ── Inbound ingestion ────────────────────────────────────────

	async ingestInbound(event: WhatsAppEvent, userName: string): Promise<{ jobQueued: boolean }> {
		const record: InboundRecord = {
			type: "inbound",
			recordId: this.nextRecordId,
			timestamp: new Date().toISOString(),
			event,
			userName,
		};
		await this.appendRecord(record);

		// Don't queue jobs from before we armed (catch-up messages)
		if (this.armedAfterRecordId !== undefined && record.recordId <= this.armedAfterRecordId) {
			return { jobQueued: false };
		}

		// Don't queue if this record was already queued
		if (record.recordId <= this.getLastQueuedTriggerRecordId()) {
			return { jobQueued: false };
		}

		const queuedRecord: JobQueuedRecord = {
			type: "job_queued",
			recordId: this.nextRecordId,
			timestamp: new Date().toISOString(),
			jobId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			triggerRecordId: record.recordId,
		};
		await this.appendRecord(queuedRecord);

		this.pendingJobs.push({
			jobId: queuedRecord.jobId,
			triggerRecordId: record.recordId,
			event,
		});

		return { jobQueued: true };
	}

	// ── Job lifecycle ────────────────────────────────────────────

	beginNext(): WhatsAppEvent | undefined {
		if (this.activeJob || this.pendingJobs.length === 0) return undefined;
		const job = this.pendingJobs.shift();
		if (!job) return undefined;
		this.activeJob = job;
		this.running = true;
		this.stopRequested = false;
		return job.event;
	}

	async complete(outboundText: string): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		await this.appendRecord({
			type: "job_completed",
			recordId: this.nextRecordId,
			timestamp: new Date().toISOString(),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			outboundText: outboundText || undefined,
		});
		this.activeJob = undefined;
		this.running = false;
	}

	async fail(error: string): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		await this.appendRecord({
			type: "job_failed",
			recordId: this.nextRecordId,
			timestamp: new Date().toISOString(),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			error,
		});
		this.activeJob = undefined;
		this.running = false;
	}

	get isRunning(): boolean {
		return this.running;
	}

	get queueLength(): number {
		return this.pendingJobs.length;
	}

	get hasActiveJob(): boolean {
		return this.activeJob !== undefined;
	}

	// ── Retry checkpoint ─────────────────────────────────────────

	saveCheckpoint(): void {
		this.retryCheckpoint = this.runner.createCheckpoint();
	}

	restoreCheckpoint(): boolean {
		if (!this.retryCheckpoint) return false;
		try {
			this.runner.restoreCheckpoint(this.retryCheckpoint);
			return true;
		} catch {
			return false;
		}
	}

	// ── Pending group history ────────────────────────────────────

	getPendingHistory(): GroupHistoryEntry[] {
		return loadGroupHistory(this.store.getChannelDir(this.channelId));
	}

	async clearPendingHistory(entries: GroupHistoryEntry[]): Promise<void> {
		if (entries.length > 0) {
			await removeGroupHistoryEntries(this.store.getChannelDir(this.channelId), entries);
		}
	}

	// ── Status ───────────────────────────────────────────────────

	getState(): ChannelRuntimeState {
		return {
			channelId: this.channelId,
			running: this.running,
			stopRequested: this.stopRequested,
			recordCount: this.records.length,
			queueLength: this.pendingJobs.length,
			hasActiveJob: this.activeJob !== undefined,
			armed: this.isArmed,
		};
	}
}

// ── Runtime registry ────────────────────────────────────────────────

const runtimes = new Map<string, ChannelRuntime>();

export { runtimes };

export function getChannelRuntime(channelId: string): ChannelRuntime | undefined {
	return runtimes.get(channelId);
}

export async function getOrCreateChannelRuntime(
	channelId: string,
	runner: AgentRunner,
	store: ChannelStore,
	workingDir: string,
): Promise<ChannelRuntime> {
	let runtime = runtimes.get(channelId);
	if (!runtime) {
		runtime = new ChannelRuntime(channelId, runner, store, workingDir);
		runtimes.set(channelId, runtime);
		await runtime.initialize();
	}
	return runtime;
}

export function removeChannelRuntime(channelId: string): void {
	runtimes.delete(channelId);
}
