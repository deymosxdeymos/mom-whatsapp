import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestWaWebVersion,
	makeCacheableSignalKeyStore,
	type proto,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { open, writeFile } from "fs/promises";
import { basename, extname, join } from "path";
import { normalizeWhatsAppJid } from "./jid.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_OUTGOING_QUEUE = 200;
const BOT_LOG_LOOKUP_MAX_LINES = 200;
const BOT_LOG_TAIL_BYTES = 128 * 1024;
const BOT_LOG_CACHE_MAX_IDS_PER_CHANNEL = 2000;
const MOM_WA_DEBUG_INCOMING = process.env.MOM_WA_DEBUG_INCOMING === "1";

export interface WhatsAppEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	attachments?: Attachment[];
	messageKey?: proto.IMessageKey;
}

export interface WhatsAppUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface WhatsAppChannel {
	id: string;
	name: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface BotContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	markToolExecution?: () => void;
}

export interface MomHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: WhatsAppEvent, wa: WhatsAppBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, wa: WhatsAppBot): Promise<void>;
}

type QueuedWork = () => Promise<void>;

type PendingOutbound =
	| { type: "text"; jid: string; text: string }
	| { type: "file"; jid: string; filePath: string; title?: string };

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		void this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift();
		if (!work) {
			this.processing = false;
			return;
		}
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		void this.processNext();
	}
}

type SocketFactoryConfig = Parameters<typeof makeWASocket>[0];
type MultiFileAuthState = Awaited<ReturnType<typeof useMultiFileAuthState>>;

export interface WhatsAppDependencies {
	useAuthState: (authDir: string) => Promise<MultiFileAuthState>;
	makeSocket: (config: SocketFactoryConfig) => WASocket;
	downloadMedia: (msg: WAMessage, sock: WASocket) => Promise<Buffer>;
	setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
	setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
}

interface WhatsAppBotConfig {
	authDir: string;
	workingDir: string;
	store: ChannelStore;
	botName: string;
	allowedGroups: string[];
	assistantHasOwnNumber: boolean;
	groupTriggerAliases?: string[];
	deps?: Partial<WhatsAppDependencies>;
}

interface LIDResolver {
	lidMapping?: {
		getPNForLID?: (jid: string) => Promise<string | undefined>;
	};
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

function createWhatsAppDependencies(overrides?: Partial<WhatsAppDependencies>): WhatsAppDependencies {
	const defaults: WhatsAppDependencies = {
		useAuthState: useMultiFileAuthState,
		makeSocket: makeWASocket,
		downloadMedia: async (msg, sock) => {
			const result = await downloadMediaMessage(
				msg,
				"buffer",
				{},
				{
					reuploadRequest: sock.updateMediaMessage.bind(sock),
					logger: sock.logger,
				},
			);
			return result;
		},
		setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	};

	return {
		...defaults,
		...overrides,
	};
}

export class WhatsAppBot {
	private sock: WASocket | null = null;
	private connected = false;
	private handler: MomHandler;
	private config: WhatsAppBotConfig;
	private deps: WhatsAppDependencies;
	private channels = new Map<string, WhatsAppChannel>();
	private users = new Map<string, WhatsAppUser>();
	private queues = new Map<string, ChannelQueue>();
	private startupTs = 0;
	private botJids = new Set<string>();
	private lidToPhoneMap = new Map<string, string>();
	private recentOutboundMessageIds = new Map<string, number>();
	private botLoggedMessageIds = new Map<string, Set<string>>();
	private botLogCacheLoadPromises = new Map<string, Promise<void>>();
	private botLogCacheLoadedChannels = new Set<string>();
	private outgoingQueue: PendingOutbound[] = [];
	private flushingOutgoing = false;
	private outgoingRetryScheduled = false;
	private groupSyncTimerStarted = false;
	private reconnectDelay = 5000;

	constructor(handler: MomHandler, config: WhatsAppBotConfig) {
		this.handler = handler;
		this.config = config;
		this.deps = createWhatsAppDependencies(config.deps);
	}

