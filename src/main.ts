#!/usr/bin/env node

// Default timezone to WIB (Asia/Jakarta) unless explicitly overridden
if (!process.env.TZ) {
	process.env.TZ = process.env.MOM_WA_TIMEZONE || "Asia/Jakarta";
}

import { existsSync } from "fs";
import { appendFile, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { buildArtifactUrl, getArtifactsBaseUrl, getArtifactsRoot } from "./artifacts.js";
import { type AgentRunner, getOrCreateRunner, type RunnerSessionStats, translateToHostPath } from "./agent.js";
import { type ChannelRuntime, getOrCreateChannelRuntime, runtimes } from "./channel-runtime.js";
import { createEventsWatcher } from "./events.js";
import { distillExportFileToWorkspace } from "./distill.js";
import { createIpcWatcher } from "./ipc.js";
import { normalizeWhatsAppJid } from "./jid.js";
import { parseModelSpecWithAliases } from "./model-aliases.js";
import { shouldClearPendingGroupHistory } from "./pending-group-history.js";
import type { GroupHistoryEntry } from "./group-history.js";
import * as log from "./log.js";
import {
	createImmediateTaskEvent,
	createOneShotTaskEvent,
	createPeriodicTaskEvent,
	deleteScheduledTask,
	getDefaultTaskTimezone,
	isValidTimezone,
	listScheduledTasks,
	listTaskFailures,
	listTaskHistory,
	pauseScheduledTask,
	resumeScheduledTask,
	validatePeriodicSchedule,
} from "./tasks.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { formatVerboseDetailsMessage, splitIntoBubbles, typingDelayMs } from "./render/index.js";
import { type MomHandler, type WhatsAppBot, WhatsAppBot as WhatsAppBotClass, type WhatsAppEvent } from "./whatsapp.js";
import {
	ensureWorkspaceBootstrapFiles,
} from "./workspace-files.js";
import { handleWorkspaceCommand } from "./workspace-commands.js";
import { sleep } from "./control-commands.js";

const MOM_WA_AUTH_DIR = process.env.MOM_WA_AUTH_DIR;
const MOM_WA_BOT_NAME = process.env.MOM_WA_BOT_NAME || "ujang";
const MOM_WA_ALLOWED_GROUPS = process.env.MOM_WA_ALLOWED_GROUPS;
const MOM_WA_GROUP_TRIGGER_ALIASES = (process.env.MOM_WA_GROUP_TRIGGER_ALIASES || "")
	.split(",")
	.map((value) => value.trim())
	.filter((value) => value.length > 0);
const MOM_WA_VERBOSE_DETAILS = process.env.MOM_WA_VERBOSE_DETAILS === "1";
const MOM_WA_ASSISTANT_HAS_OWN_NUMBER = process.env.MOM_WA_ASSISTANT_HAS_OWN_NUMBER !== "0";
const MOM_WA_RUN_TIMEOUT_MS = Number(process.env.MOM_WA_RUN_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min default

const RUN_MAX_RETRIES = 3;
const RUN_BASE_RETRY_MS = 5000; // 5s → 10s → 20s
const MOM_WA_OWNER_JIDS = new Set(
	(process.env.MOM_WA_OWNER_JIDS || "")
		.split(",")
		.map((value) => normalizeWhatsAppJid(value))
		.filter((value) => value.length > 0),
);

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	distillExportPath?: string;
	distillChannelId?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let distillExportPath: string | undefined;
	let distillChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--distill-export=")) {
			distillExportPath = resolve(arg.slice("--distill-export=".length));
		} else if (arg === "--distill-export") {
			distillExportPath = resolve(args[++i] || "");
		} else if (arg.startsWith("--distill-channel=")) {
			distillChannelId = arg.slice("--distill-channel=".length);
		} else if (arg === "--distill-channel") {
			distillChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		distillExportPath,
		distillChannelId,
	};
}

