import type { GroupHistoryEntry } from "./group-history.js";
import type { WhatsAppEvent } from "./whatsapp.js";

export function shouldClearPendingGroupHistory(
	event: WhatsAppEvent,
): event is WhatsAppEvent & { type: "mention"; source: "whatsapp"; pendingHistory: GroupHistoryEntry[] } {
	return (
		event.type === "mention" &&
		event.source === "whatsapp" &&
		Array.isArray(event.pendingHistory) &&
		event.pendingHistory.length > 0
	);
}