	async start(): Promise<void> {
		if (!existsSync(this.config.authDir)) {
			mkdirSync(this.config.authDir, { recursive: true });
		}
		this.startupTs = Date.now();
		await new Promise<void>((resolve, reject) => {
			this.connect(resolve).catch(reject);
		});
		log.logConnected();
	}

	private async connect(onFirstOpen?: () => void): Promise<void> {
		const { state, saveCreds } = await this.deps.useAuthState(this.config.authDir);
		if (state.creds.registered !== true) {
			log.logWarning("WhatsApp auth required. Run `npm run wa:auth` before starting mom-whatsapp.");
			throw new Error("WhatsApp auth not initialized");
		}

		const { version, isLatest } = await fetchLatestWaWebVersion().catch(() => ({
			version: [2, 3000, 1027934701] as [number, number, number],
			isLatest: false,
		}));
		log.logInfo(`Using WA version ${version.join(".")} (isLatest: ${isLatest})`);
		this.sock = this.deps.makeSocket({
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys),
			},
			version,
			printQRInTerminal: false,
			browser: Browsers.macOS("Chrome"),
		});

		this.sock.ev.on("creds.update", saveCreds);
		this.sock.ev.on("connection.update", (update) => {
			log.logInfo(
				`connection.update — connection: ${update.connection ?? "none"}, hasQR: ${!!update.qr}, hasError: ${!!update.lastDisconnect?.error}`,
			);
			if (update.qr) {
				log.logWarning("WhatsApp auth expired or missing. Run `npm run wa:auth`, then restart mom-whatsapp.");
				process.exit(1);
				return;
			}

			if (update.connection === "open") {
				this.connected = true;
				this.reconnectDelay = 5000;
				this.registerBotJids();
				log.logInfo("Connected to WhatsApp");
				void this.sock?.sendPresenceUpdate("available");
				void this.syncGroupMetadata();
				if (!this.groupSyncTimerStarted) {
					this.groupSyncTimerStarted = true;
					this.deps.setInterval(() => {
						void this.syncGroupMetadata();
					}, GROUP_SYNC_INTERVAL_MS);
				}
				void this.flushOutgoingQueue();
				if (onFirstOpen) {
					onFirstOpen();
					onFirstOpen = undefined;
				}
				return;
			}

			if (update.connection !== "close") return;
			this.connected = false;
			const disconnectError = update.lastDisconnect?.error;
			const statusCode =
				disconnectError && typeof disconnectError === "object"
					? Number(
							(disconnectError as { output?: { statusCode?: number } }).output?.statusCode ??
								DisconnectReason.connectionClosed,
						)
					: DisconnectReason.connectionClosed;
			const errorData = (disconnectError as { output?: { payload?: unknown } } | undefined)?.output?.payload;
			log.logWarning(
				`WhatsApp disconnect — statusCode: ${statusCode}, message: ${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}, data: ${JSON.stringify(errorData)}`,
			);

			if (statusCode === DisconnectReason.loggedOut) {
				log.logWarning("WhatsApp logged out. Run `npm run wa:auth`, then restart mom-whatsapp.");
				process.exit(1);
				return;
			}

			log.logWarning(`WhatsApp disconnected, reconnecting in ${this.reconnectDelay / 1000}s...`);
			this.deps.setTimeout(() => {
				void this.connect(onFirstOpen);
			}, this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
		});

		this.sock.ev.on("messages.upsert", async (upsert) => {
			if (upsert.type !== "notify") return;
			for (const msg of upsert.messages) {
				await this.handleIncomingMessage(msg);
			}
		});
	}

	private registerBotJids(): void {
		if (!this.sock?.user) return;
		const primary = normalizeWhatsAppJid(this.sock.user.id);
		this.botJids.add(primary);
		const lid = this.sock.user.lid ? normalizeWhatsAppJid(this.sock.user.lid) : undefined;
		if (lid) {
			this.botJids.add(lid);
			this.lidToPhoneMap.set(lid.split("@")[0], primary);
		}
	}

