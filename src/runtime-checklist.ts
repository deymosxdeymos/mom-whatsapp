#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DisconnectReason,
	type proto,
	type useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import { createEventsWatcher } from "./events.js";
import { createExecutor, parseSandboxArg, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { formatVerboseDetailsMessage } from "./verbose.js";
import { type MomHandler, WhatsAppBot, type WhatsAppDependencies, type WhatsAppEvent } from "./whatsapp.js";

interface ChecklistResult {
	id: number;
	name: string;
	pass: boolean;
	evidence: string[];
	error?: string;
}

interface GroupMapEntry {
	subject?: string;
}

interface FakeSocketConfig {
	botJid: string;
	botLid?: string;
	groups?: Record<string, GroupMapEntry>;
	lidMappings?: Record<string, string>;
	autoOpen?: boolean;
}

class FakeSocket {
	public readonly ev = new EventEmitter();
	public readonly user: WASocket["user"];
	public readonly logger: WASocket["logger"];
	public readonly signalRepository: { lidMapping: { getPNForLID: (jid: string) => Promise<string | undefined> } };
	public readonly groups: Record<string, GroupMapEntry>;
	public readonly sendCalls: Array<{ jid: string; payload: Record<string, unknown> }> = [];
	public readonly presenceCalls: Array<{ presence: string; jid?: string }> = [];
	public failSendAttempts = 0;
	private messageCounter = 0;
	private autoOpen: boolean;

	constructor(config: FakeSocketConfig) {
		this.user = { id: config.botJid, lid: config.botLid } as unknown as WASocket["user"];
		this.logger = {} as WASocket["logger"];
		this.groups = config.groups || {};
		this.autoOpen = config.autoOpen ?? true;
		this.signalRepository = {
			lidMapping: {
				getPNForLID: async (jid: string) => config.lidMappings?.[jid],
			},
		};
	}

	onCreated(): void {
		if (this.autoOpen) {
			globalThis.setTimeout(() => {
				this.emitConnectionOpen();
			}, 0);
		}
	}

	async sendMessage(jid: string, payload: Record<string, unknown>): Promise<{ key: { id: string } }> {
		if (this.failSendAttempts > 0) {
			this.failSendAttempts--;
			throw new Error("Simulated send failure");
		}
		this.sendCalls.push({ jid, payload });
		this.messageCounter += 1;
		return { key: { id: `fake-msg-${this.messageCounter}` } };
	}

	async sendPresenceUpdate(presence: string, jid?: string): Promise<void> {
		this.presenceCalls.push({ presence, jid });
	}

	async groupFetchAllParticipating(): Promise<Record<string, GroupMapEntry>> {
		return this.groups;
	}

	async groupMetadata(jid: string): Promise<{ subject?: string }> {
		return { subject: this.groups[jid]?.subject };
	}

	async updateMediaMessage(): Promise<void> {
		return;
	}

	emitConnectionOpen(): void {
		this.ev.emit("connection.update", { connection: "open" });
	}

	emitConnectionClose(statusCode: number = DisconnectReason.connectionClosed): void {
		this.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode } } },
		});
	}

	emitCredsUpdate(): void {
		this.ev.emit("creds.update");
	}

	emitMessages(messages: WAMessage[]): void {
		this.ev.emit("messages.upsert", { type: "notify", messages });
	}
}

class FakeRuntimeDeps {
	public readonly createdSockets: FakeSocket[] = [];
	public readonly socketConfigs: Array<{ printQRInTerminal?: boolean; browser?: unknown }> = [];
	public readonly authLoadHasCreds: boolean[] = [];
	public readonly intervalCallbacks: Array<() => void> = [];
	private socketQueue: FakeSocket[] = [];

	enqueueSocket(socket: FakeSocket): void {
		this.socketQueue.push(socket);
	}

