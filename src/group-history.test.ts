import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendGroupHistoryEntry,
	hasPendingGroupHistoryMutationForTesting,
	loadGroupHistory,
	removeGroupHistoryEntries,
} from "./group-history.js";

test("removing consumed pending history preserves entries appended during the run", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "mom-wa-group-history-"));
	const channelDir = join(rootDir, "1203@g.us");

	try {
		await mkdir(channelDir, { recursive: true });
		const now = Date.now();

		const consumedEntries = [
			{
				messageId: "m1",
				ts: String(now - 3_000),
				user: "a@s.whatsapp.net",
				userName: "Rizki",
				text: "we should ship the settings fix first",
			},
			{
				messageId: "m2",
				ts: String(now - 2_000),
				user: "b@s.whatsapp.net",
				userName: "Fara",
				text: "yeah and the migration is still risky",
			},
		];
		for (const entry of consumedEntries) {
			await appendGroupHistoryEntry(channelDir, entry);
		}

		const appendedDuringRun = {
			messageId: "m3",
			ts: String(now - 1_000),
			user: "c@s.whatsapp.net",
			userName: "Ucup",
			text: "btw jangan lupa lock the rollout plan",
		};
		await appendGroupHistoryEntry(channelDir, appendedDuringRun);

		await removeGroupHistoryEntries(channelDir, consumedEntries);

		assert.deepEqual(loadGroupHistory(channelDir), [appendedDuringRun]);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});

test("concurrent appends keep every valid pending history entry", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "mom-wa-group-history-"));
	const channelDir = join(rootDir, "1203@g.us");

	try {
		await mkdir(channelDir, { recursive: true });
		const now = Date.now();
		const entries = [
			{
				messageId: "c1",
				ts: String(now - 3_000),
				user: "a@s.whatsapp.net",
				userName: "A",
				text: "first",
			},
			{
				messageId: "c2",
				ts: String(now - 2_000),
				user: "b@s.whatsapp.net",
				userName: "B",
				text: "second",
			},
		];

		await Promise.all(entries.map((entry) => appendGroupHistoryEntry(channelDir, entry)));

		assert.deepEqual(loadGroupHistory(channelDir), entries);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});

test("concurrent remove and append preserves entries appended after consumption snapshot", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "mom-wa-group-history-"));
	const channelDir = join(rootDir, "1203@g.us");

	try {
		await mkdir(channelDir, { recursive: true });
		const now = Date.now();
		const consumedEntries = [
			{
				messageId: "r1",
				ts: String(now - 3_000),
				user: "a@s.whatsapp.net",
				userName: "A",
				text: "old-1",
			},
			{
				messageId: "r2",
				ts: String(now - 2_000),
				user: "b@s.whatsapp.net",
				userName: "B",
				text: "old-2",
			},
		];
		for (const entry of consumedEntries) {
			await appendGroupHistoryEntry(channelDir, entry);
		}

		const appendedDuringRun = {
			messageId: "r3",
			ts: String(now - 1_000),
			user: "c@s.whatsapp.net",
			userName: "C",
			text: "fresh",
		};

		await Promise.all([
			removeGroupHistoryEntries(channelDir, consumedEntries),
			appendGroupHistoryEntry(channelDir, appendedDuringRun),
		]);

		assert.deepEqual(loadGroupHistory(channelDir), [appendedDuringRun]);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});

test("mutation queue entries are cleaned up after queued work settles", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "mom-wa-group-history-"));
	const channelDir = join(rootDir, "1203@g.us");

	try {
		await mkdir(channelDir, { recursive: true });
		const now = Date.now();
		const firstEntry = {
			messageId: "cleanup-1",
			ts: String(now - 2_000),
			user: "a@s.whatsapp.net",
			userName: "A",
			text: "first",
		};
		const secondEntry = {
			messageId: "cleanup-2",
			ts: String(now - 1_000),
			user: "b@s.whatsapp.net",
			userName: "B",
			text: "second",
		};

		assert.equal(hasPendingGroupHistoryMutationForTesting(channelDir), false);

		await Promise.all([
			appendGroupHistoryEntry(channelDir, firstEntry),
			appendGroupHistoryEntry(channelDir, secondEntry),
		]);

		assert.equal(hasPendingGroupHistoryMutationForTesting(channelDir), false);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});
