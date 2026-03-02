import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SOUL_TEMPLATE,
	appendMemoryBullet,
	ensureWorkspaceBootstrapFiles,
	getMemoryNotePath,
	getScopePath,
	listMemoryNotes,
	sanitizeMemoryNoteName,
	writeScopedText,
} from "./workspace-files.js";

test("workspace files support real owner actions for persona and note curation", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "mom-wa-workspace-files-"));
	try {
		const channelId = "1203@g.us";

		const globalSoulPath = getScopePath({ workingDir, channelId, scope: "global", kind: "soul" });
		await writeScopedText(globalSoulPath, "warm, witty, never robotic");
		assert.equal((await readFile(globalSoulPath, "utf-8")).trim(), "warm, witty, never robotic");

		const soulPath = getScopePath({ workingDir, channelId, scope: "channel", kind: "soul" });
		await writeScopedText(soulPath, "teasing is fine in this group, but no dogpiling");
		assert.equal((await readFile(soulPath, "utf-8")).trim(), "teasing is fine in this group, but no dogpiling");

		const memoryPath = getScopePath({ workingDir, channelId, scope: "global", kind: "memory" });
		await appendMemoryBullet(memoryPath, "likes concise replies");
		await appendMemoryBullet(memoryPath, "prefers lowercase");
		assert.equal(
			(await readFile(memoryPath, "utf-8")).trim(),
			["- likes concise replies", "- prefers lowercase"].join("\n"),
		);

		const notePath = getMemoryNotePath({
			workingDir,
			channelId,
			scope: "channel",
			noteName: "Running Jokes",
		});
		await writeScopedText(notePath, "ki = rizki\ndeadline means maybe next week");
		assert.equal(sanitizeMemoryNoteName("Running Jokes"), "running-jokes.md");
		assert.deepEqual(listMemoryNotes({ workingDir, channelId, scope: "channel" }), ["running-jokes.md"]);
		assert.equal(
			(await readFile(notePath, "utf-8")).trim(),
			["ki = rizki", "deadline means maybe next week"].join("\n"),
		);
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("workspace bootstrap creates a real default soul file and preserves custom edits", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "mom-wa-bootstrap-"));
	try {
		await ensureWorkspaceBootstrapFiles(workingDir);

		const soulPath = getScopePath({ workingDir, channelId: "unused", scope: "global", kind: "soul" });
		const createdSoul = await readFile(soulPath, "utf-8");
		assert.equal(createdSoul.trim(), DEFAULT_SOUL_TEMPLATE.trim());
		assert.match(createdSoul, /# SOUL\.md - Ujang/);
		assert.match(createdSoul, /Ujang is not polished\. Ujang is present\./);
		assert.match(createdSoul, /SOUL\.md = vibe and personality/);

		await writeScopedText(soulPath, "custom soul");
		await ensureWorkspaceBootstrapFiles(workingDir);

		const preservedSoul = await readFile(soulPath, "utf-8");
		assert.equal(preservedSoul.trim(), "custom soul");
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});