	createDeps(downloadMediaOverride?: (msg: WAMessage, _sock: WASocket) => Promise<Buffer>): WhatsAppDependencies {
		const deps: WhatsAppDependencies = {
			useAuthState: async (authDir: string) => {
				mkdirSync(authDir, { recursive: true });
				const credsPath = join(authDir, "creds.json");
				this.authLoadHasCreds.push(existsSync(credsPath));
				const state = {
					creds: {},
					keys: {
						get: async () => ({}),
						set: async () => undefined,
					},
				} as unknown as Awaited<ReturnType<typeof useMultiFileAuthState>>["state"];
				return {
					state,
					saveCreds: async () => {
						writeFileSync(credsPath, JSON.stringify({ savedAt: new Date().toISOString() }, null, 2), "utf-8");
					},
				};
			},
			makeSocket: (config) => {
				this.socketConfigs.push({
					printQRInTerminal: config.printQRInTerminal,
					browser: config.browser,
				});
				const socket =
					this.socketQueue.shift() ||
					new FakeSocket({
						botJid: "19999999999@s.whatsapp.net",
						botLid: "19999999999@lid",
						autoOpen: true,
					});
				this.createdSockets.push(socket);
				socket.onCreated();
				return socket as unknown as WASocket;
			},
			downloadMedia: async (msg, sock) => {
				if (downloadMediaOverride) {
					return downloadMediaOverride(msg, sock);
				}
				if (msg.message?.imageMessage) return Buffer.from("fake-image-bytes");
				if (msg.message?.videoMessage) return Buffer.from("fake-video-bytes");
				if (msg.message?.documentMessage) return Buffer.from("fake-document-bytes");
				return Buffer.from("fake-unknown-bytes");
			},
			setInterval: (fn) => {
				this.intervalCallbacks.push(fn);
				return globalThis.setTimeout(() => undefined, 0);
			},
			setTimeout: (fn) => globalThis.setTimeout(fn, 20),
		};
		return deps;
	}
}

class RecordingHandler implements MomHandler {
	public readonly events: WhatsAppEvent[] = [];
	public readonly stopRequests: string[] = [];
	private readonly running = new Set<string>();
	private readonly blockers = new Map<string, Promise<void>>();
	private readonly unblockers = new Map<string, () => void>();
	private autoReply: boolean;

	constructor(autoReply = false) {
		this.autoReply = autoReply;
	}

	blockChannel(channelId: string): void {
		let resolveBlock: (() => void) | null = null;
		const blocker = new Promise<void>((resolve) => {
			resolveBlock = resolve;
		});
		if (!resolveBlock) {
			throw new Error("Failed to initialize blocker");
		}
		this.blockers.set(channelId, blocker);
		this.unblockers.set(channelId, resolveBlock);
	}

	releaseChannel(channelId: string): void {
		const unblock = this.unblockers.get(channelId);
		if (unblock) {
			unblock();
			this.unblockers.delete(channelId);
			this.blockers.delete(channelId);
		}
	}

	isRunning(channelId: string): boolean {
		return this.running.has(channelId);
	}

	async handleStop(channelId: string, wa: WhatsAppBot): Promise<void> {
		this.stopRequests.push(channelId);
		this.running.delete(channelId);
		await wa.postMessage(channelId, "_Stopping..._");
	}

	async handleEvent(event: WhatsAppEvent, wa: WhatsAppBot): Promise<void> {
		this.events.push(event);
		this.running.add(event.channel);
		const blocker = this.blockers.get(event.channel);
		if (blocker) {
			await blocker;
		}
		if (this.autoReply) {
			const ts = await wa.postMessage(event.channel, `ack:${event.text}`);
			wa.logBotResponse(event.channel, `ack:${event.text}`, ts);
		}
		this.running.delete(event.channel);
	}
}

function mkWorkspace(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		globalThis.setTimeout(resolve, ms);
	});
}

async function waitFor(predicate: () => boolean, timeoutMs: number, errorMessage: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(errorMessage);
}

function dmMessage(params: {
	id: string;
	text?: string;
	channel: string;
	sender?: string;
	fromMe?: boolean;
	pushName?: string;
	message?: proto.IMessage;
	timestampSec?: number;
}): WAMessage {
	const ts = params.timestampSec ?? Math.floor((Date.now() + 2000) / 1000);
	return {
		key: {
			id: params.id,
			remoteJid: params.channel,
			fromMe: params.fromMe || false,
			participant: params.sender,
		},
		pushName: params.pushName || "alice",
		messageTimestamp: ts,
		message: params.message || { conversation: params.text || "" },
	} as unknown as WAMessage;
}

