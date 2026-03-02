import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, formatPendingHistoryPrompt, getMemory, getSoul } from "./agent.js";

test("prompt building loads global and channel soul plus bounded memory from real workspace files", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "ujang-wa-prompt-"));
	const channelId = "chat-42";
	const channelDir = join(workingDir, channelId);

	try {
		await mkdir(join(workingDir, "memory"), { recursive: true });
		await mkdir(join(channelDir, "memory"), { recursive: true });

		await writeFile(join(workingDir, "SOUL.md"), "global vibe: warm, dry, observant\n", "utf-8");
		await writeFile(join(channelDir, "SOUL.md"), "channel vibe: a bit more chaotic\n", "utf-8");
		await writeFile(join(workingDir, "MEMORY.md"), "- global memory fact\n", "utf-8");
		await writeFile(join(workingDir, "memory", "people.md"), "ki is rizki globally\n", "utf-8");
		await writeFile(join(channelDir, "MEMORY.md"), "- channel memory fact\n", "utf-8");
		await writeFile(join(channelDir, "memory", "jokes.md"), "deadline means maybe next week here\n", "utf-8");

		const soul = getSoul(channelDir);
		const memory = getMemory(channelDir);
		const prompt = buildSystemPrompt(
			"/workspace",
			channelId,
			soul,
			memory,
			{ type: "docker", container: "sandbox" },
			[{ id: channelId, name: "group-chat" }],
			[{ id: "628111@s.whatsapp.net", userName: "rizki", displayName: "Rizki" }],
			[],
		);

		assert.match(soul, /### Workspace Soul\nglobal vibe: warm, dry, observant/);
		assert.match(soul, /### Channel Soul\nchannel vibe: a bit more chaotic/);
		assert.match(memory, /### Global Workspace Memory\n- global memory fact/);
		assert.match(memory, /### Global Memory Note \(people\.md\)\nki is rizki globally/);
		assert.match(memory, /### Channel-Specific Memory\n- channel memory fact/);
		assert.match(memory, /### Channel Memory Note \(jokes\.md\)\ndeadline means maybe next week here/);
		assert.match(prompt, /You are ujang, a WhatsApp assistant\./);
		assert.match(prompt, /Use SOUL\.md as the main source of personality and social instinct\./);
		assert.match(prompt, /SOUL\.md is the personality source\. Embody it\./);
		assert.match(prompt, /memory_write: Persist an explicit remember request for this chat\./);
		assert.match(prompt, /Use tools directly when useful\. Do not narrate tool calls to the user\./);
		assert.doesNotMatch(prompt, /Donna from Suits/);
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("prompt loaders bound oversized soul and memory files instead of dumping the full workspace into context", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "ujang-wa-prompt-bounds-"));
	const channelId = "chat-bounds";
	const channelDir = join(workingDir, channelId);

	try {
		await mkdir(join(workingDir, "memory"), { recursive: true });
		await mkdir(channelDir, { recursive: true });

		const hugeSoul = `voice:${"x".repeat(5000)}`;
		const hugeMemory = `fact:${"y".repeat(3000)}`;

		await writeFile(join(workingDir, "SOUL.md"), hugeSoul, "utf-8");
		await writeFile(join(channelDir, "MEMORY.md"), hugeMemory, "utf-8");

		const soul = getSoul(channelDir);
		const memory = getMemory(channelDir);

		assert.ok(soul.length < 4300);
		assert.ok(memory.length < 1400);
		assert.match(soul, /\.\.\.$/);
		assert.match(memory, /\.\.\.$/);
		assert.doesNotMatch(soul, /x{4500}/);
		assert.doesNotMatch(memory, /y{2500}/);
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("prompt keeps personality compact so soul can dominate voice", () => {
	const prompt = buildSystemPrompt(
		"/workspace",
		"chat-compact",
		"",
		"(no working memory yet)",
		{ type: "docker", container: "sandbox" },
		[],
		[],
		[],
	);

	assert.match(prompt, /The built-in rules here are only guardrails\./);
	assert.ok(prompt.length < 17000);
	assert.doesNotMatch(prompt, /Never say: "let me know if you need anything else"/);
});

test("pending group history is threaded into the prompt wrapper before the current mention", () => {
	const prompt = formatPendingHistoryPrompt("2026-03-02 12:34:56+07:00", "Rizki", "wdyt", [
		{ userName: "Fara", text: "we should ship the settings fix first" },
		{ userName: "Ucup", text: "yeah and the migration is still risky" },
	]);

	assert.match(prompt, /^\[2026-03-02 12:34:56\+07:00\] \[Chat messages since your last reply - for context\]/);
	assert.match(prompt, /\[Fara\]: we should ship the settings fix first/);
	assert.match(prompt, /\[Ucup\]: yeah and the migration is still risky/);
	assert.match(prompt, /\[Current message - respond to this\]\n\[Rizki\]: wdyt$/);
});