	private async handleIncomingMessage(msg: WAMessage): Promise<void> {
		if (!msg.key?.remoteJid) return;
		if (msg.key.remoteJid === "status@broadcast") return;
		if (this.isRecentOutboundMessageId(msg.key.id || undefined)) return;

		const channelId = normalizeWhatsAppJid(await this.translateJid(msg.key.remoteJid));
		const senderRaw = msg.key.participant || msg.key.remoteJid;
		const sender = normalizeWhatsAppJid(await this.translateJid(senderRaw));
		const userName = msg.pushName || sender.split("@")[0];
		const text = this.extractText(msg.message);
		const tsMs = this.timestampToMs(msg.messageTimestamp);
		const fromMe = msg.key.fromMe || false;

		if (this.config.assistantHasOwnNumber && fromMe) return;
		if (this.isBotAuthoredMessage(fromMe, text)) return;

		this.users.set(sender, { id: sender, userName, displayName: userName });
		if (!this.channels.has(channelId)) {
			const defaultName = channelId.endsWith("@g.us") ? await this.getGroupName(channelId) : `DM:${userName}`;
			this.channels.set(channelId, { id: channelId, name: defaultName });
		}

		const isDm = channelId.endsWith("@s.whatsapp.net");
		if (!isDm && !channelId.endsWith("@g.us")) return;
		if (!isDm && !this.isGroupAllowed(channelId)) return;

		const cleanedText = isDm ? text.trim() : this.stripMention(text, msg.message).trim();
		const stopRequested = this.isStopCommandText(cleanedText || text);

		const mentioned = this.isMentioned(text, msg.message);
		const repliedToBot = await this.isReplyToBotMessage(channelId, msg.message);
		const botTriggered = isDm || mentioned || repliedToBot || (stopRequested && this.handler.isRunning(channelId));
		if (MOM_WA_DEBUG_INCOMING && !isDm) {
			log.logInfo(
				`[debug:incoming] channel=${channelId} sender=${sender} raw=${JSON.stringify(text)} cleaned=${JSON.stringify(cleanedText)} mention=${mentioned} reply=${repliedToBot} stop=${stopRequested} triggered=${botTriggered}`,
			);
		}
		if (!botTriggered) return;

		const attachments = stopRequested ? [] : await this.downloadMediaAttachments(channelId, msg, tsMs);
		// Only drop if there's truly nothing — bare @mentions are valid triggers,
		// so let them through with a neutral fallback rather than silently ignoring.
		if (!stopRequested && !cleanedText && attachments.length === 0 && !mentioned) return;

		const event: WhatsAppEvent = {
			type: isDm ? "dm" : "mention",
			channel: channelId,
			user: sender,
			text: stopRequested ? "stop" : cleanedText || (attachments.length > 0 ? "Please analyze the attached files." : "hey"),
			ts: String(tsMs),
			attachments,
			messageKey: msg.key,
		};

		await this.logUserMessage(event, userName);

		if (tsMs < this.startupTs) {
			return;
		}


		if (event.text.toLowerCase() === "stop") {
			if (this.handler.isRunning(channelId)) {
				await this.handler.handleStop(channelId, this);
			} else {
				await this.postMessage(channelId, "_Nothing running_");
			}
			return;
		}

		// Queue the event. The ChannelQueue serializes naturally — if a run is active,
		// this message waits and is processed immediately after. Nanoclaw-style: messages
		// accumulate rather than getting dropped. Cap at 4 queued to avoid unbounded backlog.
		const queue = this.getQueue(channelId);
		if (queue.size() >= 4) {
			log.logWarning(`[${channelId}] Message queue full (${queue.size()}), dropping`);
			return;
		}
		queue.enqueue(() => this.handler.handleEvent(event, this));
	}

