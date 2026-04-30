import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestWaWebVersion,
	makeCacheableSignalKeyStore,
	normalizeMessageContent,
	type proto,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { open, writeFile } from "fs/promises";
import { basename, extname, join } from "path";
import { appendGroupHistoryEntry, loadGroupHistory, type GroupHistoryEntry } from "./group-history.js";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, mimeFromExtension } from "./attachments.js";
import { isFileNotFoundError, isStopCommandText, sleep } from "./control-commands.js";
import { normalizeWhatsAppJid } from "./jid.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";
import {
	detectAttachmentFilename,
	extractText,
	getContextInfos,
	timestampToMs,
} from "./whatsapp/message-parsing.js";
import {
	getGroupTriggerTokens,
	isBotAuthoredMessage,
	isGroupAllowed,
	isMentioned,
	isReplyToBotByStanzaId,
	stripMention,
} from "./whatsapp/triggers.js";
import type {
	BotContext,
	ChannelInfo,
	MomHandler,
	UserInfo,
	WhatsAppChannel,
	WhatsAppEvent,
	WhatsAppUser,
} from "./whatsapp/types.js";

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_OUTGOING_QUEUE = 200;
const BOT_LOG_LOOKUP_MAX_LINES = 200;
const BOT_LOG_TAIL_BYTES = 128 * 1024;
const BOT_LOG_CACHE_MAX_IDS_PER_CHANNEL = 2000;
const MOM_WA_DEBUG_INCOMING = process.env.MOM_WA_DEBUG_INCOMING === "1";

