// Workspace lock — prevents concurrent processes from operating on the same workspace.
// Adapted from pi-chat's acquireConversationLock / releaseConversationLock.

import { open, readFile, unlink, writeFile } from "node:fs/promises";

function extractOwnerPid(owner: string): number | undefined {
	const match = owner.match(/^mom-whatsapp-(\d+)-/);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isFinite(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: string }).code)
			: undefined;
		return code === "EPERM";
	}
}

function makeOwner(): string {
	return `mom-whatsapp-${process.pid}-${Date.now()}`;
}

export async function acquireLock(lockPath: string): Promise<void> {
	try {
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(`${makeOwner()}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: string }).code)
			: undefined;
		if (code !== "EEXIST") throw error;
	}

	const existingOwner = (await readFile(lockPath, "utf8")).trim();
	const existingPid = extractOwnerPid(existingOwner);
	if (existingPid !== undefined && !isPidAlive(existingPid)) {
		await unlink(lockPath).catch(() => undefined);
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(`${makeOwner()}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	}
	throw new Error(`Workspace is already locked by ${existingOwner || "another process"}`);
}

export async function releaseLock(lockPath: string): Promise<void> {
	await unlink(lockPath).catch(() => undefined);
}
