import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

export interface Attachment {
	original: string;
	local: string;
}

export interface LoggedMessage {
	date: string;
	ts: string;
	messageId?: string;
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
}

export class ChannelStore {
	private workingDir: string;
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const attachmentsDir = join(dir, "attachments");
		if (!existsSync(attachmentsDir)) {
			mkdirSync(attachmentsDir, { recursive: true });
		}

		return dir;
	}

	generateLocalFilename(originalName: string, timestamp: string): string {
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		const messageIdentity = message.messageId?.trim() || `${message.ts}:${message.user}:${message.text}`;
		const dedupeKey = `${channelId}:${messageIdentity}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");
		if (!message.date) {
			const date = message.ts.includes(".")
				? new Date(parseFloat(message.ts) * 1000)
				: new Date(parseInt(message.ts, 10));
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			messageId: ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}
		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}
}