// Re-export types for backward compatibility.
export type {
	BotContext,
	ChannelInfo,
	MomHandler,
	UserInfo,
	WhatsAppChannel,
	WhatsAppEvent,
	WhatsAppUser,
} from "./whatsapp/types.js";

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
	private seededLogPaths = new Set<string>();
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
		const text = extractText(msg.message);
		const tsMs = timestampToMs(msg.messageTimestamp);
		const fromMe = msg.key.fromMe || false;

		if (this.config.assistantHasOwnNumber && fromMe) return;
		if (isBotAuthoredMessage(this.config, fromMe, text)) return;

		this.users.set(sender, { id: sender, userName, displayName: userName });
		if (!this.channels.has(channelId)) {
			const defaultName = channelId.endsWith("@g.us") ? await this.getGroupName(channelId) : `DM:${userName}`;
			this.channels.set(channelId, { id: channelId, name: defaultName });
		}

		const isDm = channelId.endsWith("@s.whatsapp.net");
		if (!isDm && !channelId.endsWith("@g.us")) return;
		if (!isDm && !isGroupAllowed(channelId, this.config.allowedGroups, this.channels)) return;

		const cleanedText = isDm ? text.trim() : stripMention(getGroupTriggerTokens(this.config), this.botJids, text, msg.message).trim();
		const stopRequested = isStopCommandText(cleanedText || text);

		const mentioned = isMentioned(getGroupTriggerTokens(this.config), this.botJids, text, msg.message);
		const repliedToBot = await this.isReplyToBotMessage(channelId, msg.message);
		const botTriggered = isDm || mentioned || repliedToBot || (stopRequested && this.handler.isRunning(channelId));
		if (MOM_WA_DEBUG_INCOMING && !isDm) {
			log.logInfo(
				`[debug:incoming] channel=${channelId} sender=${sender} raw=${JSON.stringify(text)} cleaned=${JSON.stringify(cleanedText)} mention=${mentioned} reply=${repliedToBot} stop=${stopRequested} triggered=${botTriggered}`,
			);
		}
		if (!botTriggered) {
			if (!isDm && tsMs >= this.startupTs) {
				await this.recordPendingGroupHistory(channelId, {
					messageId: msg.key.id || undefined,
					ts: String(tsMs),
					user: sender,
					userName,
					text: cleanedText || text.trim(),
				});
			}
			return;
		}

		const attachments = stopRequested ? [] : await this.downloadMediaAttachments(channelId, msg, tsMs);
		// Only drop if there's truly nothing — bare @mentions are valid triggers,
		// so let them through with a neutral fallback rather than silently ignoring.
		if (!stopRequested && !cleanedText && attachments.length === 0 && !mentioned) return;

		const event: WhatsAppEvent = {
			type: isDm ? "dm" : "mention",
			source: "whatsapp",
			channel: channelId,
			user: sender,
			rawText: text,
			text: stopRequested ? "stop" : cleanedText || (attachments.length > 0 ? "Please analyze the attached files." : "hey"),
			ts: String(tsMs),
			pendingHistory: isDm ? undefined : this.loadPendingGroupHistory(channelId),
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

	private loadPendingGroupHistory(channelId: string): GroupHistoryEntry[] {
		return loadGroupHistory(this.config.store.getChannelDir(channelId));
	}

	private async recordPendingGroupHistory(channelId: string, entry: GroupHistoryEntry): Promise<void> {
		if (!entry.text.trim()) {
			return;
		}
		await appendGroupHistoryEntry(this.config.store.getChannelDir(channelId), entry);
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

	private async isReplyToBotMessage(channelId: string, message: proto.IMessage | null | undefined): Promise<boolean> {
		const { byStanzaId, byParticipant } = isReplyToBotByStanzaId(getContextInfos(message), this.botJids);
		if (byParticipant) return true;
		if (byStanzaId && this.isRecentOutboundMessageId(byStanzaId)) return true;
		if (byStanzaId && (await this.wasBotMessageLogged(channelId, byStanzaId))) return true;
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
				// Populate participants into users map so agent can tag them
				if (meta.participants) {
					for (const p of meta.participants) {
						const rawJid = p.id;
						const resolvedJid = await this.translateJid(rawJid);
						// Only store phone JIDs — skip unresolved LIDs
						if (!resolvedJid.endsWith("@lid")) {
							const phone = resolvedJid.split("@")[0].split(":")[0];
							const existing = this.users.get(resolvedJid);
							if (!existing) {
								const displayName = p.notify || p.name || phone;
								this.users.set(resolvedJid, {
									id: resolvedJid,
									userName: phone,
									displayName,
								});
							}
						}
					}
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
		const normalizedMessage = normalizeMessageContent(msg.message) || msg.message;
		const normalizedMsg = normalizedMessage ? { ...msg, message: normalizedMessage } : msg;
		const hasMedia = Boolean(
			normalizedMessage?.imageMessage || normalizedMessage?.videoMessage || normalizedMessage?.documentMessage,
		);
		if (!hasMedia || !this.sock) return [];

		const mediaType = normalizedMessage?.documentMessage
			? "document"
			: normalizedMessage?.imageMessage
				? "image"
				: normalizedMessage?.videoMessage
					? "video"
					: "unknown";
		const mimeType =
			normalizedMessage?.documentMessage?.mimetype ||
			normalizedMessage?.imageMessage?.mimetype ||
			normalizedMessage?.videoMessage?.mimetype ||
			"unknown";
		const originalFileName = normalizedMessage?.documentMessage?.fileName || detectAttachmentFilename(normalizedMsg);
		log.logInfo(
			`[${channelId}] Incoming WhatsApp media: type=${mediaType} mimetype=${mimeType} filename=${JSON.stringify(originalFileName)} messageId=${msg.key?.id || "unknown"}`,
		);

		try {
			const buffer = await this.deps.downloadMedia(normalizedMsg, this.sock);

			const fileNameWithExt = detectAttachmentFilename(normalizedMsg);
			const timestampSeconds = (timestampMs / 1000).toString();
			const localFileName = this.config.store.generateLocalFilename(fileNameWithExt, timestampSeconds);
			const localPath = `${channelId}/attachments/${localFileName}`;
			const absolutePath = join(this.config.workingDir, localPath);
			mkdirSync(join(this.config.store.getChannelDir(channelId), "attachments"), { recursive: true });
			await writeFile(absolutePath, buffer);
			log.logInfo(
				`[${channelId}] Saved WhatsApp media: local=${localPath} bytes=${buffer.byteLength} source=${JSON.stringify(fileNameWithExt)}`,
			);

			return [{ original: fileNameWithExt, local: localPath }];
		} catch (err) {
			log.logWarning(
				`[${channelId}] Failed to download WhatsApp media`,
				`type=${mediaType} mimetype=${mimeType} filename=${JSON.stringify(originalFileName)}\n${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		}
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

	seedUsersFromLog(logPath: string): void {
		if (this.seededLogPaths.has(logPath)) return;
		this.seededLogPaths.add(logPath);
		if (!existsSync(logPath)) return;
		try {
			const lines = readFileSync(logPath, "utf-8").trim().split("\n");
			for (const line of lines) {
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as { user?: string; userName?: string; displayName?: string };
					if (!msg.user || msg.user === "bot" || !msg.userName) continue;
					const existing = this.users.get(msg.user);
					// Only update if the existing entry has a phone-number-only name
					if (!existing || existing.userName === existing.id.split("@")[0].split(":")[0]) {
						this.users.set(msg.user, {
							id: msg.user,
							userName: msg.userName,
							displayName: msg.displayName || msg.userName,
						});
					}
				} catch {
					// skip malformed lines
				}
			}
		} catch {
			// ignore read errors
		}
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

	private async extractMentionJids(text: string): Promise<string[]> {
		const mentions: string[] = [];
		const phoneRegex = /@(\d+)/g;
		let match: RegExpExecArray | null;
		while ((match = phoneRegex.exec(text)) !== null) {
			const phone = match[1];
			// Find user whose JID numeric prefix matches
			for (const user of this.users.values()) {
				const userPhone = user.id.split("@")[0].split(":")[0];
				if (userPhone === phone) {
					// Translate LID JIDs to phone JIDs so WA resolves the mention
					const resolved = await this.translateJid(user.id);
					mentions.push(resolved);
					break;
				}
			}
		}
		return mentions;
	}

	private async sendTextNow(jid: string, text: string): Promise<string> {
		if (!this.sock) throw new Error("WhatsApp socket not initialized");
		let lastError: Error | null = null;
		const outboundText = this.config.assistantHasOwnNumber ? text : `${this.config.botName}: ${text}`;
		const mentions = await this.extractMentionJids(outboundText);
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const sent = await this.sock.sendMessage(jid, {
					text: outboundText,
					...(mentions.length > 0 ? { mentions } : {}),
				});
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

