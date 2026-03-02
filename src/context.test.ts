import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { syncLogToSessionManager } from "./context.js";

test("syncLogToSessionManager dedups legacy pending-history prompt entries against log messages", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "mom-wa-context-"));
	const channelDir = join(rootDir, "1203@g.us");
	const messageTs = Date.UTC(2026, 1, 27, 15, 4, 0);
	const messageText = "ship it tonight";

	try {
		await mkdir(channelDir, { recursive: true });
		await writeFile(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({
				date: new Date(messageTs).toISOString(),
				ts: String(messageTs),
				user: "a@s.whatsapp.net",
				userName: "Rizki",
				text: messageText,
			})}\n`,
			"utf-8",
		);

		const sessionManager = SessionManager.inMemory(channelDir);
		sessionManager.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: `[2026-02-27 22:04:00+07:00] [Chat messages since your last reply - for context]
[Fara]: we already have the checklist

[Current message - respond to this]
[Rizki]: ${messageText}`,
				},
			],
			timestamp: messageTs,
		});

		assert.equal(syncLogToSessionManager(sessionManager, channelDir), 0);
		assert.equal(sessionManager.buildSessionContext().messages.filter((message) => message.role === "user").length, 1);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});
