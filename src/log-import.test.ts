import assert from "node:assert/strict";
import test from "node:test";
import {
	buildImportedLogMessage,
	detectExportDateOrder,
	mergeImportedMessages,
	parseUtcOffsetMinutes,
	type ExportDateOrder,
} from "./log-import.js";
import type { DistilledMessage } from "./distill.js";
import type { LoggedMessage } from "./store.js";

function buildMessage(params: Partial<DistilledMessage> & Pick<DistilledMessage, "text" | "rawDate" | "rawTime">): DistilledMessage {
	return {
		author: params.author ?? null,
		text: params.text,
		rawDate: params.rawDate,
		rawTime: params.rawTime,
	};
}

function buildLoggedMessage(params: Partial<LoggedMessage> & Pick<LoggedMessage, "date" | "ts" | "text">): LoggedMessage {
	return {
		date: params.date,
		ts: params.ts,
		messageId: params.messageId,
		botMessageIds: params.botMessageIds,
		user: params.user ?? "user",
		userName: params.userName,
		displayName: params.displayName,
		text: params.text,
		attachments: params.attachments ?? [],
		isBot: params.isBot ?? false,
	};
}

test("detectExportDateOrder prefers DMY when the export contains unambiguous day-first dates", () => {
	const messages: DistilledMessage[] = [
		buildMessage({ author: "Contact A", rawDate: "16/05/23", rawTime: "21.38.55", text: "nomor lama q udh balik" }),
		buildMessage({ author: "Fadhil", rawDate: "18/03/26", rawTime: "12.52.28", text: "tes" }),
	];

	assert.equal(detectExportDateOrder(messages), "dmy");
});

test("buildImportedLogMessage converts iPhone export timestamps into UTC log entries and skips bot/system noise upstream", () => {
	const message = buildMessage({
		author: "Contact A",
		rawDate: "19/03/26",
		rawTime: "20.24.03",
		text: "@⁨Ujang Glowing Wand⁩ tanggapan tentang rehan dan piwly",
	});

	const imported = buildImportedLogMessage({
		message,
		dateOrder: "dmy",
		utcOffsetMinutes: parseUtcOffsetMinutes("+07:00"),
		stripLeadingMentionAuthors: ["Ujang Glowing Wand"],
	});

	assert.ok(imported);
	assert.equal(imported?.message.date, "2026-03-19T13:24:03.000Z");
	assert.equal(imported?.message.ts, "1773926643000");
	assert.equal(imported?.message.user, "export:contact-a");
	assert.equal(imported?.message.userName, "Contact A");
	assert.equal(imported?.message.text, "tanggapan tentang rehan dan piwly");
	assert.equal(imported?.message.isBot, false);
});

test("buildImportedLogMessage drops omitted media-only lines and edited markers", () => {
	const omitted = buildImportedLogMessage({
		message: buildMessage({ author: "Andre", rawDate: "18/03/26", rawTime: "12.00.00", text: "‎sticker omitted" }),
		dateOrder: "dmy",
		utcOffsetMinutes: 420,
	});
	assert.equal(omitted, null);

	const edited = buildImportedLogMessage({
		message: buildMessage({
			author: "Andre",
			rawDate: "18/03/26",
			rawTime: "12.00.00",
			text: "rehan kapak ke 2 ‎<This message was edited>",
		}),
		dateOrder: "dmy",
		utcOffsetMinutes: 420,
	});
	assert.equal(edited?.message.text, "rehan kapak ke 2");
});

test("mergeImportedMessages dedupes by timestamp plus text even when author labels differ", () => {
	const existingMessages: LoggedMessage[] = [
		buildLoggedMessage({
			date: "2026-03-19T13:24:03.000Z",
			ts: "1773926643000",
			user: "contact-a@s.whatsapp.net",
			userName: "Contact A",
			text: "@⁨Ujang Glowing Wand⁩ tanggapan tentang rehan dan piwly",
		}),
	];
	const importedMessages: LoggedMessage[] = [
		buildLoggedMessage({
			date: "2026-03-19T13:24:03.000Z",
			ts: "1773926643000",
			user: "export:contact-a",
			userName: "Contact Backup",
			text: "@⁨Ujang Glowing Wand⁩ tanggapan tentang rehan dan piwly",
		}),
		buildLoggedMessage({
			date: "2026-03-19T13:37:59.000Z",
			ts: "1773927479000",
			user: "export:fadhil-boneng",
			userName: "Fadhil Boneng",
			text: "mereka lagi seks brutal",
		}),
	];

	const merged = mergeImportedMessages({ existingMessages, importedMessages });

	assert.equal(merged.importedCount, 1);
	assert.equal(merged.skippedExistingCount, 1);
	assert.equal(merged.mergedMessages.length, 2);
	assert.equal(merged.mergedMessages[1]?.text, "mereka lagi seks brutal");
});

test("ExportDateOrder type remains explicit in tests", () => {
	const order: ExportDateOrder = "mdy";
	assert.equal(order, "mdy");
});
