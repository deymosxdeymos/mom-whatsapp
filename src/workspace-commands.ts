import {
	appendMemoryBullet,
	getMemoryNotePath,
	getScopePath,
	listMemoryNotes,
	readTextIfExists,
	type WorkspaceScope,
	writeScopedText,
} from "./workspace-files.js";

export interface WorkspaceCommandEvent {
	channel: string;
	user: string;
}

export interface WorkspaceCommandState {
	store: {
		getChannelDir(channelId: string): string;
	};
}

export interface WorkspaceCommandBot {
	postMessage(channelId: string, text: string): Promise<unknown>;
}

export interface WorkspaceCommandOptions {
	workingDir: string;
	isOwnerJid: (jid: string) => boolean;
}

export function parseWorkspaceScopeArg(value: string | undefined): WorkspaceScope {
	return value?.toLowerCase() === "global" ? "global" : "channel";
}

export async function handleWorkspaceCommand(
	command: { name: string; args: string[] },
	event: WorkspaceCommandEvent,
	state: WorkspaceCommandState,
	wa: WorkspaceCommandBot,
	options: WorkspaceCommandOptions,
): Promise<boolean> {
	if (command.name === "memory") {
		if (command.args.length === 0) {
			await wa.postMessage(event.channel, "Usage: !memory show [global|channel] | !memory add [--global] <text>");
			return true;
		}
		const sub = command.args[0].toLowerCase();
		if (sub === "show") {
			const scope = parseWorkspaceScopeArg(command.args[1]);
			if (scope === "channel") {
				state.store.getChannelDir(event.channel);
			}
			const path = getScopePath({ workingDir: options.workingDir, channelId: event.channel, scope, kind: "memory" });
			const raw = await readTextIfExists(path);
			if (raw === null) {
				await wa.postMessage(event.channel, `Memory (${scope}) is empty.`);
				return true;
			}
			const content = raw.trim();
			await wa.postMessage(
				event.channel,
				content ? `Memory (${scope}):\n${content}` : `Memory (${scope}) is empty.`,
			);
			return true;
		}
		if (sub === "add") {
			const globalFlag = command.args[1] === "--global";
			if (globalFlag && !options.isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can modify global memory._");
				return true;
			}
			const text = (globalFlag ? command.args.slice(2) : command.args.slice(1)).join(" ").trim();
			if (!text) {
				await wa.postMessage(event.channel, "_Usage: !memory add [--global] <text>_");
				return true;
			}
			const scope: WorkspaceScope = globalFlag ? "global" : "channel";
			if (scope === "channel") {
				state.store.getChannelDir(event.channel);
			}
			const path = getScopePath({
				workingDir: options.workingDir,
				channelId: event.channel,
				scope,
				kind: "memory",
			});
			await appendMemoryBullet(path, text);
			await wa.postMessage(event.channel, `Added to ${scope} memory.`);
			return true;
		}
		await wa.postMessage(event.channel, "_Unknown memory command. Use show/add._");
		return true;
	}

	if (command.name === "remember") {
		const globalFlag = command.args[0] === "--global";
		if (globalFlag && !options.isOwnerJid(event.user)) {
			await wa.postMessage(event.channel, "_Only configured owner JIDs can write global memory._");
			return true;
		}
		const text = (globalFlag ? command.args.slice(1) : command.args).join(" ").trim();
		if (!text) {
			await wa.postMessage(event.channel, "_Usage: !remember [--global] <text>_");
			return true;
		}
		const scope: WorkspaceScope = globalFlag ? "global" : "channel";
		const path = getScopePath({ workingDir: options.workingDir, channelId: event.channel, scope, kind: "memory" });
		await appendMemoryBullet(path, text);
		await wa.postMessage(event.channel, `Remembered in ${scope} memory.`);
		return true;
	}

	if (command.name === "soul") {
		if (command.args.length === 0) {
			await wa.postMessage(event.channel, "Usage: !soul show [global|channel] | !soul set [--global] <text>");
			return true;
		}
		const sub = command.args[0]?.toLowerCase();
		if (sub === "show") {
			const scope = parseWorkspaceScopeArg(command.args[1]);
			const path = getScopePath({ workingDir: options.workingDir, channelId: event.channel, scope, kind: "soul" });
			const raw = await readTextIfExists(path);
			if (raw === null || raw.trim().length === 0) {
				await wa.postMessage(event.channel, `Soul (${scope}) is empty.`);
				return true;
			}
			await wa.postMessage(event.channel, `Soul (${scope}):\n${raw.trim()}`);
			return true;
		}
		if (sub === "set") {
			const globalFlag = command.args[1] === "--global";
			if (globalFlag && !options.isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can modify global soul._");
				return true;
			}
			const text = (globalFlag ? command.args.slice(2) : command.args.slice(1)).join(" ").trim();
			if (!text) {
				await wa.postMessage(event.channel, "_Usage: !soul set [--global] <text>_");
				return true;
			}
			const scope: WorkspaceScope = globalFlag ? "global" : "channel";
			const path = getScopePath({ workingDir: options.workingDir, channelId: event.channel, scope, kind: "soul" });
			await writeScopedText(path, text);
			await wa.postMessage(event.channel, `Updated ${scope} soul.`);
			return true;
		}
		await wa.postMessage(event.channel, "_Unknown soul command. Use show/set._");
		return true;
	}

	if (command.name === "note" || command.name === "notes") {
		if (command.args.length === 0) {
			await wa.postMessage(
				event.channel,
				"Usage: !note list [global|channel] | !note show [global|channel] <name> | !note add [--global] <name> <text>",
			);
			return true;
		}
		const sub = command.args[0]?.toLowerCase();
		if (sub === "list") {
			const scope = parseWorkspaceScopeArg(command.args[1]);
			const notes = listMemoryNotes({ workingDir: options.workingDir, channelId: event.channel, scope });
			await wa.postMessage(
				event.channel,
				notes.length > 0 ? `Notes (${scope}):\n${notes.join("\n")}` : `Notes (${scope}) are empty.`,
			);
			return true;
		}
		if (sub === "show") {
			const scopedArg = command.args[1]?.toLowerCase();
			const scope =
				scopedArg === "global" || scopedArg === "channel" ? parseWorkspaceScopeArg(scopedArg) : "channel";
			const nameIndex = scopedArg === "global" || scopedArg === "channel" ? 2 : 1;
			const noteName = command.args[nameIndex];
			if (!noteName) {
				await wa.postMessage(event.channel, "_Usage: !note show [global|channel] <name>_");
				return true;
			}
			const path = getMemoryNotePath({
				workingDir: options.workingDir,
				channelId: event.channel,
				scope,
				noteName,
			});
			const raw = await readTextIfExists(path);
			if (raw === null || raw.trim().length === 0) {
				await wa.postMessage(event.channel, `Note not found in ${scope}: ${noteName}`);
				return true;
			}
			await wa.postMessage(event.channel, `Note (${scope}/${noteName}):\n${raw.trim()}`);
			return true;
		}
		if (sub === "add") {
			const globalFlag = command.args[1] === "--global";
			if (globalFlag && !options.isOwnerJid(event.user)) {
				await wa.postMessage(event.channel, "_Only configured owner JIDs can modify global notes._");
				return true;
			}
			const nameIndex = globalFlag ? 2 : 1;
			const textIndex = globalFlag ? 3 : 2;
			const noteName = command.args[nameIndex];
			const text = command.args.slice(textIndex).join(" ").trim();
			if (!noteName || !text) {
				await wa.postMessage(event.channel, "_Usage: !note add [--global] <name> <text>_");
				return true;
			}
			try {
				const scope: WorkspaceScope = globalFlag ? "global" : "channel";
				const path = getMemoryNotePath({
					workingDir: options.workingDir,
					channelId: event.channel,
					scope,
					noteName,
				});
				await writeScopedText(path, text);
				await wa.postMessage(event.channel, `Saved ${scope} note: ${noteName}`);
			} catch (err) {
				await wa.postMessage(
					event.channel,
					`_Failed to save note:_ ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return true;
		}
		await wa.postMessage(event.channel, "_Unknown note command. Use list/show/add._");
		return true;
	}

	return false;
}