const parsedArgs = parseArgs();
if (!parsedArgs.workingDir) {
	console.error(
		"Usage: mom-whatsapp [--sandbox=host|docker:<name>] [--distill-export <path> --distill-channel <chat-jid>] <working-directory>",
	);
	process.exit(1);
}
if (parsedArgs.distillExportPath) {
	if (!parsedArgs.distillChannelId) {
		console.error("Missing required flag: --distill-channel <chat-jid>");
		process.exit(1);
	}
	await ensureWorkspaceBootstrapFiles(parsedArgs.workingDir);
	const summary = await distillExportFileToWorkspace({
		workingDir: parsedArgs.workingDir,
		channelId: parsedArgs.distillChannelId,
		exportPath: parsedArgs.distillExportPath,
	});
	console.log(
		[
			`Distilled ${summary.messageCount} messages from ${summary.participantCount} participants.`,
			`Wrote channel SOUL.md, MEMORY.md, and note files for ${parsedArgs.distillChannelId}.`,
			`Top participants: ${summary.topParticipants.join(", ") || "(none)"}`,
		].join("\n"),
	);
	process.exit(0);
}
if (!MOM_WA_AUTH_DIR) {
	console.error("Missing env: MOM_WA_AUTH_DIR");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
await validateSandbox(sandbox, workingDir);
await ensureWorkspaceBootstrapFiles(workingDir);

async function getRuntime(channelId: string): Promise<ChannelRuntime> {
	const channelDir = join(workingDir, channelId);
	return getOrCreateChannelRuntime(
		channelId,
		getOrCreateRunner(sandbox, channelId, channelDir),
		new ChannelStore({ workingDir }),
		workingDir,
	);
}

function parseCommand(text: string): { name: string; args: string[] } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("!") && !trimmed.startsWith("/")) return null;
	const withoutPrefix = trimmed.slice(1).trim();
	if (!withoutPrefix) return null;
	const parts = withoutPrefix.split(/\s+/);
	return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

function isOwnerJid(jid: string): boolean {
	if (MOM_WA_OWNER_JIDS.size === 0) return true;
	return MOM_WA_OWNER_JIDS.has(normalizeWhatsAppJid(jid));
}

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}

