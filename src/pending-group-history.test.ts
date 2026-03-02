import assert from "node:assert/strict";
import test from "node:test";
import type { GroupHistoryEntry } from "./group-history.js";
import { shouldClearPendingGroupHistory } from "./pending-group-history.js";
import type { WhatsAppEvent } from "./whatsapp.js";

function buildEvent(overrides: Partial<WhatsAppEvent>): WhatsAppEvent {
	return {
		type: "mention",
		source: "whatsapp",
		channel: "1203@g.us",
		ts: String(Date.now()),
		user: "user@s.whatsapp.net",
		text: "hey",
		rawText: "hey",
		attachments: [],
		...overrides,
	};
}

const sampleHistory: GroupHistoryEntry[] = [
	{
		messageId: "m-1",
		ts: String(Date.now() - 2_000),
		user: "a@s.whatsapp.net",
		userName: "Rina",
		text: "context line",
	},
];

test("pending group history is cleared only for real whatsapp mention events that consumed history", () => {
	assert.equal(shouldClearPendingGroupHistory(buildEvent({ pendingHistory: sampleHistory })), true);
	assert.equal(
		shouldClearPendingGroupHistory(buildEvent({ source: "scheduled", pendingHistory: sampleHistory })),
		false,
	);
	assert.equal(shouldClearPendingGroupHistory(buildEvent({ pendingHistory: [] })), false);
	assert.equal(shouldClearPendingGroupHistory(buildEvent({ type: "dm", pendingHistory: sampleHistory })), false);
});
