import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertLlmOutputToFiles, distillChatExport, distillExportFileToWorkspace, parseWhatsAppExport } from "./distill.js";

const REALISTIC_GROUP_EXPORT = `[2/27/26, 10:01 PM] Rizki: gas aja besok
[2/27/26, 10:02 PM] Ucup: anjir lu tiap bilang besok padahal ga mulai2
[2/27/26, 10:02 PM] Fara: wkwk iya lagi
[2/27/26, 10:03 PM] Rizki: serius kali ini
[2/27/26, 10:03 PM] Ucup: deadline means maybe next week
[2/27/26, 10:04 PM] Fara: gas aja besok
[2/27/26, 10:05 PM] Rizki: ki siap ngerjain backend
[2/27/26, 10:05 PM] Ujang: ki = rizki ya berarti
[2/27/26, 10:05 PM] Fara: iya jir
[2/27/26, 10:06 PM] Ucup: anjir emang
[2/27/26, 10:07 PM] Rizki: btw jangan vn pls
[2/27/26, 10:08 PM] Fara: noted
[2/27/26, 10:09 PM] Ucup: gue lanjut besok pagi
biar otak ga bengek
[2/27/26, 10:10 PM] Messages to this group are now secured with end-to-end encryption.
[2/28/26, 8:11 AM] Rizki: gas aja besok`;

const REALISTIC_IPHONE_EXPORT = `\u200e[10/08/19, 10.35.57] Calon Penghuni GGP: Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.
\u200e[16/05/23, 21.38.54] Contact A: nomor lama q udh balik
\u200e[16/05/23, 21.39.14] Fadhil Aprilian: Siapa ini
\u200e[16/05/23, 21.39.30] Contact A: siapa hayo
\u200e[16/05/23, 21.40.19] Contact A: parah ga save nomor lama berarti
\u200e[16/05/23, 21.41.48] Contact A: ilang semua memek`;

test("distillation parses a realistic exported group chat and writes usable workspace files", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "mom-wa-distill-"));
	const exportPath = join(workingDir, "group-export.txt");
	const channelId = "1203@g.us";

	try {
		await writeFile(exportPath, REALISTIC_GROUP_EXPORT, "utf-8");

		const parsed = parseWhatsAppExport(REALISTIC_GROUP_EXPORT);
		assert.equal(parsed.length, 15);
		assert.equal(parsed[12]?.author, "Ucup");
		assert.match(parsed[12]?.text ?? "", /gue lanjut besok pagi\nbiar otak ga bengek/);

		const distilled = distillChatExport(REALISTIC_GROUP_EXPORT);
		assert.match(distilled.soul, /The room is casual, fast, and conversational/);
		assert.match(distilled.soul, /Most active in this export: Rizki, Ucup, Fara, Ujang/);
		assert.match(distilled.memory, /Distilled from 14 messages across 4 participants/);
		assert.match(distilled.memory, /gas aja besok \(3x\)/);
		assert.equal(distilled.notes.some((note) => note.name === "people.md"), true);
		assert.equal(distilled.notes.some((note) => note.name === "running-jokes.md"), true);

		const summary = await distillExportFileToWorkspace({
			workingDir,
			channelId,
			exportPath,
		});
		assert.equal(summary.messageCount, 14);
		assert.deepEqual(summary.topParticipants.slice(0, 4), ["Rizki", "Ucup", "Fara", "Ujang"]);

		const soul = await readFile(join(workingDir, channelId, "SOUL.md"), "utf-8");
		const memory = await readFile(join(workingDir, channelId, "MEMORY.md"), "utf-8");
		const people = await readFile(join(workingDir, channelId, "memory", "people.md"), "utf-8");
		const jokes = await readFile(join(workingDir, channelId, "memory", "running-jokes.md"), "utf-8");

		assert.match(soul, /Dry observations land better than over-explaining/);
		assert.match(memory, /Most active speakers in this export: Rizki, Ucup, Fara, Ujang/);
		assert.match(people, /## Rizki/);
		assert.match(people, /## Ucup/);
		assert.match(jokes, /gas aja besok \(3x\)/);
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("distillation export removes stale generated notes without touching manual notes", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "mom-wa-distill-cleanup-"));
	const exportPath = join(workingDir, "group-export.txt");
	const channelId = "1203@g.us";

	try {
		await writeFile(exportPath, REALISTIC_GROUP_EXPORT, "utf-8");
		await distillExportFileToWorkspace({
			workingDir,
			channelId,
			exportPath,
		});

		const staleNotePath = join(workingDir, channelId, "memory", "running-jokes.md");
		const manualNotePath = join(workingDir, channelId, "memory", "project-plan.md");
		await writeFile(manualNotePath, "# Keep this\n", "utf-8");
		const rewrittenExport = `[2/27/26, 10:01 PM] Rizki: halo
[2/27/26, 10:02 PM] Ucup: halo juga`;
		await writeFile(exportPath, rewrittenExport, "utf-8");
		await distillExportFileToWorkspace({
			workingDir,
			channelId,
			exportPath,
			useLlm: false,
		});

		await assert.rejects(readFile(staleNotePath, "utf-8"));
		const people = await readFile(join(workingDir, channelId, "memory", "people.md"), "utf-8");
		const manualNote = await readFile(manualNotePath, "utf-8");
		assert.match(people, /## Rizki/);
		assert.match(manualNote, /Keep this/);
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("LLM distillation falls back to heuristic people note when the model returns an empty one", () => {
	const fallback = distillChatExport(REALISTIC_GROUP_EXPORT);
	const converted = convertLlmOutputToFiles(
		{
			soul: "",
			memoryBullets: [],
			peopleNote: "",
			runningJokes: null,
		},
		fallback,
	);

	assert.equal(converted.notes.find((note) => note.name === "people.md")?.content, fallback.notes.find((note) => note.name === "people.md")?.content);
	assert.equal(converted.notes.some((note) => note.name === "running-jokes.md"), false);
});

test("distillation parser supports real iPhone WhatsApp export timestamps with dot-separated time", () => {
	const parsed = parseWhatsAppExport(REALISTIC_IPHONE_EXPORT);

	assert.equal(parsed.length, 6);
	assert.equal(parsed[0]?.author, "Calon Penghuni GGP");
	assert.equal(parsed[0]?.rawTime, "10.35.57");
	assert.equal(parsed[1]?.author, "Contact A");
	assert.match(parsed[5]?.text ?? "", /ilang semua memek/);

	const distilled = distillChatExport(REALISTIC_IPHONE_EXPORT);
	assert.match(distilled.memory, /Distilled from 6 messages across 3 participants/);
});