async function awaitRunTermination(
	channelId: string,
	runPromise: Promise<{ stopReason: string; errorMessage?: string }>,
	maxWaitMs = 5000,
): Promise<void> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const termination = await Promise.race([
			runPromise,
			new Promise<"timed_out">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timed_out"), maxWaitMs);
			}),
		]);

		if (termination === "timed_out") {
			log.logWarning(`[${channelId}] Run did not terminate within ${maxWaitMs}ms after abort`);
		}
	} catch (err) {
		log.logWarning(
			`[${channelId}] Run terminated with error after abort`,
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function isRateLimitErrorText(text: string | undefined): boolean {
	if (!text) return false;
	const normalized = text.toLowerCase();
	return normalized.includes("rate_limit") || normalized.includes("rate limit") || normalized.includes("429");
}

function formatSessionStatus(stats: RunnerSessionStats): string {
	return [
		"*Session status*",
		"Context file: hidden",
		`Context file exists: ${stats.contextFileExists ? "yes" : "no"}`,
		`Context file size: ${stats.contextFileSizeBytes} bytes`,
		`Context file modified: ${stats.contextFileLastModifiedIso || "(n/a)"}`,
		`Total entries: ${stats.totalEntries}`,
		`Context messages: ${stats.contextMessageCount}`,
	].join("\n");
}

function formatProvidersList(available: Array<{ provider: string; models: string[] }>): string {
	if (available.length === 0) {
		return "No providers with available API keys found.";
	}

	const lines: string[] = ["*Available providers & models*"];
	for (const entry of available) {
		lines.push(`${entry.provider} (${entry.models.length})`);
		for (const modelId of entry.models) {
			lines.push(`- ${entry.provider}/${modelId}`);
		}
		lines.push("");
	}

	if (lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines.join("\n");
}

function formatTaskHelp(defaultTimezone: string): string {
	return [
		"*Task commands*",
		"!task list",
		"!task now <text>  # owner",
		"!task once <ISO-8601-with-timezone> <text>  # owner",
		"!task every <min> <hour> <dom> <mon> <dow> <text>  # owner",
		"!task every <min> <hour> <dom> <mon> <dow> <text> --tz <IANA timezone>  # owner",
		"!task pause <task-id>  # owner",
		"!task resume <task-id>  # owner",
		"!task history <task-id> [limit]",
		"!task failures [limit]",
		"!task cancel <task-id>  # owner",
		`Default timezone: ${defaultTimezone}`,
	].join("\n");
}

interface ParsedPeriodicTaskArgs {
	schedule: string;
	timezone: string;
	text: string;
}

function parsePeriodicTaskArgs(args: string[]): { ok: true; value: ParsedPeriodicTaskArgs } | { ok: false; error: string } {
	if (args.length < 6) {
		return { ok: false, error: "Usage: !task every <min> <hour> <dom> <mon> <dow> <text> [--tz <timezone>]" };
	}

	const schedule = args.slice(0, 5).join(" ");
	const rest = args.slice(5);
	let timezone = getDefaultTaskTimezone();
	const textParts: string[] = [];

	for (let i = 0; i < rest.length; i += 1) {
		const part = rest[i];
		if (part === "--tz") {
			const next = rest[i + 1];
			if (!next) {
				return { ok: false, error: "Missing timezone after --tz" };
			}
			timezone = next;
			i += 1;
			continue;
		}
		textParts.push(part);
	}

	const text = textParts.join(" ").trim();
	if (!text) {
		return { ok: false, error: "Task text is required." };
	}

	return { ok: true, value: { schedule, timezone, text } };
}

function formatHelp(): string {
	return [
		"*Ujang command help*",
		"!help",
		"!stop                       # stop active run in this chat",
		"!status",
		"!providers                  # list providers and available models",
		"!model                       # show current model",
		"!model <provider/model>      # set model (owner)",
		"!thinking                    # show thinking level",
		"!thinking <off|minimal|low|medium|high|xhigh>  # set (owner)",
		"!remember <text>",
		"!remember --global <text>    # owner",
		"!memory show [global|channel]",
		"!memory add <text>",
		"!memory add --global <text>  # owner",
		"!soul show [global|channel]",
		"!soul set <text>",
		"!soul set --global <text>    # owner",
		"!note list [global|channel]",
		"!note show [global|channel] <name>",
		"!note add <name> <text>",
		"!note add --global <name> <text>  # owner",
		"!task list",
		"!task now <text>                # owner",
		"!task once <ISO time> <text>    # owner",
		"!task every <min> <hour> <dom> <mon> <dow> <text> [--tz timezone]  # owner",
		"!task pause <task-id>           # owner",
		"!task resume <task-id>          # owner",
		"!task history <task-id> [limit]",
		"!task failures [limit]",
		"!task cancel <task-id>          # owner",
		"!session status",
		"!session reset                 # owner",
		"!artifact status",
		"!artifact link <path>",
		"!artifact live <path>        # add ?ws=true",
	].join("\n");
}

async function handleCommand(event: WhatsAppEvent, runtime: ChannelRuntime, wa: WhatsAppBot): Promise<boolean> {
	const command = parseCommand(event.text);
	if (!command) return false;

	if (command.name === "help") {
		await wa.postMessage(event.channel, formatHelp());
		return true;
	}

	if (command.name === "status") {
		const model = runtime.runner.getModel();
		const thinking = runtime.runner.getThinkingLevel();
		const ownerScoped = MOM_WA_OWNER_JIDS.size > 0;
		const artifactBaseUrl = await getArtifactsBaseUrl();
		const status = [
			"*Ujang status*",
			`Connected: ${wa.isConnected() ? "yes" : "no"}`,
			`Sandbox: ${sandbox.type === "docker" ? `docker:${sandbox.container}` : "host"}`,
			`Model: ${model.provider}/${model.modelId}`,
			`Thinking: ${thinking}`,
			`Verbose details: ${MOM_WA_VERBOSE_DETAILS ? "on" : "off"}`,
			`Queued outbound: ${wa.getOutgoingQueueSize()}`,
			`Artifacts URL: ${artifactBaseUrl || "(not configured)"}`,
			ownerScoped ? `Owner controls: enabled (${MOM_WA_OWNER_JIDS.size} jid)` : "Owner controls: disabled",
		].join("\n");
		await wa.postMessage(event.channel, status);
		return true;
	}

	if (command.name === "providers" || command.name === "models") {
		try {
			const available = await runtime.runner.getAvailableProviderModels();
			await wa.postMessage(event.channel, formatProvidersList(available));
		} catch (err) {
			await wa.postMessage(event.channel, `_Failed to list providers:_ ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	if (command.name === "model") {
		if (command.args.length === 0) {
			const current = runtime.runner.getModel();
			await wa.postMessage(event.channel, `Model: ${current.provider}/${current.modelId}`);
			return true;
		}
		if (!isOwnerJid(event.user)) {
			await wa.postMessage(event.channel, "_Only configured owner JIDs can change model._");
			return true;
		}
		const resolvedSpec = parseModelSpecWithAliases(command.args[0], {
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		try {
			const updated = runtime.runner.setModel(resolvedSpec.provider, resolvedSpec.modelId);
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
			await wa.postMessage(event.channel, `Thinking: ${runtime.runner.getThinkingLevel()}`);
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
		runtime.runner.setThinkingLevel(level as Parameters<AgentRunner["setThinkingLevel"]>[0]);
		await wa.postMessage(event.channel, `Thinking set: ${level}`);
		return true;
	}

	if (
		await handleWorkspaceCommand(command, event, runtime, wa, {
			workingDir,
			isOwnerJid,
		})
	) {
		return true;
	}

	if (command.name === "task" || command.name === "tasks") {
		const sub = command.args[0]?.toLowerCase() || "help";
		const defaultTimezone = getDefaultTaskTimezone();

		if (sub === "help") {
			await wa.postMessage(event.channel, formatTaskHelp(defaultTimezone));
			return true;
		}

		if (sub === "list") {
			const tasks = await listScheduledTasks(workingDir, event.channel);
			if (tasks.length === 0) {
				await wa.postMessage(event.channel, "No scheduled tasks for this chat.");
				return true;
			}

			const lines: string[] = ["*Scheduled tasks*", `Count: ${tasks.length}`];
			for (const task of tasks) {
				const runInfo =
					task.lastRunAtIso === null
						? "last: never"
						: `last: ${task.lastRunAtIso} (${task.lastRunStatus || "unknown"})`;

				if (task.event.type === "immediate") {
					lines.push(`- ${task.id} | immediate | ${task.status} | ${runInfo}`);
					lines.push(`  ${truncateText(task.event.text, 120)}`);
					continue;
				}

				if (task.event.type === "one-shot") {
					lines.push(
						`- ${task.id} | once | ${task.status} | at: ${task.event.at} | runs: ${task.runCount} | ${runInfo}`,
					);
					if (task.lastRunError) {
						lines.push(`  error: ${truncateText(task.lastRunError, 80)}`);
					}
					lines.push(`  ${truncateText(task.event.text, 120)}`);
					continue;
				}

				lines.push(
					`- ${task.id} | periodic | ${task.status} | ${task.event.schedule} | ${task.event.timezone} | next: ${task.nextRunIso || "unknown"} | runs: ${task.runCount} | ${runInfo}`,
				);
				if (task.lastRunError) {
					lines.push(`  error: ${truncateText(task.lastRunError, 80)}`);
				}
				lines.push(`  ${truncateText(task.event.text, 120)}`);
			}
			await wa.postMessage(event.channel, lines.join("\n"));
			return true;
		}

		if (sub === "now") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can create tasks._");
				return true;
			}
			const text = command.args.slice(1).join(" ").trim();
			if (!text) {
				await wa.postMessage(event.channel, "_Usage: !task now <text>_");
				return true;
			}
			const created = await createImmediateTaskEvent(workingDir, event.channel, text);
			await wa.postMessage(event.channel, `Task queued: ${created.id}`);
			return true;
		}

		if (sub === "once") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can create tasks._");
				return true;
			}
			if (command.args.length < 3) {
				await wa.postMessage(event.channel, "_Usage: !task once <ISO-8601-with-timezone> <text>_");
				return true;
			}
			const at = command.args[1];
			const text = command.args.slice(2).join(" ").trim();
			if (!/(Z|[+-]\d{2}:\d{2})$/i.test(at)) {
				await wa.postMessage(event.channel, "_Timestamp must include timezone offset (e.g. +01:00 or Z)._");
				return true;
			}
			const atTime = new Date(at).getTime();
			if (!Number.isFinite(atTime)) {
				await wa.postMessage(event.channel, "_Invalid timestamp. Use ISO-8601 format._");
				return true;
			}
			if (atTime <= Date.now()) {
				await wa.postMessage(event.channel, "_Timestamp must be in the future._");
				return true;
			}
			if (!text) {
				await wa.postMessage(event.channel, "_Task text is required._");
				return true;
			}
			const created = await createOneShotTaskEvent(workingDir, event.channel, text, at);
			await wa.postMessage(event.channel, `One-shot task created: ${created.id}\nRuns at: ${at}`);
			return true;
		}

		if (sub === "every") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can create tasks._");
				return true;
			}
			const parsed = parsePeriodicTaskArgs(command.args.slice(1));
			if (!parsed.ok) {
				await wa.postMessage(event.channel, `_` + parsed.error + `_`);
				return true;
			}

			if (!isValidTimezone(parsed.value.timezone)) {
				await wa.postMessage(event.channel, `_Invalid timezone: ${parsed.value.timezone}_`);
				return true;
			}

			const validation = validatePeriodicSchedule(parsed.value.schedule, parsed.value.timezone);
			if (!validation.ok) {
				await wa.postMessage(event.channel, `_Invalid cron schedule: ${validation.error || "unknown error"}_`);
				return true;
			}

			const created = await createPeriodicTaskEvent(
				workingDir,
				event.channel,
				parsed.value.text,
				parsed.value.schedule,
				parsed.value.timezone,
			);
			await wa.postMessage(
				event.channel,
				[
					`Periodic task created: ${created.id}`,
					`Schedule: ${parsed.value.schedule}`,
					`Timezone: ${parsed.value.timezone}`,
					`Next run: ${validation.nextRunIso || "unknown"}`,
				].join("\n"),
			);
			return true;
		}

		if (sub === "pause") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can pause tasks._");
				return true;
			}
			const identifier = command.args[1]?.trim();
			if (!identifier) {
				await wa.postMessage(event.channel, "_Usage: !task pause <task-id>_");
				return true;
			}
			const result = await pauseScheduledTask(workingDir, event.channel, identifier);
			if (!result.ok) {
				await wa.postMessage(event.channel, `_Failed to pause task:_ ${result.error}`);
				return true;
			}
			await wa.postMessage(event.channel, `Task paused: ${result.filename.replace(/\.json$/i, "")}`);
			return true;
		}

		if (sub === "resume") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can resume tasks._");
				return true;
			}
			const identifier = command.args[1]?.trim();
			if (!identifier) {
				await wa.postMessage(event.channel, "_Usage: !task resume <task-id>_");
				return true;
			}
			const result = await resumeScheduledTask(workingDir, event.channel, identifier);
			if (!result.ok) {
				await wa.postMessage(event.channel, `_Failed to resume task:_ ${result.error}`);
				return true;
			}
			await wa.postMessage(event.channel, `Task resumed: ${result.filename.replace(/\.json$/i, "")}`);
			return true;
		}

		if (sub === "history") {
			const identifier = command.args[1]?.trim();
			if (!identifier) {
				await wa.postMessage(event.channel, "_Usage: !task history <task-id> [limit]_");
				return true;
			}

			const parsedLimit = command.args[2] ? Number(command.args[2]) : 10;
			const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 10;
			const history = await listTaskHistory(workingDir, event.channel, identifier, limit);
			if (!history.ok) {
				await wa.postMessage(event.channel, `_Failed to read task history:_ ${history.error}`);
				return true;
			}
			if (history.records.length === 0) {
				await wa.postMessage(event.channel, `No run history for task: ${history.taskId}`);
				return true;
			}

			const lines: string[] = [
				`*Task history*`,
				`Task: ${history.taskId}`,
				`Entries: ${history.records.length}`,
			];
			for (const record of history.records) {
				const durationSec = (record.durationMs / 1000).toFixed(2);
				lines.push(`- ${record.runAtIso} | ${record.status} | ${durationSec}s`);
				if (record.error) {
					lines.push(`  ${truncateText(record.error, 120)}`);
				}
			}
			await wa.postMessage(event.channel, lines.join("\n"));
			return true;
		}

		if (sub === "failures") {
			const parsedLimit = command.args[1] ? Number(command.args[1]) : 10;
			const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 10;
			const failures = await listTaskFailures(workingDir, event.channel, limit);
			if (failures.length === 0) {
				await wa.postMessage(event.channel, "No task failures recorded for this chat.");
				return true;
			}

			const lines: string[] = ["*Task failures*", `Entries: ${failures.length}`];
			for (const failure of failures) {
				const durationSec = (failure.durationMs / 1000).toFixed(2);
				lines.push(`- ${failure.taskId} | ${failure.runAtIso} | ${durationSec}s`);
				if (failure.error) {
					lines.push(`  ${truncateText(failure.error, 120)}`);
				}
			}
			await wa.postMessage(event.channel, lines.join("\n"));
			return true;
		}

		if (sub === "cancel" || sub === "delete" || sub === "rm") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can cancel tasks._");
				return true;
			}
			const identifier = command.args[1]?.trim();
			if (!identifier) {
				await wa.postMessage(event.channel, "_Usage: !task cancel <task-id>_");
				return true;
			}
			const result = await deleteScheduledTask(workingDir, event.channel, identifier);
			if (!result.ok) {
				await wa.postMessage(event.channel, `_Failed to cancel task:_ ${result.error}`);
				return true;
			}
			await wa.postMessage(event.channel, `Task cancelled: ${result.filename.replace(/\.json$/i, "")}`);
			return true;
		}

		await wa.postMessage(event.channel, formatTaskHelp(defaultTimezone));
		return true;
	}

	if (command.name === "session") {
		const sub = command.args[0]?.toLowerCase() || "status";
		if (sub === "status") {
			await wa.postMessage(event.channel, formatSessionStatus(runtime.runner.getSessionStats()));
			return true;
		}
		if (sub === "reset") {
			if (!isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can reset session context._");
				return true;
			}
			const result = runtime.runner.resetSession();
			await wa.postMessage(
				event.channel,
				`Session reset. Previous entry count: ${result.previousEntryCount}. Next messages start a fresh context.`,
			);
			return true;
		}
		await wa.postMessage(event.channel, "_Usage: !session status | !session reset_");
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
					resolvedArtifactPath = translateToHostPath(requestedPath, runtime.store.getChannelDir(event.channel), "/workspace");
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

function createWhatsAppContext(
	event: WhatsAppEvent,
	wa: WhatsAppBot,
	runtime: ChannelRuntime,
	hooks?: { onOutput?: () => void; onToolExecution?: () => void },
) {
	// Seed display names from the channel log so users who haven't messaged this
	// session still appear with their real names (not just phone numbers).
	const logPath = join(runtime.store.getChannelDir(event.channel), "log.jsonl");
	wa.seedUsersFromLog(logPath);

	const user = wa.getUser(event.user);
	let lastMessageTs: string | null = null;
	// Track the full logical text last sent to detect duplicates across bubble splits.
	// Only updated when shouldLog=true (real responses, not tool progress labels).
	let logicalLastSentText: string | null = null;

	// Send text as one or more chat bubbles, with a realistic typing delay between them.
	// The model uses \n---\n as a separator to mark natural bubble boundaries.
	const sendBubbles = async (text: string, shouldLog: boolean): Promise<void> => {
		const bubbles = splitIntoBubbles(text);
		const sentMessageIds: string[] = [];
		for (let i = 0; i < bubbles.length; i++) {
			if (i > 0) {
				const delayMs = typingDelayMs(bubbles[i - 1]);
				if (delayMs > 0) {
					await wa.setTyping(event.channel, true);
					await sleep(delayMs);
				}
			}
			const sentMessageId = await wa.postMessage(event.channel, bubbles[i]);
			lastMessageTs = sentMessageId;
			sentMessageIds.push(sentMessageId);
		}
		if (shouldLog && sentMessageIds.length > 0) {
			wa.logBotResponse(event.channel, text, sentMessageIds);
			logicalLastSentText = text;
			hooks?.onOutput?.();
		}
	};

	return {
		message: {
			text: event.text,
			rawText: event.rawText,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			pendingHistory: event.pendingHistory,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: wa.getChannel(event.channel)?.name,
		store: runtime.store,
		channels: wa.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: wa.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			await sendBubbles(text, shouldLog);
		},

		replaceMessage: async (text: string) => {
			// WhatsApp doesn't support message edits. Skip if the logical content was
			// already sent (e.g. agent's message_end already delivered all bubbles).
			if (logicalLastSentText === text) return;
			const bubbles = splitIntoBubbles(text);
			for (let i = 0; i < bubbles.length; i++) {
				if (i > 0) {
					const delayMs = typingDelayMs(bubbles[i - 1]);
					if (delayMs > 0) {
						await wa.setTyping(event.channel, true);
						await sleep(delayMs);
					}
				}
				lastMessageTs = await wa.postMessage(event.channel, bubbles[i]);
			}
			logicalLastSentText = text;
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

		markToolExecution: () => {
			hooks?.onToolExecution?.();
		},
	};
}

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const runtime = runtimes.get(channelId);
		return runtime?.isRunning ?? false;
	},

	async handleStop(channelId: string, wa: WhatsAppBot): Promise<void> {
		const runtime = runtimes.get(channelId);
		if (runtime?.isRunning) {
			runtime.stopRequested = true;
			runtime.runner.abort();
			await wa.postMessage(channelId, "_Stopping..._");
		} else {
			await wa.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: WhatsAppEvent, wa: WhatsAppBot): Promise<void> {
		const runtime = await getRuntime(event.channel);
		const commandHandled = await handleCommand(event, runtime, wa);
		if (commandHandled) {
			if (shouldClearPendingGroupHistory(event)) {
				await runtime.clearPendingHistory(event.pendingHistory);
			}
			return;
		}

		const react = async (emoji: string) => {
			if (!event.messageKey) return;
			await wa.reactToMessage(event.channel, event.messageKey, emoji);
		};

		runtime.running = true;
		runtime.stopRequested = false;
		let consumedPendingGroupHistory: GroupHistoryEntry[] = [];

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		await react("⏳");

		const retryCheckpoint = runtime.runner.createCheckpoint();
		const rollbackBeforeRetry = (): boolean => {
			try {
				runtime.runner.restoreCheckpoint(retryCheckpoint);
				return true;
			} catch (err) {
				log.logWarning(
					`[${event.channel}] Failed to restore runner state before retry`,
					err instanceof Error ? err.message : String(err),
				);
				return false;
			}
		};

		let attempt = 0;
		while (attempt < RUN_MAX_RETRIES) {
			attempt++;
			let ctx: ReturnType<typeof createWhatsAppContext> | undefined;
			let outputSentToUser = false;
			let hadToolExecution = false;
			let timedOut = false;
			let runPromise: Promise<{ stopReason: string; errorMessage?: string }> | null = null;

			try {
				ctx = createWhatsAppContext(event, wa, runtime, {
					onOutput: () => {
						outputSentToUser = true;
					},
					onToolExecution: () => {
						hadToolExecution = true;
					},
				});
				await ctx.setTyping(true);
				await ctx.setWorking(true);

				// Race the run against a hard timeout — prevents the bot getting stuck forever.
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				runPromise = runtime.runner.run(ctx, runtime.store);
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						runtime.runner.abort();
						reject(new Error(`timed out after ${MOM_WA_RUN_TIMEOUT_MS / 1000}s`));
					}, MOM_WA_RUN_TIMEOUT_MS);
				});

				let result: { stopReason: string; errorMessage?: string };
				try {
					result = await Promise.race([runPromise, timeoutPromise]);
				} finally {
					clearTimeout(timeoutHandle);
				}

				if (timedOut) {
					log.logWarning(`[${event.channel}] Run timed out (attempt ${attempt})`);
					if (!outputSentToUser) {
						await wa.postMessage(event.channel, "took too long, try again");
					}
					await react("❌");
					break;
				}

				if (result.stopReason === "aborted" && runtime.stopRequested) {
					await wa.postMessage(event.channel, "stopped");
					await react("⏹️");
					break;
				}

				if (result.stopReason === "error") {
					const isRateLimit = isRateLimitErrorText(result.errorMessage);
					// Retry only before user-visible output and before any tool execution.
					// This avoids re-running non-idempotent tool actions after partial progress.
					if (!outputSentToUser && !hadToolExecution && !runtime.stopRequested && !isRateLimit && attempt < RUN_MAX_RETRIES) {
						if (!rollbackBeforeRetry()) {
							if (!outputSentToUser && !runtime.stopRequested) {
								await wa.postMessage(event.channel, "something went wrong, try again");
							}
							await react("❌");
							break;
						}
						const delayMs = RUN_BASE_RETRY_MS * Math.pow(2, attempt - 1);
						log.logWarning(
							`[${event.channel}] Run failed (attempt ${attempt}/${RUN_MAX_RETRIES}), retrying in ${delayMs}ms: ${result.errorMessage}`,
						);
						await sleep(delayMs);
						continue;
					}
					if (!outputSentToUser && !runtime.stopRequested) {
						await wa.postMessage(event.channel, isRateLimit ? "api lagi padat, coba lagi bentar" : "something went wrong, try again");
					}
					await react("❌");
					break;
				}

				consumedPendingGroupHistory = shouldClearPendingGroupHistory(event) ? event.pendingHistory : [];
				await react("✅");
				break;
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);

				if (timedOut) {
					if (runPromise) {
						await awaitRunTermination(event.channel, runPromise);
					}
					log.logWarning(`[${event.channel}] Run timed out (attempt ${attempt})`);
					if (!outputSentToUser) {
						await wa.postMessage(event.channel, "took too long, try again");
					}
					await react("❌");
					break;
				}

				log.logWarning(`[${event.channel}] Run error (attempt ${attempt}/${RUN_MAX_RETRIES})`, errMsg);
				const isRateLimit = isRateLimitErrorText(errMsg);

				if (!outputSentToUser && !hadToolExecution && !runtime.stopRequested && !isRateLimit && attempt < RUN_MAX_RETRIES) {
					if (!rollbackBeforeRetry()) {
						if (!outputSentToUser && !runtime.stopRequested) {
							await wa.postMessage(event.channel, "something went wrong, try again");
						}
						await react("❌");
						break;
					}
					const delayMs = RUN_BASE_RETRY_MS * Math.pow(2, attempt - 1);
					log.logWarning(`[${event.channel}] Retrying in ${delayMs}ms`);
					await sleep(delayMs);
					continue;
				}

				if (!outputSentToUser) {
					await wa.postMessage(event.channel, isRateLimit ? "api lagi padat, coba lagi bentar" : "something went wrong, try again");
				}
				await react("❌");
				break;
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
			}
		}

		if (consumedPendingGroupHistory.length > 0) {
			await runtime.clearPendingHistory(consumedPendingGroupHistory);
		}

		runtime.running = false;
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
	groupTriggerAliases: MOM_WA_GROUP_TRIGGER_ALIASES,
});

const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

const ipcWatcher = createIpcWatcher(workingDir, bot);
ipcWatcher.start();

function shutdown(): void {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	ipcWatcher.stop();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
	await bot.start();
} catch (err) {
	log.logWarning("Failed to start WhatsApp bot", err instanceof Error ? err.message : String(err));
	process.exit(1);
}
