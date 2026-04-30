// Trigger detection utilities for WhatsApp messages.
// Extracted from src/whatsapp.ts.

import type { proto } from "@whiskeysockets/baileys";
import { escapeRegex } from "../control-commands.js";
import { normalizeWhatsAppJid } from "../jid.js";
import { extractJidUserPart, getContextInfos, getMentionedJids } from "./message-parsing.js";
import type { WhatsAppChannel } from "./types.js";

export interface TriggerConfig {
	botName: string;
	groupTriggerAliases?: string[];
	assistantHasOwnNumber: boolean;
	allowedGroups: string[];
}

export function getGroupTriggerTokens(config: Pick<TriggerConfig, "botName" | "groupTriggerAliases">): string[] {
	const aliases = config.groupTriggerAliases || [];
	const deduped = new Set<string>();
	for (const token of [config.botName, ...aliases]) {
		const normalized = token.trim();
		if (!normalized) continue;
		deduped.add(normalized);
	}
	return Array.from(deduped);
}

export function isGroupAllowed(
	channelId: string,
	allowedGroups: string[],
	channels: Map<string, WhatsAppChannel>,
): boolean {
	if (allowedGroups.length === 0) return true;
	const channelName = channels.get(channelId)?.name.toLowerCase() || "";
	return allowedGroups.some((allowed) => {
		const value = allowed.toLowerCase();
		return value === channelId.toLowerCase() || (channelName.length > 0 && channelName.includes(value));
	});
}

export function isBotAuthoredMessage(
	config: Pick<TriggerConfig, "assistantHasOwnNumber" | "botName">,
	fromMe: boolean,
	text: string,
): boolean {
	if (config.assistantHasOwnNumber) return fromMe;
	if (!fromMe) return false;
	const normalized = text.trim().toLowerCase();
	return normalized.startsWith(`${config.botName.toLowerCase()}:`);
}

export function isMentioned(
	triggerTokens: string[],
	botJids: Set<string>,
	text: string,
	message: proto.IMessage | null | undefined,
): boolean {
	for (const trigger of triggerTokens) {
		const mentionRegex = new RegExp(`(?:^|\\s)@?${escapeRegex(trigger)}(?:\\b|\\s|$)`, "i");
		if (mentionRegex.test(text)) return true;
	}
	const mentionedJids = getMentionedJids(message);
	return mentionedJids.some((jid) => botJids.has(normalizeWhatsAppJid(jid)));
}

export function stripMention(
	triggerTokens: string[],
	botJids: Set<string>,
	text: string,
	message: proto.IMessage | null | undefined,
): string {
	let stripped = text;
	for (const trigger of triggerTokens) {
		stripped = stripped.replace(new RegExp(`(?:^|\\s)@?${escapeRegex(trigger)}(?:\\b|\\s|$)`, "ig"), " ");
	}
	const mentionedJids = getMentionedJids(message);
	const botMentionedByJid = mentionedJids.some((jid) => botJids.has(normalizeWhatsAppJid(jid)));
	if (botMentionedByJid) {
		for (const botJid of botJids) {
			const alias = extractJidUserPart(botJid);
			if (!alias) continue;
			stripped = stripped.replace(new RegExp(`(?:^|\\s)@?${escapeRegex(alias)}(?:\\b|\\s|$)`, "ig"), " ");
		}
	}
	return stripped.replace(/\s+/g, " ").trim();
}

export function isReplyToBotByStanzaId(
	contextInfos: Array<proto.IContextInfo | null | undefined>,
	botJids: Set<string>,
): { byStanzaId?: string; byParticipant: boolean } {
	let byStanzaId: string | undefined;
	let byParticipant = false;
	for (const info of contextInfos) {
		if (info?.stanzaId) byStanzaId = info.stanzaId;
		if (info?.participant && botJids.has(normalizeWhatsAppJid(info.participant))) {
			byParticipant = true;
		}
	}
	return { byStanzaId, byParticipant };
}
