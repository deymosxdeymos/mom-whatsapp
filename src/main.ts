#!/usr/bin/env node

import { existsSync } from "fs";
import { appendFile, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { buildArtifactUrl, getArtifactsBaseUrl, getArtifactsRoot } from "./artifacts.js";
import { type AgentRunner, getOrCreateRunner, translateToHostPath } from "./agent.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { formatVerboseDetailsMessage } from "./verbose.js";
import { type MomHandler, type WhatsAppBot, WhatsAppBot as WhatsAppBotClass, type WhatsAppEvent } from "./whatsapp.js";

const MOM_WA_AUTH_DIR = process.env.MOM_WA_AUTH_DIR;
const MOM_WA_BOT_NAME = process.env.MOM_WA_BOT_NAME || "mom";
const MOM_WA_ALLOWED_GROUPS = process.env.MOM_WA_ALLOWED_GROUPS;
const MOM_WA_VERBOSE_DETAILS = process.env.MOM_WA_VERBOSE_DETAILS === "1";
const MOM_WA_ASSISTANT_HAS_OWN_NUMBER = process.env.MOM_WA_ASSISTANT_HAS_OWN_NUMBER !== "0";
const MOM_WA_OWNER_JIDS = (process.env.MOM_WA_OWNER_JIDS || "")
	.split(",")
	.map((v) => v.trim().toLowerCase())
	.filter(Boolean);

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
	};
}

const parsedArgs = parseArgs();
if (!parsedArgs.workingDir) {
	console.error("Usage: mom-whatsapp [--sandbox=host|docker:<name>] <working-directory>");
	process.exit(1);
}
if (!MOM_WA_AUTH_DIR) {
	console.error("Missing env: MOM_WA_AUTH_DIR");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
await validateSandbox(sandbox);

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

function getWorkspaceMemoryPath(): string {
	return join(workingDir, "MEMORY.md");
}

function getChannelMemoryPath(channelId: string): string {
	return join(workingDir, channelId, "MEMORY.md");
}

function parseCommand(text: string): { name: string; args: string[] } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("!") && !trimmed.startsWith("/")) return null;
	const withoutPrefix = trimmed.slice(1).trim();
	if (!withoutPrefix) return null;
	const parts = withoutPrefix.split(/\s+/);
	return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

function normalizeJid(jid: string): string {
	return jid.trim().toLowerCase();
}

function isOwnerJid(jid: string): boolean {
	if (MOM_WA_OWNER_JIDS.length === 0) return true;
	return MOM_WA_OWNER_JIDS.includes(normalizeJid(jid));
}

function formatHelp(): string {
	return [
		"*Mom command help*",
		"!help",
		"!stop                       # stop active run in this chat",
		"!status",
		"!model                       # show current model",
		"!model <provider/model>      # set model (owner)",
		"!thinking                    # show thinking level",
		"!thinking <off|minimal|low|medium|high|xhigh>  # set (owner)",
		"!memory show [global|channel]",
		"!memory add <text>",
		"!memory add --global <text>  # owner",
		"!artifact status",
		"!artifact link <path>",
		"!artifact live <path>        # add ?ws=true",
	].join("\n");
}

