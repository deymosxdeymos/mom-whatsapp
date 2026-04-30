// Pure message-parsing utilities for WhatsApp proto messages.
// Extracted from src/whatsapp.ts.

import { normalizeMessageContent, type proto, type WAMessage } from "@whiskeysockets/baileys";
import { extensionFromMime } from "../attachments.js";

export function extractText(message: proto.IMessage | null | undefined): string {
	const normalized = normalizeMessageContent(message) || message;
	if (!normalized) return "";
	if (normalized.conversation) return normalized.conversation;
	if (normalized.extendedTextMessage?.text) return normalized.extendedTextMessage.text;
	if (normalized.imageMessage?.caption) return normalized.imageMessage.caption;
	if (normalized.videoMessage?.caption) return normalized.videoMessage.caption;
	if (normalized.documentMessage?.caption) return normalized.documentMessage.caption;
	return "";
}

export function timestampToMs(ts: unknown): number {
	if (!ts) return Date.now();
	if (typeof ts === "number") return ts * 1000;
	if (typeof ts === "bigint") return Number(ts) * 1000;
	if (typeof ts === "object" && ts !== null) {
		const stringLike = ts as { toString?: () => string };
		if (typeof stringLike.toString === "function") {
			const n = Number(stringLike.toString());
			if (Number.isFinite(n)) return n * 1000;
		}
		const lp = ts as { low?: unknown; high?: unknown; unsigned?: unknown };
		if (typeof lp.low === "number" && typeof lp.high === "number") {
			const value = (BigInt(lp.low >>> 0) | (BigInt(lp.high >>> 0) << 32n));
			const signed = lp.unsigned === true ? value : BigInt.asIntN(64, value);
			const n = Number(signed);
			if (Number.isFinite(n)) return n * 1000;
		}
	}
	return Date.now();
}

export function getContextInfos(message: proto.IMessage | null | undefined): Array<proto.IContextInfo | null | undefined> {
	const normalized = normalizeMessageContent(message) || message;
	if (!normalized) return [];
	return [
		normalized.extendedTextMessage?.contextInfo,
		normalized.imageMessage?.contextInfo,
		normalized.videoMessage?.contextInfo,
		normalized.documentMessage?.contextInfo,
	];
}

export function getMentionedJids(message: proto.IMessage | null | undefined): string[] {
	const all: string[] = [];
	for (const info of getContextInfos(message)) {
		if (!info?.mentionedJid) continue;
		all.push(...info.mentionedJid);
	}
	return all;
}

export function extractJidUserPart(jid: string): string {
	const [userPart = ""] = jid.split("@", 1);
	const [baseUser = ""] = userPart.split(":", 1);
	return baseUser;
}

export function detectAttachmentFilename(msg: WAMessage): string {
	const normalizedMessage = normalizeMessageContent(msg.message) || msg.message;
	const documentName = normalizedMessage?.documentMessage?.fileName;
	if (documentName) return documentName;
	if (normalizedMessage?.imageMessage?.mimetype) {
		return `image${extensionFromMime(normalizedMessage.imageMessage.mimetype)}`;
	}
	if (normalizedMessage?.videoMessage?.mimetype) {
		return `video${extensionFromMime(normalizedMessage.videoMessage.mimetype)}`;
	}
	if (normalizedMessage?.documentMessage?.mimetype) {
		return `document${extensionFromMime(normalizedMessage.documentMessage.mimetype)}`;
	}
	return "attachment.bin";
}