function groupMessage(params: {
	id: string;
	channel: string;
	sender: string;
	text: string;
	mentionBotJid?: string;
	timestampSec?: number;
}): WAMessage {
	const ts = params.timestampSec ?? Math.floor((Date.now() + 2000) / 1000);
	const message: proto.IMessage = params.mentionBotJid
		? {
				extendedTextMessage: {
					text: params.text,
					contextInfo: {
						mentionedJid: [params.mentionBotJid],
					},
				},
			}
		: { conversation: params.text };

	return {
		key: {
			id: params.id,
			remoteJid: params.channel,
			fromMe: false,
			participant: params.sender,
		},
		pushName: "group-user",
		messageTimestamp: ts,
		message,
	} as unknown as WAMessage;
}

function readLogLines(logPath: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function runCheck(id: number, name: string, runner: () => Promise<string[]>): Promise<ChecklistResult> {
	try {
		const evidence = await runner();
		return { id, name, pass: true, evidence };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { id, name, pass: false, evidence: [], error: message };
	}
}

async function checkStartupAuth(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-startup");
	const authDir = join(workspace, "auth");
	const store = new ChannelStore({ workingDir: workspace });

	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(
		new FakeSocket({ botJid: "19999999999@s.whatsapp.net", botLid: "19999999999@lid", autoOpen: true }),
	);
	depsRuntime.enqueueSocket(
		new FakeSocket({ botJid: "19999999999@s.whatsapp.net", botLid: "19999999999@lid", autoOpen: true }),
	);

	const handler1 = new RecordingHandler(false);
	const bot1 = new WhatsAppBot(handler1, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot1.start();

	const firstSocket = depsRuntime.createdSockets[0];
	firstSocket.emitCredsUpdate();
	await sleep(25);

	const credsPath = join(authDir, "creds.json");
	if (!existsSync(credsPath)) {
		throw new Error(`Auth creds file missing: ${credsPath}`);
	}

	const handler2 = new RecordingHandler(false);
	const bot2 = new WhatsAppBot(handler2, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot2.start();

	if (depsRuntime.socketConfigs.length < 2 || depsRuntime.socketConfigs.some((c) => c.printQRInTerminal !== false)) {
		throw new Error("Socket was not configured with printQRInTerminal=false");
	}

	if (depsRuntime.authLoadHasCreds.length < 2) {
		throw new Error("Auth state was not loaded twice");
	}

	if (depsRuntime.authLoadHasCreds[0] !== false || depsRuntime.authLoadHasCreds[1] !== true) {
		throw new Error(`Unexpected auth load sequence: ${JSON.stringify(depsRuntime.authLoadHasCreds)}`);
	}

	return [
		`auth creds persisted: ${credsPath}`,
		`auth load sequence: ${JSON.stringify(depsRuntime.authLoadHasCreds)}`,
		`printQRInTerminal configs: ${depsRuntime.socketConfigs.map((c) => c.printQRInTerminal).join(",")}`,
	];
}

async function checkDmFlow(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-dm");
	const authDir = join(workspace, "auth");
	const dmJid = "15550001111@s.whatsapp.net";

	const store = new ChannelStore({ workingDir: workspace });
	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(new FakeSocket({ botJid: "19999999999@s.whatsapp.net", autoOpen: true }));

	const handler = new RecordingHandler(true);
	handler.blockChannel(dmJid);

	const bot = new WhatsAppBot(handler, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot.start();

	const socket = depsRuntime.createdSockets[0];
	socket.emitMessages([
		dmMessage({
			id: "dm-normal-1",
			channel: dmJid,
			sender: dmJid,
			text: "run diagnostics",
			pushName: "alice",
			timestampSec: Math.floor((Date.now() + 2000) / 1000),
		}),
	]);

	await waitFor(() => handler.events.length === 1, 1000, "DM message did not trigger handler");
	if (!handler.isRunning(dmJid)) {
		throw new Error("Handler should be running before stop");
	}

	socket.emitMessages([
		dmMessage({
			id: "dm-stop-1",
			channel: dmJid,
			sender: dmJid,
			text: "stop",
			pushName: "alice",
			timestampSec: Math.floor((Date.now() + 3000) / 1000),
		}),
	]);
	await waitFor(() => handler.stopRequests.length === 1, 1000, "Stop request was not handled");

	handler.releaseChannel(dmJid);
	await waitFor(() => !handler.isRunning(dmJid), 1000, "Handler did not stop");

	const logPath = join(workspace, dmJid, "log.jsonl");
	const logLines = readLogLines(logPath);
	if (logLines.length < 2) {
		throw new Error(`Expected at least 2 log lines, got ${logLines.length}`);
	}
	if (!logLines.some((line) => line.includes("run diagnostics"))) {
		throw new Error("DM request was not logged");
	}
	if (!logLines.some((line) => line.includes('"text":"stop"'))) {
		throw new Error("Stop message was not logged");
	}

	return [
		`DM events: ${handler.events.map((e) => `${e.type}:${e.text}`).join(" | ")}`,
		`Stop calls: ${handler.stopRequests.join(",")}`,
		`log.jsonl: ${logPath}`,
		`log sample: ${logLines.slice(0, 2).join(" || ")}`,
	];
}

async function checkGroupTriggers(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-group");
	const authDir = join(workspace, "auth");
	const allowedByJid = "120300000001@g.us";
	const allowedByName = "120300000002@g.us";
	const blockedGroup = "120300000003@g.us";

	const store = new ChannelStore({ workingDir: workspace });
	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(
		new FakeSocket({
			botJid: "19999999999@s.whatsapp.net",
			autoOpen: true,
			groups: {
				[allowedByJid]: { subject: "General" },
				[allowedByName]: { subject: "Engineering Alpha" },
				[blockedGroup]: { subject: "Offtopic" },
			},
		}),
	);
	const handler = new RecordingHandler(false);

	const bot = new WhatsAppBot(handler, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [allowedByJid, "engineering"],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot.start();
	await sleep(30);

	const socket = depsRuntime.createdSockets[0];
	socket.emitMessages([
		groupMessage({
			id: "grp-allow-jid",
			channel: allowedByJid,
			sender: "15550002222@s.whatsapp.net",
			text: "@mom summarize this",
		}),
		groupMessage({
			id: "grp-allow-name",
			channel: allowedByName,
			sender: "15550003333@s.whatsapp.net",
			text: "please check",
			mentionBotJid: "19999999999@s.whatsapp.net",
		}),
		groupMessage({
			id: "grp-blocked",
			channel: blockedGroup,
			sender: "15550004444@s.whatsapp.net",
			text: "@mom this should be blocked",
		}),
	]);

	await waitFor(() => handler.events.length === 2, 1000, "Expected exactly 2 allowed group events");
	const eventChannels = handler.events.map((event) => event.channel);
	if (eventChannels.includes(blockedGroup)) {
		throw new Error("Blocked group was processed");
	}
	if (!eventChannels.includes(allowedByJid) || !eventChannels.includes(allowedByName)) {
		throw new Error(`Allowed group events missing: ${eventChannels.join(",")}`);
	}

	return [
		`processed group channels: ${eventChannels.join(",")}`,
		`blocked channel ignored: ${blockedGroup}`,
		`allowlist config: ${JSON.stringify([allowedByJid, "engineering"])}`,
	];
}

async function checkSharedNumberMode(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-shared");
	const authDir = join(workspace, "auth");
	const dmJid = "15550005555@s.whatsapp.net";

	const store = new ChannelStore({ workingDir: workspace });
	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(new FakeSocket({ botJid: "19999999999@s.whatsapp.net", autoOpen: true }));
	const handler = new RecordingHandler(false);

	const bot = new WhatsAppBot(handler, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: false,
		deps: depsRuntime.createDeps(),
	});
	await bot.start();

	const socket = depsRuntime.createdSockets[0];
	const outboundId = await bot.postMessage(dmJid, "hello shared-mode");

	socket.emitMessages([
		dmMessage({
			id: outboundId,
			channel: dmJid,
			fromMe: true,
			sender: dmJid,
			text: "mom: hello shared-mode",
		}),
		dmMessage({
			id: "loop-prefixed",
			channel: dmJid,
			fromMe: true,
			sender: dmJid,
			text: "mom: this should not retrigger",
		}),
		dmMessage({
			id: "human-shared-1",
			channel: dmJid,
			fromMe: true,
			sender: dmJid,
			text: "check this from shared number",
		}),
	]);

	await waitFor(() => handler.events.length === 1, 1000, "Shared-number user message did not trigger exactly once");

	const firstPayload = socket.sendCalls[0]?.payload;
	const sentText = typeof firstPayload?.text === "string" ? firstPayload.text : "";
	if (!sentText.startsWith("mom: ")) {
		throw new Error(`Shared mode outbound text not prefixed: ${JSON.stringify(firstPayload)}`);
	}

	if (handler.events[0].text !== "check this from shared number") {
		throw new Error(`Unexpected shared-number event text: ${handler.events[0].text}`);
	}

	return [
		`outbound prefixed text: ${sentText}`,
		`processed events count: ${handler.events.length}`,
		`processed shared-number event: ${handler.events[0].text}`,
	];
}

async function checkMediaIngestion(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-media");
	const authDir = join(workspace, "auth");
	const dmJid = "15550006666@s.whatsapp.net";

	const store = new ChannelStore({ workingDir: workspace });
	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(new FakeSocket({ botJid: "19999999999@s.whatsapp.net", autoOpen: true }));
	const handler = new RecordingHandler(false);

	const bot = new WhatsAppBot(handler, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot.start();

	const socket = depsRuntime.createdSockets[0];
	socket.emitMessages([
		dmMessage({
			id: "media-img",
			channel: dmJid,
			sender: dmJid,
			message: {
				imageMessage: {
					mimetype: "image/jpeg",
				},
			},
		}),
		dmMessage({
			id: "media-doc",
			channel: dmJid,
			sender: dmJid,
			message: {
				documentMessage: {
					mimetype: "application/pdf",
					fileName: "spec.pdf",
				},
			},
		}),
		dmMessage({
			id: "media-video",
			channel: dmJid,
			sender: dmJid,
			message: {
				videoMessage: {
					mimetype: "video/mp4",
				},
			},
		}),
	]);

	await waitFor(() => handler.events.length === 3, 1000, "Expected 3 media events");
	const attachmentPaths = handler.events.flatMap((event) => event.attachments?.map((a) => a.local) || []);
	if (attachmentPaths.length !== 3) {
		throw new Error(`Expected 3 saved attachments, got ${attachmentPaths.length}`);
	}

	for (const relativePath of attachmentPaths) {
		const absolutePath = join(workspace, relativePath);
		if (!existsSync(absolutePath)) {
			throw new Error(`Missing attachment file: ${absolutePath}`);
		}
	}

	if (!attachmentPaths.some((p) => p.endsWith(".jpg"))) {
		throw new Error(`Image attachment missing .jpg extension: ${attachmentPaths.join(",")}`);
	}
	if (!attachmentPaths.some((p) => p.endsWith("_spec.pdf"))) {
		throw new Error(`Document attachment missing filename: ${attachmentPaths.join(",")}`);
	}
	if (!attachmentPaths.some((p) => p.endsWith(".mp4"))) {
		throw new Error(`Video attachment missing .mp4 extension: ${attachmentPaths.join(",")}`);
	}
	if (!handler.events.every((event) => event.text === "Please analyze the attached files.")) {
		throw new Error(`Expected default media-only text, got: ${handler.events.map((e) => e.text).join(" | ")}`);
	}

	const logPath = join(workspace, dmJid, "log.jsonl");
	const logLines = readLogLines(logPath);
	if (!logLines.some((line) => line.includes('"attachments":[{'))) {
		throw new Error("Attachment metadata missing in log.jsonl");
	}

	return [
		`saved attachments: ${attachmentPaths.join(",")}`,
		`log with attachment metadata: ${logPath}`,
		`event payloads carry attachment locals (input to BotContext): ${handler.events
			.map((e) => (e.attachments?.[0] ? e.attachments[0].local : "none"))
			.join(",")}`,
	];
}

async function checkReconnectReliability(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-reconnect");
	const authDir = join(workspace, "auth");
	const dmJid = "15550007777@s.whatsapp.net";
	const queuedFile = join(workspace, "queued.txt");
	writeFileSync(queuedFile, "queued payload", "utf-8");

	const store = new ChannelStore({ workingDir: workspace });
	const depsRuntime = new FakeRuntimeDeps();
	depsRuntime.enqueueSocket(new FakeSocket({ botJid: "19999999999@s.whatsapp.net", autoOpen: true }));
	depsRuntime.enqueueSocket(new FakeSocket({ botJid: "19999999999@s.whatsapp.net", autoOpen: true }));
	const handler = new RecordingHandler(false);

	const bot = new WhatsAppBot(handler, {
		authDir,
		workingDir: workspace,
		store,
		botName: "mom",
		allowedGroups: [],
		assistantHasOwnNumber: true,
		deps: depsRuntime.createDeps(),
	});
	await bot.start();

	const socket1 = depsRuntime.createdSockets[0];
	socket1.emitConnectionClose();

	await bot.postMessage(dmJid, "queued-text-after-disconnect");
	await bot.uploadFile(dmJid, queuedFile, "queued-file-title");

	await waitFor(() => depsRuntime.createdSockets.length >= 2, 2000, "Reconnect socket was not created");
	const socket2 = depsRuntime.createdSockets[1];
	await waitFor(() => socket2.sendCalls.length >= 2, 2000, "Queued outbound items were not flushed");

	const textCall = socket2.sendCalls.find((c) => typeof c.payload.text === "string");
	const fileCall = socket2.sendCalls.find(
		(c) => "document" in c.payload || "image" in c.payload || "video" in c.payload,
	);
	if (!textCall) {
		throw new Error("Queued text message was not sent after reconnect");
	}
	if (!fileCall) {
		throw new Error("Queued file message was not sent after reconnect");
	}

	return [
		`socket1 send calls before reconnect: ${socket1.sendCalls.length}`,
		`socket2 flushed calls: ${socket2.sendCalls.length}`,
		`flushed text payload: ${JSON.stringify(textCall.payload)}`,
		`flushed file payload keys: ${Object.keys(fileCall.payload).join(",")}`,
	];
}

async function checkVerboseToggle(): Promise<string[]> {
	const disabled = formatVerboseDetailsMessage("tool output", false);
	const enabled = formatVerboseDetailsMessage("tool output", true);

	if (disabled !== null) {
		throw new Error(`Expected null when verbose disabled, got: ${disabled}`);
	}
	if (enabled !== "[details]\ntool output") {
		throw new Error(`Unexpected verbose formatting: ${enabled}`);
	}

	return [`verbose=0 => ${String(disabled)}`, `verbose=1 => ${enabled}`, `format function: src/verbose.ts`];
}

async function checkEvents(): Promise<string[]> {
	const workspace = mkWorkspace("mom-wa-events");
	const eventsDir = join(workspace, "events");
	mkdirSync(eventsDir, { recursive: true });

	const enqueuedEvents: WhatsAppEvent[] = [];
	const fakeWa = {
		enqueueEvent(event: WhatsAppEvent): boolean {
			enqueuedEvents.push(event);
			return true;
		},
	} as unknown as WhatsAppBot;

	const watcher = createEventsWatcher(workspace, fakeWa);
	watcher.start();

	const immediatePath = join(eventsDir, "immediate.json");
	writeFileSync(
		immediatePath,
		JSON.stringify({ type: "immediate", channelId: "15550001111@s.whatsapp.net", text: "now" }),
	);
	await waitFor(() => enqueuedEvents.length >= 1, 1000, "Immediate event did not fire");
	await waitFor(() => !existsSync(immediatePath), 1000, "Immediate event file was not deleted");

	const oneShotPath = join(eventsDir, "one-shot.json");
	const oneShotAt = new Date(Date.now() + 600).toISOString();
	writeFileSync(
		oneShotPath,
		JSON.stringify({
			type: "one-shot",
			channelId: "15550001111@s.whatsapp.net",
			text: "later",
			at: oneShotAt,
		}),
	);
	await waitFor(() => enqueuedEvents.length >= 2, 3000, "One-shot event did not fire");
	await waitFor(() => !existsSync(oneShotPath), 1000, "One-shot event file was not deleted");

	const periodicPath = join(eventsDir, "periodic.json");
	writeFileSync(
		periodicPath,
		JSON.stringify({
			type: "periodic",
			channelId: "15550001111@s.whatsapp.net",
			text: "tick",
			schedule: "* * * * * *",
			timezone: "UTC",
		}),
	);
	await waitFor(() => enqueuedEvents.length >= 3, 3000, "Periodic event did not fire");
	if (!existsSync(periodicPath)) {
		throw new Error("Periodic event file should persist after execution");
	}

	watcher.stop();

	return [
		`enqueued events: ${enqueuedEvents.map((event) => event.text).join(" | ")}`,
		`immediate deleted: ${!existsSync(immediatePath)}`,
		`one-shot deleted: ${!existsSync(oneShotPath)}`,
		`periodic persisted: ${existsSync(periodicPath)}`,
	];
}

async function checkSandbox(): Promise<string[]> {
	const container = `mom-wa-runtime-${Date.now()}`;

	let created = false;
	try {
		const create = spawnSync(
			"docker",
			["run", "-d", "--name", container, "alpine:latest", "tail", "-f", "/dev/null"],
			{ encoding: "utf-8" },
		);
		if (create.status !== 0) {
			throw new Error(`docker run failed: ${create.stderr || create.stdout}`.trim());
		}
		created = true;

		const sandboxConfig = parseSandboxArg(`docker:${container}`);
		await validateSandbox(sandboxConfig);
		const executor = createExecutor(sandboxConfig);

		const mkdirResult = await executor.exec("mkdir -p /workspace");
		if (mkdirResult.code !== 0) {
			throw new Error(`Failed to create /workspace: ${mkdirResult.stderr || mkdirResult.stdout}`);
		}

		const writeFirst = await executor.exec("echo first-line > /workspace/persist.txt");
		if (writeFirst.code !== 0) {
			throw new Error(`Failed writing first line: ${writeFirst.stderr || writeFirst.stdout}`);
		}

		const firstRead = await executor.exec("cat /workspace/persist.txt");
		if (firstRead.code !== 0) {
			throw new Error(`Failed reading first line: ${firstRead.stderr || firstRead.stdout}`);
		}
		if (!firstRead.stdout.includes("first-line")) {
			throw new Error(`Unexpected first read output: ${firstRead.stdout}`);
		}

		const writeSecond = await executor.exec("echo second-line >> /workspace/persist.txt");
		if (writeSecond.code !== 0) {
			throw new Error(`Failed writing second line: ${writeSecond.stderr || writeSecond.stdout}`);
		}

		const secondRead = await executor.exec("cat /workspace/persist.txt");
		if (secondRead.code !== 0) {
			throw new Error(`Failed reading persisted file: ${secondRead.stderr || secondRead.stdout}`);
		}
		if (!secondRead.stdout.includes("first-line") || !secondRead.stdout.includes("second-line")) {
			throw new Error(`Unexpected persisted output: ${secondRead.stdout}`);
		}

		return [
			`container: ${container}`,
			`first read: ${firstRead.stdout.trim()}`,
			`second read: ${secondRead.stdout.replace(/\n/g, "\\n").trim()}`,
			"persistence verified across docker exec calls inside same container",
		];
	} finally {
		if (created) {
			spawnSync("docker", ["rm", "-f", container], { encoding: "utf-8" });
		}
	}
}

function printResults(results: ChecklistResult[]): void {
	console.log("\nRuntime checklist results:\n");
	console.log("ID | Status | Check");
	console.log("---|--------|------");
	for (const result of results) {
		const status = result.pass ? "PASS" : "FAIL";
		console.log(`${result.id} | ${status} | ${result.name}`);
		if (result.pass) {
			for (const line of result.evidence) {
				console.log(`    - ${line}`);
			}
		} else {
			console.log(`    - error: ${result.error || "unknown error"}`);
		}
	}
}

async function main(): Promise<void> {
	const results: ChecklistResult[] = [];
	results.push(
		await runCheck(1, "Startup/auth (QR config + connect + auth persistence across restart)", checkStartupAuth),
	);
	results.push(await runCheck(2, "DM flow (request + stop/abort + logs)", checkDmFlow));
	results.push(
		await runCheck(3, "Group trigger flow (allowlist JID + name fragment + blocked group)", checkGroupTriggers),
	);
	results.push(
		await runCheck(4, "Shared-number mode (MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0, no loops)", checkSharedNumberMode),
	);
	results.push(
		await runCheck(5, "Media ingestion (image/doc/video saved + context attachment payload)", checkMediaIngestion),
	);
	results.push(await runCheck(6, "Reconnect reliability (offline queue + flush)", checkReconnectReliability));
	results.push(await runCheck(7, "Verbose detail toggle (MOM_WA_VERBOSE_DETAILS=0/1)", checkVerboseToggle));
	results.push(await runCheck(8, "Events (immediate, one-shot, periodic)", checkEvents));
	results.push(await runCheck(9, "Sandbox sanity (docker execution + persistence)", checkSandbox));

	printResults(results);

	const reportDir = join(process.cwd(), "runtime-checklist");
	mkdirSync(reportDir, { recursive: true });
	const reportPath = join(reportDir, `report-${Date.now()}.json`);
	writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf-8");
	console.log(`\nSaved report: ${reportPath}`);

	if (!results.every((result) => result.pass)) {
		process.exitCode = 1;
	}
}

await main();