async function handleCommand(event: WhatsAppEvent, state: ChannelState, wa: WhatsAppBot): Promise<boolean> {
	const command = parseCommand(event.text);
	if (!command) return false;

	if (command.name === "help") {
		await wa.postMessage(event.channel, formatHelp());
		return true;
	}

	if (command.name === "status") {
		const model = state.runner.getModel();
		const thinking = state.runner.getThinkingLevel();
		const ownerScoped = MOM_WA_OWNER_JIDS.length > 0;
		const artifactBaseUrl = await getArtifactsBaseUrl();
		const status = [
			"*Mom status*",
			`Connected: ${wa.isConnected() ? "yes" : "no"}`,
			`Sandbox: ${sandbox.type === "docker" ? `docker:${sandbox.container}` : "host"}`,
			`Model: ${model.provider}/${model.modelId}`,
			`Thinking: ${thinking}`,
			`Verbose details: ${MOM_WA_VERBOSE_DETAILS ? "on" : "off"}`,
			`Queued outbound: ${wa.getOutgoingQueueSize()}`,
			`Artifacts URL: ${artifactBaseUrl || "(not configured)"}`,
			ownerScoped ? `Owner controls: enabled (${MOM_WA_OWNER_JIDS.length} jid)` : "Owner controls: disabled",
		].join("\n");
		await wa.postMessage(event.channel, status);
		return true;
	}

	if (command.name === "model") {
		if (command.args.length === 0) {
			const current = state.runner.getModel();
			await wa.postMessage(event.channel, `Model: ${current.provider}/${current.modelId}`);
			return true;
		}
		if (!isOwnerJid(event.user)) {
			await wa.postMessage(event.channel, "_Only configured owner JIDs can change model._");
			return true;
		}
		const [provider, ...rest] = command.args[0].split("/");
		const hasProvider = rest.length > 0;
		const resolvedProvider = hasProvider ? provider : "anthropic";
		const resolvedModel = hasProvider ? rest.join("/") : provider;
		try {
			const updated = state.runner.setModel(resolvedProvider, resolvedModel);
			await wa.postMessage(event.channel, `Model set: ${updated.provider}/${updated.modelId}`);
		} catch (err) {
			await wa.postMessage(
				event.channel,
				`_Failed to set model:_ ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return true;
	}

	if (command.name === "thinking") {
		if (command.args.length === 0) {
			await wa.postMessage(event.channel, `Thinking: ${state.runner.getThinkingLevel()}`);
			return true;
		}
		if (!isOwnerJid(event.user)) {
			await wa.postMessage(event.channel, "_Only configured owner JIDs can change thinking level._");
			return true;
		}
		const level = command.args[0].toLowerCase();
		const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
		if (!allowed.has(level)) {
			await wa.postMessage(event.channel, "_Invalid thinking level. Use off|minimal|low|medium|high|xhigh_");
			return true;
		}
		state.runner.setThinkingLevel(level as Parameters<AgentRunner["setThinkingLevel"]>[0]);
		await wa.postMessage(event.channel, `Thinking set: ${level}`);
		return true;
	}

	if (command.name === "memory") {
		if (command.args.length === 0) {
			await wa.postMessage(event.channel, "Usage: !memory show [global|channel] | !memory add [--global] <text>");
			return true;
		}
		const sub = command.args[0].toLowerCase();
		if (sub === "show") {
			const scope = command.args[1]?.toLowerCase() === "global" ? "global" : "channel";
			if (scope === "channel") {
				state.store.getChannelDir(event.channel);
			}
			const path = scope === "global" ? getWorkspaceMemoryPath() : getChannelMemoryPath(event.channel);
			if (!existsSync(path)) {
				await wa.postMessage(event.channel, `Memory (${scope}) is empty.`);
				return true;
			}
			const content = (await readFile(path, "utf-8")).trim();
			await wa.postMessage(
				event.channel,
				content ? `Memory (${scope}):\n${content}` : `Memory (${scope}) is empty.`,
			);
			return true;
		}
		if (sub === "add") {
			const globalFlag = command.args[1] === "--global";
			if (globalFlag && !isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can modify global memory._");
				return true;
			}
			const text = (globalFlag ? command.args.slice(2) : command.args.slice(1)).join(" ").trim();
			if (!text) {
				await wa.postMessage(event.channel, "_Usage: !memory add [--global] <text>_");
				return true;
			}
			const scope = globalFlag ? "global" : "channel";
			if (scope === "channel") {
				state.store.getChannelDir(event.channel);
			}
			const path = scope === "global" ? getWorkspaceMemoryPath() : getChannelMemoryPath(event.channel);
			const existing = existsSync(path) ? await readFile(path, "utf-8") : "";
			const line = `- ${text}`;
			if (existing.trim().length === 0) {
				await writeFile(path, `${line}\n`, "utf-8");
			} else {
				await appendFile(path, `${line}\n`, "utf-8");
			}
			await wa.postMessage(event.channel, `Added to ${scope} memory.`);
			return true;
		}
		await wa.postMessage(event.channel, "_Unknown memory command. Use show/add._");
		return true;
	}

	if (command.name === "artifact" || command.name === "artifacts") {
		const sub = command.args[0]?.toLowerCase() || "status";
		if (sub === "status") {
			const root = getArtifactsRoot(workingDir);
			const baseUrl = await getArtifactsBaseUrl();
			const status = [
				"*Artifacts status*",
				`Root: ${root}`,
				`Base URL: ${baseUrl || "(not configured)"}`,
				"Usage:",
				"!artifact link <path>",
				"!artifact live <path>",
			].join("\n");
			await wa.postMessage(event.channel, status);
			return true;
		}

		if (sub === "link" || sub === "live") {
			const requestedPath = command.args.slice(1).join(" ").trim();
			if (!requestedPath) {
				await wa.postMessage(event.channel, "_Usage: !artifact link <path> | !artifact live <path>_");
				return true;
			}

			let resolvedArtifactPath = requestedPath;
			const normalizedRequestedPath = requestedPath.replace(/\\/g, "/");
			if (sandbox.type === "docker" && normalizedRequestedPath.startsWith("/workspace")) {
				try {
					resolvedArtifactPath = translateToHostPath(requestedPath, state.store.getChannelDir(event.channel), "/workspace");
				} catch (err) {
					await wa.postMessage(
						event.channel,
						`_Artifact URL error:_ [ARTIFACT_PATH_TRANSLATION_FAILED] ${err instanceof Error ? err.message : String(err)}`,
					);
					return true;
				}
			}

			const result = await buildArtifactUrl({
				workspaceDir: workingDir,
				path: resolvedArtifactPath,
				liveReload: sub === "live",
			});
			if (!result.ok) {
				await wa.postMessage(event.channel, `_Artifact URL error:_ ${result.error}`);
				return true;
			}

			await wa.postMessage(event.channel, `Artifact URL (${result.relativePath}): ${result.url}`);
			return true;
		}

		await wa.postMessage(event.channel, "_Unknown artifact command. Use status|link|live._");
		return true;
	}

	await wa.postMessage(event.channel, "_Unknown command. Use !help._");
	return true;
}

function createWhatsAppContext(event: WhatsAppEvent, wa: WhatsAppBot, state: ChannelState) {
	const user = wa.getUser(event.user);
	let lastMessageTs: string | null = null;
	let lastMainMessageText: string | null = null;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: wa.getChannel(event.channel)?.name,
		store: state.store,
		channels: wa.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: wa.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			lastMessageTs = await wa.postMessage(event.channel, text);
			lastMainMessageText = text;
			if (shouldLog) {
				wa.logBotResponse(event.channel, text, lastMessageTs);
			}
		},

		replaceMessage: async (text: string) => {
			// WhatsApp doesn't support message updates; avoid duplicating the final reply.
			if (lastMainMessageText === text) return;
			lastMessageTs = await wa.postMessage(event.channel, text);
			lastMainMessageText = text;
		},

		respondInThread: async (text: string) => {
			const detailsMessage = formatVerboseDetailsMessage(text, MOM_WA_VERBOSE_DETAILS);
			if (!detailsMessage) return;
			lastMessageTs = await wa.postMessage(event.channel, detailsMessage);
		},

		setTyping: async (isTyping: boolean) => {
			await wa.setTyping(event.channel, isTyping);
		},

		uploadFile: async (filePath: string, title?: string) => {
			await wa.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			await wa.setTyping(event.channel, working);
		},

		deleteMessage: async () => {
			if (lastMessageTs) {
				await wa.deleteMessage(event.channel, lastMessageTs);
			}
			log.logInfo(`deleteMessage requested but WhatsApp delete is a no-op (${event.channel})`);
		},
	};
}

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, wa: WhatsAppBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			await wa.postMessage(channelId, "_Stopping..._");
		} else {
			await wa.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: WhatsAppEvent, wa: WhatsAppBot): Promise<void> {
		const state = getState(event.channel);
		const commandHandled = await handleCommand(event, state, wa);
		if (commandHandled) {
			return;
		}

		const react = async (emoji: string) => {
			if (!event.messageKey) return;
			await wa.reactToMessage(event.channel, event.messageKey, emoji);
		};

		state.running = true;
		state.stopRequested = false;
		let ctx: ReturnType<typeof createWhatsAppContext> | undefined;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			await react("⏳");
			ctx = createWhatsAppContext(event, wa, state);
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx, state.store);

			if (result.stopReason === "aborted" && state.stopRequested) {
				await wa.postMessage(event.channel, "_Stopped_");
				await react("⏹️");
			} else {
				await react("✅");
			}
		} catch (err) {
			await react("❌");
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			if (ctx) {
				try {
					await ctx.setWorking(false);
				} catch (err) {
					log.logWarning(
						`[${event.channel}] Failed to clear typing state`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}
			state.running = false;
		}
	},
};

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

const sharedStore = new ChannelStore({ workingDir });

const bot = new WhatsAppBotClass(handler, {
	authDir: MOM_WA_AUTH_DIR,
	workingDir,
	store: sharedStore,
	botName: MOM_WA_BOT_NAME,
	allowedGroups: MOM_WA_ALLOWED_GROUPS
		? MOM_WA_ALLOWED_GROUPS.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [],
	assistantHasOwnNumber: MOM_WA_ASSISTANT_HAS_OWN_NUMBER,
});

const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

await bot.start();
