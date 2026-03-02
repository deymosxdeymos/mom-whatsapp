import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelStore } from "./store.js";
import { handleWorkspaceCommand } from "./workspace-commands.js";

function parseBangCommand(text: string): { name: string; args: string[] } {
	const parts = text.trim().slice(1).split(/\s+/);
	return {
		name: parts[0]?.toLowerCase() || "",
		args: parts.slice(1),
	};
}

test("workspace command handler covers the normal remember, soul, and note flows users will actually use", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "ujang-wa-commands-"));
	const store = new ChannelStore({ workingDir });
	const sent: string[] = [];
	const wa = {
		postMessage: async (_channelId: string, text: string): Promise<void> => {
			sent.push(text);
		},
	};
	const channelId = "1203@g.us";
	const event = { channel: channelId, user: "628111@s.whatsapp.net" };

	try {
		const ownerOptions = {
			workingDir,
			isOwnerJid: () => true,
		};

		assert.equal(
			await handleWorkspaceCommand(parseBangCommand("!remember prefers lowercase replies"), event, { store }, wa, ownerOptions),
			true,
		);
		assert.equal(sent.at(-1), "Remembered in channel memory.");
		assert.equal(
			(await readFile(join(workingDir, channelId, "MEMORY.md"), "utf-8")).trim(),
			"- prefers lowercase replies",
		);

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!soul set teasing is fine but no dogpiling"),
				event,
				{ store },
				wa,
				ownerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "Updated channel soul.");

		assert.equal(
			await handleWorkspaceCommand(parseBangCommand("!soul show"), event, { store }, wa, ownerOptions),
			true,
		);
		assert.match(sent.at(-1) || "", /Soul \(channel\):\nteasing is fine but no dogpiling/);

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!note add running-jokes deadline means maybe next week"),
				event,
				{ store },
				wa,
				ownerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "Saved channel note: running-jokes");
		assert.equal(
			(await readFile(join(workingDir, channelId, "memory", "running-jokes.md"), "utf-8")).trim(),
			"deadline means maybe next week",
		);

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!note show running-jokes"),
				event,
				{ store },
				wa,
				ownerOptions,
			),
			true,
		);
		assert.match(sent.at(-1) || "", /Note \(channel\/running-jokes\):\ndeadline means maybe next week/);

		const nonOwnerOptions = {
			workingDir,
			isOwnerJid: () => false,
		};
		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!remember --global user likes concise replies"),
				event,
				{ store },
				wa,
				nonOwnerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "_Only configured owner JIDs can write global memory._");
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});

test("workspace command handler enforces owner-only global soul and note writes but still allows reading curated globals", async () => {
	const workingDir = await mkdtemp(join(tmpdir(), "ujang-wa-global-commands-"));
	const store = new ChannelStore({ workingDir });
	const sent: string[] = [];
	const wa = {
		postMessage: async (_channelId: string, text: string): Promise<void> => {
			sent.push(text);
		},
	};
	const channelId = "1203@g.us";
	const event = { channel: channelId, user: "628111@s.whatsapp.net" };

	try {
		const ownerOptions = {
			workingDir,
			isOwnerJid: () => true,
		};
		const nonOwnerOptions = {
			workingDir,
			isOwnerJid: () => false,
		};

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!soul set --global dry, funny, never stiff"),
				event,
				{ store },
				wa,
				ownerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "Updated global soul.");

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!note add --global people ki is rizki"),
				event,
				{ store },
				wa,
				ownerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "Saved global note: people");

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!note list global"),
				event,
				{ store },
				wa,
				nonOwnerOptions,
			),
			true,
		);
		assert.match(sent.at(-1) || "", /Notes \(global\):\npeople\.md/);

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!soul show global"),
				event,
				{ store },
				wa,
				nonOwnerOptions,
			),
			true,
		);
		assert.match(sent.at(-1) || "", /Soul \(global\):\ndry, funny, never stiff/);

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!soul set --global should fail"),
				event,
				{ store },
				wa,
				nonOwnerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "_Only configured owner JIDs can modify global soul._");

		assert.equal(
			await handleWorkspaceCommand(
				parseBangCommand("!note add --global secrets should fail"),
				event,
				{ store },
				wa,
				nonOwnerOptions,
			),
			true,
		);
		assert.equal(sent.at(-1), "_Only configured owner JIDs can modify global notes._");
	} finally {
		await rm(workingDir, { recursive: true, force: true });
	}
});
