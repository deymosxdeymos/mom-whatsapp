// Types for WhatsApp bot integration.
// Extracted from src/whatsapp.ts.

import type { proto } from "@whiskeysockets/baileys";
import type { GroupHistoryEntry } from "../group-history.js";
import type { Attachment } from "../store.js";

export interface WhatsAppEvent {
	type: "mention" | "dm";
	source: "whatsapp" | "scheduled";
	channel: string;
	ts: string;
	user: string;
	text: string;
	rawText: string;
	pendingHistory?: GroupHistoryEntry[];
	attachments?: Attachment[];
	messageKey?: proto.IMessageKey;
}

export interface WhatsAppUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface WhatsAppChannel {
	id: string;
	name: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface BotContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		pendingHistory?: GroupHistoryEntry[];
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	markToolExecution?: () => void;
}

export interface MomHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: WhatsAppEvent, wa: WhatsAppBotLike, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, wa: WhatsAppBotLike): Promise<void>;
}

export interface WhatsAppBotLike {
	postMessage(channel: string, text: string): Promise<string>;
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;
	setTyping(channel: string, isTyping: boolean): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	logBotResponse(channel: string, text: string, messageIds: string[]): void;
	seedUsersFromLog(logPath: string): void;
	getUser(userId: string): WhatsAppUser | undefined;
	getChannel(channelId: string): WhatsAppChannel | undefined;
	getAllUsers(): WhatsAppUser[];
	getAllChannels(): WhatsAppChannel[];
	isConnected(): boolean;
	getOutgoingQueueSize(): number;
	reactToMessage(channel: string, key: proto.IMessageKey, emoji: string): Promise<void>;
}
