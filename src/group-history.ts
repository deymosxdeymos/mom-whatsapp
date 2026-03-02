import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

export interface GroupHistoryEntry {
	messageId?: string;
	ts: string;
	user: string;
	userName: string;
	text: string;
}

const GROUP_HISTORY_FILENAME = "pending-group-history.json";
const GROUP_HISTORY_MAX_ENTRIES = 40;
const GROUP_HISTORY_TTL_MS = 4 * 60 * 60 * 1000;

const mutationTails = new Map<string, Promise<void>>();

function resolveGroupHistoryPath(channelDir: string): string {
	return join(channelDir, GROUP_HISTORY_FILENAME);
}

function pruneEntries(entries: GroupHistoryEntry[], nowMs: number): GroupHistoryEntry[] {
	const minTs = nowMs - GROUP_HISTORY_TTL_MS;
	const deduped = new Map<string, GroupHistoryEntry>();

	for (const entry of entries) {
		const parsedTs = Number(entry.ts);
		if (!Number.isFinite(parsedTs) || parsedTs < minTs) {
			continue;
		}

		const key = entry.messageId?.trim() || `${entry.ts}:${entry.user}:${entry.text}`;
		deduped.set(key, entry);
	}

	return Array.from(deduped.values()).slice(-GROUP_HISTORY_MAX_ENTRIES);
}

function getEntryKey(entry: GroupHistoryEntry): string {
	return entry.messageId?.trim() || `${entry.ts}:${entry.user}:${entry.text}`;
}

export function loadGroupHistory(channelDir: string): GroupHistoryEntry[] {
	const path = resolveGroupHistoryPath(channelDir);
	if (!existsSync(path)) {
		return [];
	}

	try {
		const raw = readFileSync(path, "utf-8").trim();
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		const entries = parsed.filter((entry): entry is GroupHistoryEntry => {
			if (typeof entry !== "object" || entry === null) {
				return false;
			}
			const candidate = entry as Partial<GroupHistoryEntry>;
			return (
				typeof candidate.ts === "string" &&
				typeof candidate.user === "string" &&
				typeof candidate.userName === "string" &&
				typeof candidate.text === "string" &&
				(candidate.messageId === undefined || typeof candidate.messageId === "string")
			);
		});
		return pruneEntries(entries, Date.now());
	} catch {
		return [];
	}
}

async function writeGroupHistory(channelDir: string, entries: GroupHistoryEntry[]): Promise<void> {
	const path = resolveGroupHistoryPath(channelDir);
	await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
}

function enqueueMutation<T>(channelDir: string, mutation: () => Promise<T>): Promise<T> {
	const path = resolveGroupHistoryPath(channelDir);
	const tail = mutationTails.get(path) ?? Promise.resolve();
	let releaseTail: (() => void) | null = null;
	const nextTail = new Promise<void>((resolve) => {
		releaseTail = resolve;
	});
	const storedTail = tail.then(() => nextTail);
	mutationTails.set(path, storedTail);

	return tail
		.catch(() => undefined)
		.then(mutation)
		.finally(() => {
			releaseTail?.();
			if (mutationTails.get(path) === storedTail) {
				mutationTails.delete(path);
			}
		});
}

export function hasPendingGroupHistoryMutationForTesting(channelDir: string): boolean {
	return mutationTails.has(resolveGroupHistoryPath(channelDir));
}

export async function appendGroupHistoryEntry(channelDir: string, entry: GroupHistoryEntry): Promise<void> {
	await enqueueMutation(channelDir, async () => {
		const entries = loadGroupHistory(channelDir);
		entries.push(entry);
		await writeGroupHistory(channelDir, pruneEntries(entries, Date.now()));
	});
}

export async function removeGroupHistoryEntries(channelDir: string, entriesToRemove: GroupHistoryEntry[]): Promise<void> {
	if (entriesToRemove.length === 0) {
		return;
	}

	await enqueueMutation(channelDir, async () => {
		const removalKeys = new Set(entriesToRemove.map((entry) => getEntryKey(entry)));
		const remainingEntries = loadGroupHistory(channelDir).filter((entry) => !removalKeys.has(getEntryKey(entry)));
		await writeGroupHistory(channelDir, remainingEntries);
	});
}

export async function clearGroupHistory(channelDir: string): Promise<void> {
	await enqueueMutation(channelDir, async () => {
		await writeGroupHistory(channelDir, []);
	});
}