	private async logUserMessage(event: WhatsAppEvent, userName: string): Promise<void> {
		await this.config.store.logMessage(event.channel, {
			date: new Date(Number(event.ts)).toISOString(),
			ts: event.ts,
			messageId: event.messageKey?.id || undefined,
			user: event.user,
			userName,
			displayName: userName,
			text: event.text,
			attachments: event.attachments || [],
			isBot: false,
		});
	}

	private isGroupAllowed(channelId: string): boolean {
		if (this.config.allowedGroups.length === 0) return true;
		const channelName = this.channels.get(channelId)?.name.toLowerCase() || "";
		return this.config.allowedGroups.some((allowed) => {
			const value = allowed.toLowerCase();
			return value === channelId.toLowerCase() || (channelName.length > 0 && channelName.includes(value));
		});
	}

	private isBotAuthoredMessage(fromMe: boolean, text: string): boolean {
		if (this.config.assistantHasOwnNumber) return fromMe;
		if (!fromMe) return false;
		const normalized = text.trim().toLowerCase();
		return normalized.startsWith(`${this.config.botName.toLowerCase()}:`);
	}

	private isRecentOutboundMessageId(messageId: string | null | undefined): boolean {
		if (!messageId) return false;
		const now = Date.now();
		for (const [id, createdAt] of this.recentOutboundMessageIds) {
			if (now - createdAt > 10 * 60 * 1000) {
				this.recentOutboundMessageIds.delete(id);
			}
		}
		return this.recentOutboundMessageIds.has(messageId);
	}

	private rememberOutboundMessageId(messageId: string | null | undefined): void {
		if (!messageId) return;
		this.recentOutboundMessageIds.set(messageId, Date.now());
	}

	private rememberBotLoggedMessageId(channelId: string, messageId: string): void {
		if (!messageId) return;
		let ids = this.botLoggedMessageIds.get(channelId);
		if (!ids) {
			ids = new Set<string>();
			this.botLoggedMessageIds.set(channelId, ids);
		}
		ids.add(messageId);
		while (ids.size > BOT_LOG_CACHE_MAX_IDS_PER_CHANNEL) {
			const oldest = ids.values().next().value as string | undefined;
			if (!oldest) break;
			ids.delete(oldest);
		}
	}

	private async ensureBotLogCacheLoaded(channelId: string): Promise<void> {
		if (this.botLogCacheLoadedChannels.has(channelId)) {
			return;
		}
		if (this.botLogCacheLoadPromises.has(channelId)) {
			await this.botLogCacheLoadPromises.get(channelId);
			return;
		}

		const loadPromise = this.loadBotLogCache(channelId)
			.catch((err) => {
				log.logWarning(
					`[${channelId}] Failed to load bot message cache`,
					err instanceof Error ? err.message : String(err),
				);
			})
			.finally(() => {
				this.botLogCacheLoadPromises.delete(channelId);
				this.botLogCacheLoadedChannels.add(channelId);
			});
		this.botLogCacheLoadPromises.set(channelId, loadPromise);
		await loadPromise;
	}

