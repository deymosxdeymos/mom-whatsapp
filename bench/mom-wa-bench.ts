import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { buildSystemPrompt, getMemory, getOrCreateRunner, getSoul } from "../src/agent.ts";
import { ChannelStore } from "../src/store.ts";
import type { BotContext } from "../src/whatsapp.ts";

const workspaceDir = "/home/deymos/clones/mom-whatsapp/live-data";
const sourceChannel = "bench-source@s.whatsapp.net";
const sourceDir = join(workspaceDir, sourceChannel);
const ts = Date.now();
const largeChannel = `bench-large-${ts}`;
const emptyChannel = `bench-empty-${ts}`;
const largeDir = join(workspaceDir, largeChannel);
const emptyDir = join(workspaceDir, emptyChannel);
const store = new ChannelStore({ workingDir: workspaceDir });
const sandbox = { type: "docker", container: "mom-whatsapp-sandbox" } as const;
const prompt = "pakai bash, jalankan pwd, lalu jawab singkat hasilnya";

async function measureLocalPrep(channelId: string, channelDir: string) {
	const contextFile = join(channelDir, "context.jsonl");
	const t0 = Date.now();
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const t1 = Date.now();
	const session = sessionManager.buildSessionContext();
	const t2 = Date.now();
	const soul = getSoul(channelDir);
	const memory = getMemory(channelDir);
	const promptStart = Date.now();
	const systemPrompt = buildSystemPrompt("/workspace", channelId, soul, memory, sandbox, [], [], []);
	const promptEnd = Date.now();
	const stats = existsSync(contextFile) ? await stat(contextFile) : null;
	return {
		openMs: t1 - t0,
		buildSessionMs: t2 - t1,
		contextMessages: session.messages.length,
		contextBytes: stats?.size ?? 0,
		promptMs: promptEnd - promptStart,
		systemPromptChars: systemPrompt.length,
		memoryChars: memory.length,
	};
}

function makeCtx(channelId: string, startedAt: number): BotContext {
	const log = (kind: string, text: string) => {
		const delta = Date.now() - startedAt;
		console.log(`[ctx ${channelId}] ${kind} @ ${delta}ms: ${text.slice(0, 160).replace(/\n/g, " \\n ")}`);
	};

	return {
		message: {
			text: prompt,
			rawText: prompt,
			user: "bench-user",
			userName: "bench",
			channel: channelId,
			ts: String(Date.now()),
			attachments: [],
		},
		channelName: "bench",
		channels: [],
		users: [],
		respond: async (text) => {
			log("respond", text);
		},
		replaceMessage: async (text) => {
			log("replace", text);
		},
		respondInThread: async (text) => {
			log("thread", text);
		},
		setTyping: async () => {},
		uploadFile: async () => {},
		setWorking: async () => {},
		deleteMessage: async () => {
			log("delete", "[delete]");
		},
		markToolExecution: () => {
			log("tool", "[tool execution]");
		},
	};
}

async function runCase(label: string, channelId: string, channelDir: string) {
	const prep = await measureLocalPrep(channelId, channelDir);
	console.log(`CASE ${label} prep ${JSON.stringify(prep)}`);
	const runner = getOrCreateRunner(sandbox, channelId, channelDir);
	const startedAt = Date.now();
	console.log(`CASE ${label} run_start ${startedAt}`);
	const result = await runner.run(makeCtx(channelId, startedAt), store);
	const totalMs = Date.now() - startedAt;
	console.log(`CASE ${label} result ${JSON.stringify({ totalMs, result, stats: runner.getSessionStats() })}`);
}

async function main() {
	await rm(largeDir, { recursive: true, force: true });
	await rm(emptyDir, { recursive: true, force: true });
	await cp(sourceDir, largeDir, { recursive: true });
	await mkdir(emptyDir, { recursive: true });

	try {
		await runCase("large", largeChannel, largeDir);
		await runCase("empty", emptyChannel, emptyDir);
	} finally {
		await rm(largeDir, { recursive: true, force: true });
		await rm(emptyDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
