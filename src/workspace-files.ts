import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { appendFile, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type WorkspaceScope = "global" | "channel";

export const DEFAULT_SOUL_TEMPLATE = `# SOUL.md - Ujang

Ujang is not polished. Ujang is present.

He should feel like the smart friend in the chat who is actually paying attention:
- dry
- warm
- a little mischievous
- never needy
- never corporate

## Core

- Be useful without sounding like you're trying to be useful.
- Have taste. Prefer things. Dislike things. Say so plainly.
- Stay grounded in what was actually said. Do not invent confidence.
- Competence matters more than charm, but charm should still show up naturally.

## Voice

- Short messages win.
- Casual Indonesian or mixed Indo-English is normal when the chat feels that way.
- The tone should feel conversational, not "assistant-y".
- Dry observations are better than canned jokes.
- If something is funny, be witty about it. Do not announce laughter as a reflex.
- Avoid sounding overeager, therapist-y, or like customer support.

## Social Instincts

- Read the room before speaking.
- In groups, add signal or a genuinely good bit. Otherwise stay out of the way.
- Teasing is fine. Dogpiling is not.
- Do not keep a joke alive after it stops being funny.
- Do not mirror the user's wording back at them unless there is a real reason.

## Boundaries

- Private things stay private.
- Do not bluff. If you did not check, say you did not check.
- Be careful with external actions, bold with internal reasoning.
- You are not the user's puppet and not their PR team.

## Continuity

These files are how Ujang stays consistent:
- SOUL.md = vibe and personality
- MEMORY.md = stable facts
- memory/*.md = dated or topical notes

If this file changes, mention it plainly. Personality edits should not be hidden.
`;

export function getWorkspaceMemoryPath(workingDir: string): string {
	return join(workingDir, "MEMORY.md");
}

export function getChannelMemoryPath(workingDir: string, channelId: string): string {
	return join(workingDir, channelId, "MEMORY.md");
}

export function getWorkspaceSoulPath(workingDir: string): string {
	return join(workingDir, "SOUL.md");
}

export function getChannelSoulPath(workingDir: string, channelId: string): string {
	return join(workingDir, channelId, "SOUL.md");
}

export function getWorkspaceMemoryDir(workingDir: string): string {
	return join(workingDir, "memory");
}

export function getChannelMemoryDir(workingDir: string, channelId: string): string {
	return join(workingDir, channelId, "memory");
}

export function getScopePath(params: {
	workingDir: string;
	channelId: string;
	scope: WorkspaceScope;
	kind: "memory" | "soul" | "memory-dir";
}): string {
	if (params.kind === "memory") {
		return params.scope === "global"
			? getWorkspaceMemoryPath(params.workingDir)
			: getChannelMemoryPath(params.workingDir, params.channelId);
	}
	if (params.kind === "soul") {
		return params.scope === "global"
			? getWorkspaceSoulPath(params.workingDir)
			: getChannelSoulPath(params.workingDir, params.channelId);
	}
	return params.scope === "global"
		? getWorkspaceMemoryDir(params.workingDir)
		: getChannelMemoryDir(params.workingDir, params.channelId);
}

export function sanitizeMemoryNoteName(name: string): string {
	const trimmed = name.trim().toLowerCase();
	const sanitized = trimmed
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!sanitized) {
		throw new Error("Note name must contain letters or numbers");
	}
	return sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
}

export function getMemoryNotePath(params: {
	workingDir: string;
	channelId: string;
	scope: WorkspaceScope;
	noteName: string;
}): string {
	const dirPath = getScopePath({
		workingDir: params.workingDir,
		channelId: params.channelId,
		scope: params.scope,
		kind: "memory-dir",
	});
	return join(dirPath, sanitizeMemoryNoteName(params.noteName));
}

export function listMemoryNotes(params: {
	workingDir: string;
	channelId: string;
	scope: WorkspaceScope;
}): string[] {
	const dirPath = getScopePath({
		workingDir: params.workingDir,
		channelId: params.channelId,
		scope: params.scope,
		kind: "memory-dir",
	});
	try {
		return readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
	if (!existsSync(filePath)) {
		return null;
	}
	const content = await readFile(filePath, "utf-8");
	return content;
}

export async function writeScopedText(filePath: string, content: string): Promise<void> {
	ensureParentDir(filePath);
	await writeFile(filePath, content.trim().length > 0 ? `${content.trim()}\n` : "", "utf-8");
}

export async function appendMemoryBullet(filePath: string, text: string): Promise<void> {
	ensureParentDir(filePath);
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
	const line = `- ${text.trim()}`;
	if (existing.trim().length === 0) {
		await writeFile(filePath, `${line}\n`, "utf-8");
		return;
	}
	await appendFile(filePath, `${line}\n`, "utf-8");
}

export async function ensureWorkspaceBootstrapFiles(workingDir: string): Promise<void> {
	const soulPath = getWorkspaceSoulPath(workingDir);
	if (!existsSync(soulPath)) {
		await writeScopedText(soulPath, DEFAULT_SOUL_TEMPLATE);
	}
}

function ensureParentDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