	private async loadBotLogCache(channelId: string): Promise<void> {
		const logPath = join(this.config.store.getChannelDir(channelId), "log.jsonl");
		if (!existsSync(logPath)) return;

		const handle = await open(logPath, "r");
		try {
			const stats = await handle.stat();
			if (stats.size <= 0) return;

			const bytesToRead = Math.min(Number(stats.size), BOT_LOG_TAIL_BYTES);
			const start = Math.max(0, Number(stats.size) - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			const readResult = await handle.read(buffer, 0, bytesToRead, start);
			let content = buffer.subarray(0, readResult.bytesRead).toString("utf-8");
			if (start > 0) {
				const firstNewline = content.indexOf("\n");
				content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
			}

			const trimmed = content.trim();
			if (!trimmed) return;

			const lines = trimmed.split("\n");
			const startIndex = Math.max(0, lines.length - BOT_LOG_LOOKUP_MAX_LINES);
			for (let i = startIndex; i < lines.length; i += 1) {
				const line = lines[i];
				if (!line) continue;
				let parsed: { messageId?: string; botMessageIds?: string[]; isBot?: boolean };
				try {
					parsed = JSON.parse(line) as { messageId?: string; botMessageIds?: string[]; isBot?: boolean };
				} catch {
					continue;
				}
				if (parsed.isBot !== true) {
					continue;
				}
				if (Array.isArray(parsed.botMessageIds)) {
					for (const messageId of parsed.botMessageIds) {
						if (typeof messageId === "string" && messageId.length > 0) {
							this.rememberBotLoggedMessageId(channelId, messageId);
						}
					}
				}
				if (parsed.messageId) {
					this.rememberBotLoggedMessageId(channelId, parsed.messageId);
				}
			}
		} finally {
			await handle.close();
		}
	}

	private isMentioned(text: string, message: proto.IMessage | null | undefined): boolean {
		for (const trigger of this.getGroupTriggerTokens()) {
			const mentionRegex = new RegExp(`(?:^|\\s)@?${escapeRegex(trigger)}(?:\\b|\\s|$)`, "i");
			if (mentionRegex.test(text)) return true;
		}
		const mentionedJids = this.getMentionedJids(message);
		return mentionedJids.some((jid) => this.botJids.has(normalizeWhatsAppJid(jid)));
	}

	private isStopCommandText(text: string): boolean {
		const normalized = text.trim().toLowerCase();
		return normalized === "stop" || normalized === "!stop" || normalized === "/stop";
	}

	private stripMention(text: string, message: proto.IMessage | null | undefined): string {
		let stripped = text;
		for (const trigger of this.getGroupTriggerTokens()) {
			stripped = stripped.replace(new RegExp(`(?:^|\\s)@?${escapeRegex(trigger)}(?:\\b|\\s|$)`, "ig"), " ");
		}

		const mentionedJids = this.getMentionedJids(message);
		const botMentionedByJid = mentionedJids.some((jid) => this.botJids.has(normalizeWhatsAppJid(jid)));
		if (botMentionedByJid) {
			for (const botJid of this.botJids) {
				const alias = this.extractJidUserPart(botJid);
				if (!alias) continue;
				stripped = stripped.replace(new RegExp(`(?:^|\\s)@?${escapeRegex(alias)}(?:\\b|\\s|$)`, "ig"), " ");
			}
		}

		return stripped.replace(/\s+/g, " ").trim();
	}

	private extractJidUserPart(jid: string): string {
		const [userPart = ""] = jid.split("@", 1);
		const [baseUser = ""] = userPart.split(":", 1);
		return baseUser;
	}

	private getGroupTriggerTokens(): string[] {
		const aliases = this.config.groupTriggerAliases || [];
		const deduped = new Set<string>();
		for (const token of [this.config.botName, ...aliases]) {
			const normalized = token.trim();
			if (!normalized) continue;
			deduped.add(normalized);
		}
		return Array.from(deduped);
	}

	private getContextInfos(message: proto.IMessage | null | undefined): Array<proto.IContextInfo | null | undefined> {
		if (!message) return [];
		return [
			message.extendedTextMessage?.contextInfo,
			message.imageMessage?.contextInfo,
			message.videoMessage?.contextInfo,
			message.documentMessage?.contextInfo,
		];
	}

	private getMentionedJids(message: proto.IMessage | null | undefined): string[] {
		const all: string[] = [];
		for (const info of this.getContextInfos(message)) {
			if (!info?.mentionedJid) continue;
			all.push(...info.mentionedJid);
		}
		return all;
	}

	private async isReplyToBotMessage(channelId: string, message: proto.IMessage | null | undefined): Promise<boolean> {
		for (const info of this.getContextInfos(message)) {
			const stanzaId = info?.stanzaId;
			if (stanzaId && this.isRecentOutboundMessageId(stanzaId)) {
				return true;
			}

			const participant = info?.participant;
			if (participant && this.botJids.has(normalizeWhatsAppJid(participant))) {
				return true;
			}

			if (stanzaId && (await this.wasBotMessageLogged(channelId, stanzaId))) {
				return true;
			}
		}
		return false;
	}

	private async wasBotMessageLogged(channelId: string, messageId: string): Promise<boolean> {
		const cached = this.botLoggedMessageIds.get(channelId);
		if (cached?.has(messageId)) {
			return true;
		}

		await this.ensureBotLogCacheLoaded(channelId);
		return this.botLoggedMessageIds.get(channelId)?.has(messageId) ?? false;
	}

	private extractText(message: proto.IMessage | null | undefined): string {
		if (!message) return "";
		if (message.conversation) return message.conversation;
		if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
		if (message.imageMessage?.caption) return message.imageMessage.caption;
		if (message.videoMessage?.caption) return message.videoMessage.caption;
		if (message.documentMessage?.caption) return message.documentMessage.caption;
		return "";
	}

	private timestampToMs(ts: unknown): number {
		if (!ts) return Date.now();
		if (typeof ts === "number") return ts * 1000;
		if (typeof ts === "bigint") return Number(ts) * 1000;
		if (typeof ts === "object" && ts !== null) {
			const stringLike = ts as { toString?: () => string };
			if (typeof stringLike.toString === "function") {
				const secondsFromString = Number(stringLike.toString());
				if (Number.isFinite(secondsFromString)) {
					return secondsFromString * 1000;
				}
			}

			const longParts = ts as { low?: unknown; high?: unknown; unsigned?: unknown };
			if (typeof longParts.low === "number" && typeof longParts.high === "number") {
				const low = BigInt(longParts.low >>> 0);
				const high = BigInt(longParts.high >>> 0);
				const value = (high << 32n) | low;
				const signedValue = longParts.unsigned === true ? value : BigInt.asIntN(64, value);
				const secondsFromParts = Number(signedValue);
				if (Number.isFinite(secondsFromParts)) {
					return secondsFromParts * 1000;
				}
			}
		}
		return Date.now();
	}

	private async getGroupName(channelId: string): Promise<string> {
		if (!this.sock) return channelId;
		try {
			const meta = await this.sock.groupMetadata(channelId);
			return meta.subject || channelId;
		} catch {
			return channelId;
		}
	}

	private async syncGroupMetadata(): Promise<void> {
		if (!this.sock) return;
		try {
			const groups = await this.sock.groupFetchAllParticipating();
			for (const [jid, meta] of Object.entries(groups)) {
				if (meta.subject) {
					this.channels.set(jid, { id: jid, name: meta.subject });
				}
			}
		} catch (err) {
			log.logWarning("Failed to sync WhatsApp group metadata", err instanceof Error ? err.message : String(err));
		}
	}

	private async translateJid(jid: string): Promise<string> {
		if (!jid.endsWith("@lid") || !this.sock) return jid;
		const lidUser = jid.split("@")[0].split(":")[0];
		const cached = this.lidToPhoneMap.get(lidUser);
		if (cached) return cached;

		try {
			const signalRepo = this.sock.signalRepository as LIDResolver | undefined;
			const pn = await signalRepo?.lidMapping?.getPNForLID?.(jid);
			if (pn) {
				const normalized = normalizeWhatsAppJid(pn);
				this.lidToPhoneMap.set(lidUser, normalized);
				return normalized;
			}
		} catch {
			// Ignore translation errors and fall back to original jid.
		}

		return jid;
	}

	private async downloadMediaAttachments(
		channelId: string,
		msg: WAMessage,
		timestampMs: number,
	): Promise<Attachment[]> {
		const hasMedia = Boolean(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage);
		if (!hasMedia || !this.sock) return [];

		try {
			const buffer = await this.deps.downloadMedia(msg, this.sock);

			const fileNameWithExt = this.detectAttachmentFilename(msg);
			const timestampSeconds = (timestampMs / 1000).toString();
			const localFileName = this.config.store.generateLocalFilename(fileNameWithExt, timestampSeconds);
			const localPath = `${channelId}/attachments/${localFileName}`;
			const absolutePath = join(this.config.workingDir, localPath);
			mkdirSync(join(this.config.store.getChannelDir(channelId), "attachments"), { recursive: true });
			await writeFile(absolutePath, buffer);

			return [{ original: fileNameWithExt, local: localPath }];
		} catch (err) {
			log.logWarning("Failed to download WhatsApp media", err instanceof Error ? err.message : String(err));
			return [];
		}
	}

	private detectAttachmentFilename(msg: WAMessage): string {
		const documentName = msg.message?.documentMessage?.fileName;
		if (documentName) return documentName;

		if (msg.message?.imageMessage?.mimetype) {
			return `image${extensionFromMime(msg.message.imageMessage.mimetype)}`;
		}
		if (msg.message?.videoMessage?.mimetype) {
			return `video${extensionFromMime(msg.message.videoMessage.mimetype)}`;
		}
		if (msg.message?.documentMessage?.mimetype) {
			return `document${extensionFromMime(msg.message.documentMessage.mimetype)}`;
		}

		return "attachment.bin";
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	enqueueEvent(event: WhatsAppEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding`);
			return false;
		}
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const fallbackTs = `${Date.now()}`;
		if (!this.connected || !this.sock) {
			this.enqueueOutbound({ type: "text", jid: channel, text });
			return fallbackTs;
		}
		try {
			return await this.sendTextNow(channel, text);
		} catch (err) {
			log.logWarning("Failed to send message, queued for retry", err instanceof Error ? err.message : String(err));
			this.enqueueOutbound({ type: "text", jid: channel, text });
			return fallbackTs;
		}
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		if (!this.connected || !this.sock) {
			this.enqueueOutbound({ type: "file", jid: channel, filePath, title });
			return;
		}
		try {
			await this.sendFileNow(channel, filePath, title);
		} catch (err) {
			log.logWarning("Failed to upload file, queued for retry", err instanceof Error ? err.message : String(err));
			this.enqueueOutbound({ type: "file", jid: channel, filePath, title });
		}
	}

	async setTyping(channel: string, isTyping: boolean): Promise<void> {
		if (!this.sock || !this.connected) return;
		try {
			await this.sock.sendPresenceUpdate(isTyping ? "composing" : "paused", channel);
		} catch (err) {
			log.logWarning("Failed to set typing", err instanceof Error ? err.message : String(err));
		}
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// Not reliably supported in this adapter.
	}

	logBotResponse(channel: string, text: string, messageIds: string[]): void {
		const normalizedMessageIds = Array.from(
			new Set(messageIds.map((messageId) => messageId.trim()).filter((messageId) => messageId.length > 0)),
		);
		for (const messageId of normalizedMessageIds) {
			this.rememberBotLoggedMessageId(channel, messageId);
		}
		void this.config.store.logBotResponse(channel, text, normalizedMessageIds);
	}

	getUser(userId: string): WhatsAppUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): WhatsAppChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): WhatsAppUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): WhatsAppChannel[] {
		return Array.from(this.channels.values());
	}

	isConnected(): boolean {
		return this.connected;
	}

	getOutgoingQueueSize(): number {
		return this.outgoingQueue.length;
	}

	async reactToMessage(channel: string, key: proto.IMessageKey, emoji: string): Promise<void> {
		if (!this.connected || !this.sock || !key.id || !key.remoteJid) return;
		try {
			await this.sock.sendMessage(channel, {
				react: {
					text: emoji,
					key,
				},
			});
		} catch (err) {
			log.logWarning("Failed to send reaction", err instanceof Error ? err.message : String(err));
		}
	}

	private enqueueOutbound(item: PendingOutbound): void {
		if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
			this.outgoingQueue.shift();
		}
		this.outgoingQueue.push(item);
		if (this.connected && this.sock) {
			void this.flushOutgoingQueue();
		}
	}

	private scheduleOutgoingRetry(delayMs = 2000): void {
		if (this.outgoingRetryScheduled) return;
		this.outgoingRetryScheduled = true;
		this.deps.setTimeout(() => {
			this.outgoingRetryScheduled = false;
			void this.flushOutgoingQueue();
		}, delayMs);
	}

	private async flushOutgoingQueue(): Promise<void> {
		if (!this.connected || !this.sock || this.flushingOutgoing || this.outgoingQueue.length === 0) return;
		this.flushingOutgoing = true;
		try {
			while (this.outgoingQueue.length > 0) {
				const item = this.outgoingQueue[0];
				if (!item) break;
				try {
					if (item.type === "text") {
						await this.sendTextNow(item.jid, item.text);
					} else {
						if (!existsSync(item.filePath)) {
							log.logWarning(`Dropping queued file that no longer exists: ${item.filePath}`);
							this.outgoingQueue.shift();
							continue;
						}
						await this.sendFileNow(item.jid, item.filePath, item.title);
					}
					this.outgoingQueue.shift();
				} catch (err) {
					if (item.type === "file" && isFileNotFoundError(err)) {
						log.logWarning(`Dropping queued file that cannot be read: ${item.filePath}`);
						this.outgoingQueue.shift();
						continue;
					}
					log.logWarning("Failed while flushing outgoing queue", err instanceof Error ? err.message : String(err));
					this.scheduleOutgoingRetry();
					return;
				}
			}
		} finally {
			this.flushingOutgoing = false;
		}
	}

	private async sendTextNow(jid: string, text: string): Promise<string> {
		if (!this.sock) throw new Error("WhatsApp socket not initialized");
		let lastError: Error | null = null;
		const outboundText = this.config.assistantHasOwnNumber ? text : `${this.config.botName}: ${text}`;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const sent = await this.sock.sendMessage(jid, { text: outboundText });
				const messageId = sent?.key?.id;
				this.rememberOutboundMessageId(messageId);
				return messageId || `${Date.now()}`;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < 3) {
					await sleep(250 * attempt);
				}
			}
		}
		throw lastError || new Error("Failed to send message");
	}

	private async sendFileNow(jid: string, filePath: string, title?: string): Promise<void> {
		if (!this.sock) throw new Error("WhatsApp socket not initialized");
		const ext = extname(filePath).toLowerCase();
		const fileName = title || basename(filePath);
		const data = readFileSync(filePath);
		const caption =
			title && !this.config.assistantHasOwnNumber && !title.startsWith(`${this.config.botName}:`)
				? `${this.config.botName}: ${title}`
				: title;

		if (IMAGE_EXTENSIONS.has(ext)) {
			const sent = await this.sock.sendMessage(jid, {
				image: data,
				caption,
			});
			this.rememberOutboundMessageId(sent?.key?.id);
			return;
		}

		if (VIDEO_EXTENSIONS.has(ext)) {
			const sent = await this.sock.sendMessage(jid, {
				video: data,
				caption,
			});
			this.rememberOutboundMessageId(sent?.key?.id);
			return;
		}

		const sent = await this.sock.sendMessage(jid, {
			document: data,
			mimetype: mimeFromExtension(ext),
			fileName,
		});
		this.rememberOutboundMessageId(sent?.key?.id);
	}
}

function mimeFromExtension(ext: string): string {
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".txt") return "text/plain";
	if (ext === ".json") return "application/json";
	if (ext === ".csv") return "text/csv";
	if (ext === ".zip") return "application/zip";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	if (ext === ".mp4") return "video/mp4";
	return "application/octet-stream";
}

function extensionFromMime(mime: string): string {
	if (mime === "image/jpeg") return ".jpg";
	if (mime === "image/png") return ".png";
	if (mime === "image/gif") return ".gif";
	if (mime === "image/webp") return ".webp";
	if (mime === "application/pdf") return ".pdf";
	if (mime === "video/mp4") return ".mp4";
	return ".bin";
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFileNotFoundError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}
