import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryGetTool, createMemorySearchTool, createMemoryWriteTool } from "./memory.js";

test("memory recall finds the exact social context a chat user would ask about", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "mom-wa-memory-tool-"));
	const channelId = "chat-123";
	try {
		await mkdir(join(workspaceDir, channelId), { recursive: true });
		await mkdir(join(workspaceDir, "memory"), { recursive: true });
		await mkdir(join(workspaceDir, channelId, "memory"), { recursive: true });

		await writeFile(
			join(workspaceDir, "MEMORY.md"),
			["- user likes lowercase", "- prefers teasing, not mean replies", "- friend is called ki"].join("\n") + "\n",
			"utf-8",
		);
		await writeFile(
			join(workspaceDir, "memory", "people.md"),
			["rizki is usually called ki in the group", "ki jokes land better when replies stay short"].join("\n") + "\n",
			"utf-8",
		);
		await writeFile(
			join(workspaceDir, channelId, "memory", "jokes.md"),
			["running joke: deadline means maybe next week", "they say 'deadline' ironically when nobody has started"].join(
				"\n",
			) + "\n",
			"utf-8",
		);
		await writeFile(
			join(workspaceDir, channelId, "memory", "people.md"),
			["channel-specific note: ki = rizki", "when someone says ki, they mean rizki specifically in this chat"].join(
				"\n",
			) + "\n",
			"utf-8",
		);

		const searchTool = createMemorySearchTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});
		const getTool = createMemoryGetTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});

		const searchResult = await searchTool.execute("call-1", {
			label: "recall nickname",
			query: "rizki ki",
		});
		const searchText = searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "";
		assert.match(searchText, /\/workspace\/chat-123\/memory\/people\.md/);
		assert.match(searchText, /ki = rizki/);
		assert.doesNotMatch(searchText, /No memory matches found/);

		const details = searchResult.details as { results?: Array<{ path: string; score: number }> } | undefined;
		assert.ok(details?.results);
		assert.equal(details.results?.[0]?.path, "/workspace/chat-123/memory/people.md");
		assert.ok((details.results?.[0]?.score ?? 0) >= (details.results?.[1]?.score ?? 0));

		const getResult = await getTool.execute("call-2", {
			label: "open matching note",
			path: "/workspace/chat-123/memory/people.md",
			from: 1,
			lines: 5,
		});
		const getText = getResult.content[0]?.type === "text" ? getResult.content[0].text : "";
		assert.match(getText, /ki = rizki/);
		assert.match(getText, /they mean rizki specifically in this chat/);

		const storedChannelNote = await readFile(join(workspaceDir, channelId, "memory", "people.md"), "utf-8");
		assert.match(storedChannelNote, /ki = rizki/);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});

test("memory_write persists an explicit remember request and makes it recallable in the same chat", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "mom-wa-memory-write-"));
	const channelId = "chat-voice-notes";
	try {
		await mkdir(join(workspaceDir, channelId), { recursive: true });

		const writeTool = createMemoryWriteTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});
		const searchTool = createMemorySearchTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});

		const writeResult = await writeTool.execute("call-3", {
			label: "remember chat preference",
			text: "user hates voice notes and wants replies kept in text",
		});
		const writeText = writeResult.content[0]?.type === "text" ? writeResult.content[0].text : "";
		assert.match(writeText, /\/workspace\/chat-voice-notes\/MEMORY\.md/);

		const storedMemory = await readFile(join(workspaceDir, channelId, "MEMORY.md"), "utf-8");
		assert.equal(storedMemory.trim(), "- user hates voice notes and wants replies kept in text");

		const searchResult = await searchTool.execute("call-4", {
			label: "recall response preference",
			query: "voice notes text replies",
		});
		const searchText = searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "";
		assert.match(searchText, /\/workspace\/chat-voice-notes\/MEMORY\.md/);
		assert.match(searchText, /hates voice notes/);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});

test("memory_write can file a topical note that is later found by search", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "mom-wa-memory-note-"));
	const channelId = "chat-running-jokes";
	try {
		await mkdir(join(workspaceDir, channelId), { recursive: true });

		const writeTool = createMemoryWriteTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});
		const searchTool = createMemorySearchTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});

		const writeResult = await writeTool.execute("call-5", {
			label: "remember running joke",
			note: "running jokes",
			text: "deadline means maybe next week in this group",
		});
		const writeText = writeResult.content[0]?.type === "text" ? writeResult.content[0].text : "";
		assert.match(writeText, /\/workspace\/chat-running-jokes\/memory\/running-jokes\.md/);

		const storedNote = await readFile(join(workspaceDir, channelId, "memory", "running-jokes.md"), "utf-8");
		assert.equal(storedNote.trim(), "- deadline means maybe next week in this group");

		const searchResult = await searchTool.execute("call-6", {
			label: "recall group joke",
			query: "deadline next week joke",
		});
		const searchText = searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "";
		assert.match(searchText, /\/workspace\/chat-running-jokes\/memory\/running-jokes\.md/);
		assert.match(searchText, /deadline means maybe next week/);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});

test("memory_get paginates long notes and rejects reads past the end of file", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "ujang-wa-memory-get-"));
	const channelId = "chat-paging";
	try {
		await mkdir(join(workspaceDir, channelId, "memory"), { recursive: true });
		await writeFile(
			join(workspaceDir, channelId, "memory", "people.md"),
			["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n") + "\n",
			"utf-8",
		);

		const getTool = createMemoryGetTool({
			workspaceHostPath: workspaceDir,
			workspacePath: "/workspace",
			channelId,
		});

		const pageOne = await getTool.execute("call-7", {
			label: "read first page",
			path: "/workspace/chat-paging/memory/people.md",
			from: 1,
			lines: 2,
		});
		const pageOneText = pageOne.content[0]?.type === "text" ? pageOne.content[0].text : "";
		assert.match(pageOneText, /^line 1\nline 2/);
		assert.match(pageOneText, /Use from=3 to continue/);

		const pageTwo = await getTool.execute("call-8", {
			label: "read second page",
			path: "/workspace/chat-paging/memory/people.md",
			from: 3,
			lines: 3,
		});
		const pageTwoText = pageTwo.content[0]?.type === "text" ? pageTwo.content[0].text : "";
		assert.equal(pageTwoText.trim(), ["line 3", "line 4", "line 5"].join("\n"));

		await assert.rejects(
			() =>
				getTool.execute("call-9", {
					label: "read beyond eof",
					path: "/workspace/chat-paging/memory/people.md",
					from: 9,
					lines: 1,
				}),
			/start line 9 is beyond end of file \(5 lines\)/i,
		);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});
