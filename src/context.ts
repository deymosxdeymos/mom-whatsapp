/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { CustomEntry, SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	messageId?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

const SESSION_TIMESTAMP_PREFIX_REGEX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /;
const LEGACY_PENDING_HISTORY_MARKER = "\n[Current message - respond to this]\n";
const WHATSAPP_ATTACHMENTS_MARKER = "\n\n<whatsapp_attachments>\n";

function normalizeMessageText(text: string): string {
	let normalized = text.replace(SESSION_TIMESTAMP_PREFIX_REGEX, "");
	const pendingHistoryIdx = normalized.indexOf(LEGACY_PENDING_HISTORY_MARKER);
	if (pendingHistoryIdx !== -1) {
		normalized = normalized.slice(pendingHistoryIdx + LEGACY_PENDING_HISTORY_MARKER.length);
	}
	const attachmentsIdx = normalized.indexOf(WHATSAPP_ATTACHMENTS_MARKER);
	if (attachmentsIdx !== -1) {
		normalized = normalized.substring(0, attachmentsIdx);
	}
	return normalized.trim();
}

function normalizeMessageTimestamp(ts: string | number | undefined): string | undefined {
	if (ts === undefined) return undefined;
	const numericTs = typeof ts === "number" ? ts : Number(ts);
	if (Number.isFinite(numericTs) && numericTs > 0) {
		const millis = numericTs < 1_000_000_000_000 ? numericTs * 1000 : numericTs;
		return String(Math.round(millis));
	}
	if (typeof ts === "string") {
		const trimmed = ts.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	return undefined;
}

function normalizeMessageId(messageId: string | undefined): string | undefined {
	const normalizedMessageId = messageId?.trim();
	return normalizedMessageId && normalizedMessageId.length > 0 ? normalizedMessageId : undefined;
}

function buildTimestampTextDedupKey(messageText: string, messageTs: string): string {
	return `ts:${messageTs}|${messageText}`;
}

function incrementCount(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function consumeCount(map: Map<string, number>, key: string): boolean {
	const count = map.get(key);
	if (!count || count <= 0) return false;
	if (count === 1) {
		map.delete(key);
	} else {
		map.set(key, count - 1);
	}
	return true;
}

interface SessionResetData {
	at?: unknown;
	ts?: unknown;
}

function getLatestSessionResetTimestampMs(sessionManager: SessionManager): number | null {
	let latestTimestampMs: number | null = null;

	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		const customEntry = entry as CustomEntry<unknown>;
		if (customEntry.customType !== "mom.session_reset") continue;

		let candidateTsMs: number | null = null;
		const data = customEntry.data;
		if (typeof data === "object" && data !== null) {
			const resetData = data as SessionResetData;
			const normalizedResetTs = normalizeMessageTimestamp(
				typeof resetData.ts === "number" || typeof resetData.ts === "string" ? resetData.ts : undefined,
			);
			if (normalizedResetTs) {
				const parsedTs = Number(normalizedResetTs);
				if (Number.isFinite(parsedTs) && parsedTs > 0) {
					candidateTsMs = parsedTs;
				}
			}
			if (candidateTsMs === null && typeof resetData.at === "string") {
				const parsedAt = new Date(resetData.at).getTime();
				if (Number.isFinite(parsedAt) && parsedAt > 0) {
					candidateTsMs = parsedAt;
				}
			}
		}

		if (candidateTsMs === null) {
			const entryTs = new Date(entry.timestamp).getTime();
			if (Number.isFinite(entryTs) && entryTs > 0) {
				candidateTsMs = entryTs;
			}
		}

		if (candidateTsMs !== null && (latestTimestampMs === null || candidateTsMs > latestTimestampMs)) {
			latestTimestampMs = candidateTsMs;
		}
	}

	return latestTimestampMs;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param excludeMessageTs - Timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeMessageTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build counts of existing user messages from session keyed by timestamp + content.
	const existingMessagesByTsText = new Map<string, number>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message as { role: string; content?: unknown; timestamp?: number };
		if (msg.role !== "user" || msg.content === undefined) continue;

		const ts = normalizeMessageTimestamp(msg.timestamp);
		if (!ts) continue;

		const content = msg.content;
		if (typeof content === "string") {
			const normalized = normalizeMessageText(content);
			incrementCount(existingMessagesByTsText, buildTimestampTextDedupKey(normalized, ts));
			continue;
		}

		if (!Array.isArray(content)) continue;
		const entryKeys = new Set<string>();
		for (const part of content) {
			if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
				const normalized = normalizeMessageText((part as { type: "text"; text: string }).text);
				entryKeys.add(buildTimestampTextDedupKey(normalized, ts));
			}
		}
		for (const key of entryKeys) {
			incrementCount(existingMessagesByTsText, key);
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);
	const excludedTs = normalizeMessageTimestamp(excludeMessageTs);
	const latestSessionResetTsMs = getLatestSessionResetTimestampMs(sessionManager);
	const existingMessageIds = new Set<string>();
	const syncedMessageIds = new Set<string>();

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);
			const messageTs = normalizeMessageTimestamp(logMsg.ts);
			const date = logMsg.date;
			if (!messageTs || !date) continue;

			// Skip the current message being processed (will be added via prompt())
			if (excludedTs && messageTs === excludedTs) continue;

			const numericMessageTs = Number(messageTs);
			const parsedDateTs = new Date(date).getTime();
			const messageTsMs =
				Number.isFinite(numericMessageTs) && numericMessageTs > 0
					? numericMessageTs
					: Number.isFinite(parsedDateTs) && parsedDateTs > 0
						? parsedDateTs
						: null;
			if (latestSessionResetTsMs !== null && messageTsMs !== null && messageTsMs <= latestSessionResetTsMs) {
				continue;
			}

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
			const tsTextKey = buildTimestampTextDedupKey(messageText, messageTs);
			const messageId = normalizeMessageId(logMsg.messageId);

			if (messageId) {
				if (existingMessageIds.has(messageId) || syncedMessageIds.has(messageId)) continue;
				if (consumeCount(existingMessagesByTsText, tsTextKey)) {
					existingMessageIds.add(messageId);
					continue;
				}
			} else if (consumeCount(existingMessagesByTsText, tsTextKey)) {
				continue;
			}

			const msgTime = messageTsMs ?? Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			if (messageId) {
				syncedMessageIds.add(messageId);
			}
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
}

const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
};

/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export class MomSettingsManager {
	private settingsPath: string;
	private settings: MomSettings;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): MomSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MomCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getTheme(): string | undefined {
		return undefined;
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	getImageAutoResize(): boolean {
		return true;
	}

	setImageAutoResize(_enabled: boolean): void {
		// No-op for mom
	}

	reload(): void {
		this.settings = this.load();
	}

	getHookPaths(): string[] {
		return []; // Mom doesn't use hooks
	}

	getHookTimeout(): number {
		return 30000;
	}
}
