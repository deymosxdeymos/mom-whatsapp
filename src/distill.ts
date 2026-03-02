import { complete, type Api, type AssistantMessage, type Context, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { readFile, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parseModelSpecWithAliases } from "./model-aliases.js";
import {
	getChannelMemoryDir,
	getChannelMemoryPath,
	getChannelSoulPath,
	getMemoryNotePath,
	listMemoryNotes,
	writeScopedText,
} from "./workspace-files.js";

const STOP_WORDS = new Set([
	"a",
	"ada",
	"aja",
	"aku",
	"and",
	"are",
	"at",
	"banget",
	"buat",
	"but",
	"by",
	"dah",
	"dan",
	"dari",
	"deh",
	"do",
	"dong",
	"for",
	"ga",
	"gak",
	"gue",
	"gua",
	"i",
	"in",
	"ini",
	"itu",
	"jadi",
	"just",
	"kan",
	"kalo",
	"kau",
	"kayak",
	"ke",
	"kok",
	"lagi",
	"lah",
	"lu",
	"mah",
	"my",
	"nih",
	"no",
	"not",
	"of",
	"oh",
	"ok",
	"oke",
	"or",
	"our",
	"pakai",
	"sama",
	"sih",
	"so",
	"tapi",
	"that",
	"the",
	"to",
	"udah",
	"wkwk",
	"wk",
	"yang",
	"ya",
	"yg",
	"yo",
	"you",
]);

const TEASING_MARKERS = ["anj", "njir", "goblok", "tolol", "bego", "kampret", "sotoy", "bacot", "tai"];
const ENGLISH_MARKERS = ["bro", "guys", "gas", "fix", "safe", "random", "stress", "deadline", "login", "call"];
const INDONESIAN_MARKERS = ["anjir", "banget", "dong", "nih", "udah", "gak", "ga", "kok", "lah", "deh"];

export interface DistilledMessage {
	author: string | null;
	text: string;
	rawDate: string;
	rawTime: string;
}

interface PersonStats {
	author: string;
	messageCount: number;
	wordCount: number;
	shortMessages: number;
	lowercaseMessages: number;
	terms: Map<string, number>;
}

export interface DistilledWorkspaceFiles {
	soul: string;
	memory: string;
	notes: Array<{ name: string; content: string }>;
}

export const DISTILL_MANAGED_NOTE_NAMES = new Set(["people.md", "running-jokes.md"]);

export interface DistillSummary {
	messageCount: number;
	participantCount: number;
	topParticipants: string[];
	commonSlang: string[];
	repeatedPhrases: string[];
}

export interface DistillLlmOutput {
	soul: string;
	memoryBullets: string[];
	peopleNote: string;
	runningJokes?: string | null;
}

export function parseWhatsAppExport(text: string): DistilledMessage[] {
	const lines = text.split(/\r?\n/);
	const messages: DistilledMessage[] = [];
	let current: DistilledMessage | null = null;

	for (const line of lines) {
		const parsed = parseExportLine(line);
		if (parsed) {
			if (current) {
				messages.push(current);
			}
			current = parsed;
			continue;
		}

		if (current) {
			current.text = `${current.text}\n${line}`.trimEnd();
		}
	}

	if (current) {
		messages.push(current);
	}

	return messages;
}

export function distillChatExport(text: string): DistilledWorkspaceFiles {
	const parsed = parseWhatsAppExport(text);
	const chatMessages = parsed.filter((message) => message.author && !isOmittedMessage(message.text));
	if (chatMessages.length === 0) {
		throw new Error("No chat messages found in export");
	}

	const people = buildPersonStats(chatMessages);
	const sortedPeople = Array.from(people.values()).sort((a, b) => b.messageCount - a.messageCount);
	const topParticipants = sortedPeople.slice(0, 6);
	const summary = summarizeChat(chatMessages, topParticipants);

	return {
		soul: buildSoulDocument(summary),
		memory: buildMemoryDocument(summary),
		notes: buildNoteFiles(summary, topParticipants),
	};
}

export async function distillExportFileToWorkspace(params: {
	workingDir: string;
	channelId: string;
	exportPath: string;
	useLlm?: boolean;
}): Promise<DistillSummary> {
	const exportText = await readFile(params.exportPath, "utf-8");
	const files = params.useLlm === false ? distillChatExport(exportText) : await distillChatExportWithLlmFallback(exportText);

	await writeScopedText(getChannelSoulPath(params.workingDir, params.channelId), files.soul);
	await writeScopedText(getChannelMemoryPath(params.workingDir, params.channelId), files.memory);

	const memoryDir = getChannelMemoryDir(params.workingDir, params.channelId);
	const nextNoteNames = new Set(files.notes.map((note) => note.name));
	const existingNoteNames = listMemoryNotes({
		workingDir: params.workingDir,
		channelId: params.channelId,
		scope: "channel",
	});
	for (const existingNoteName of existingNoteNames) {
		if (!DISTILL_MANAGED_NOTE_NAMES.has(existingNoteName) || nextNoteNames.has(existingNoteName)) {
			continue;
		}
		await rm(
			getMemoryNotePath({
				workingDir: params.workingDir,
				channelId: params.channelId,
				scope: "channel",
				noteName: existingNoteName,
			}),
			{ force: true },
		);
	}
	for (const note of files.notes) {
		await writeScopedText(join(memoryDir, note.name), note.content);
	}

	const parsed = parseWhatsAppExport(exportText).filter((message) => message.author && !isOmittedMessage(message.text));
	const people = buildPersonStats(parsed);
	const topParticipants = Array.from(people.values())
		.sort((a, b) => b.messageCount - a.messageCount)
		.slice(0, 6);
	return summarizeChat(parsed, topParticipants);
}

export async function distillChatExportWithLlmFallback(text: string): Promise<DistilledWorkspaceFiles> {
	const fallback = distillChatExport(text);

	try {
		const llm = await distillChatExportWithLlm(text, fallback);
		return llm;
	} catch {
		return fallback;
	}
}

export async function distillChatExportWithLlm(
	text: string,
	fallback?: DistilledWorkspaceFiles,
): Promise<DistilledWorkspaceFiles> {
	const parsed = parseWhatsAppExport(text);
	const chatMessages = parsed.filter((message) => message.author && !isOmittedMessage(message.text));
	if (chatMessages.length === 0) {
		throw new Error("No chat messages found in export");
	}

	const { model, apiKey } = await resolveDistillModelAndKey();
	const context = buildDistillContext(chatMessages, fallback ?? distillChatExport(text));
	const response = await complete(model, context, { apiKey, reasoningEffort: "high" });
	const output = parseDistillLlmOutput(extractResponseText(response));
	return convertLlmOutputToFiles(output, fallback ?? distillChatExport(text));
}

function parseExportLine(line: string): DistilledMessage | null {
	const normalizedLine = line.replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+/, "");
	const bracketedMatch = normalizedLine.match(
		/^\[(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}),\s+(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:\s?[APMapm]{2})?)\]\s(.*)$/,
	);
	const dashedMatch = normalizedLine.match(
		/^(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:\s?[APMapm]{2})?)\s[-–]\s(.*)$/,
	);
	const match = bracketedMatch ?? dashedMatch;
	if (!match) {
		return null;
	}

	const [, rawDate, rawTime, rest] = match;
	const separatorIndex = rest.indexOf(": ");
	if (separatorIndex < 0) {
		return {
			author: null,
			text: rest.trim(),
			rawDate,
			rawTime,
		};
	}

	return {
		author: rest.slice(0, separatorIndex).trim(),
		text: rest.slice(separatorIndex + 2).trim(),
		rawDate,
		rawTime,
	};
}

async function resolveDistillModelAndKey(): Promise<{ model: Model<Api>; apiKey: string }> {
	const configured = parseModelSpec(process.env.MOM_WA_MODEL?.trim() || "anthropic/claude-sonnet-4-6");
	const primaryAuthPath = resolvePreferredAuthJsonPath(configured.provider);
	const secondaryAuthPath = getSecondaryAuthJsonPath(primaryAuthPath);
	const primaryAuthStorage = AuthStorage.create(primaryAuthPath);
	const secondaryAuthStorage = AuthStorage.create(secondaryAuthPath);
	const modelRegistry = new ModelRegistry(primaryAuthStorage);
	const model = resolveModelOrThrow(modelRegistry, configured.provider, configured.modelId);
	const apiKey = await getApiKeyForProvider(configured.provider, primaryAuthStorage, secondaryAuthStorage);
	return { model, apiKey };
}

function buildDistillContext(messages: DistilledMessage[], fallback: DistilledWorkspaceFiles): Context {
	const excerpts = selectDistillExcerpts(messages);
	const people = Array.from(new Set(messages.map((message) => message.author).filter((value): value is string => Boolean(value))));
	return {
		systemPrompt: [
			"You distill WhatsApp group chat exports into compact social context files for a chat bot.",
			"Write only grounded observations from the transcript.",
			"Do not flatten everyone into one voice.",
			"Do not use therapist language, HR language, or generic assistant phrasing.",
			"Return strict JSON with keys: soul, memoryBullets, peopleNote, runningJokes.",
			"soul must be markdown for SOUL.md focused on vibe, pacing, humor, and when to stay quiet.",
			"memoryBullets must be an array of stable facts or norms.",
			"peopleNote must be markdown for memory/people.md with sections per important participant.",
			"runningJokes must be markdown for memory/running-jokes.md, or null if there is nothing durable enough.",
		].join("\n"),
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: [
							`Participants seen: ${people.join(", ")}`,
							"",
							"Starter heuristic draft:",
							fallback.soul,
							"",
							"Starter memory draft:",
							fallback.memory,
							"",
							"Use the transcript excerpts below as the source of truth. Improve the drafts, remove weak guesses, and make the files feel specific to the room without copying catchphrases too literally.",
							"",
							"Transcript excerpts:",
							excerpts,
						].join("\n"),
					},
				],
				timestamp: Date.now(),
			},
		],
	};
}

function selectDistillExcerpts(messages: DistilledMessage[]): string {
	const maxMessages = 120;
	const head = messages.slice(0, Math.min(30, messages.length));
	const tailStart = Math.max(head.length, messages.length - 30);
	const tail = messages.slice(tailStart);
	const middleBudget = Math.max(0, maxMessages - head.length - tail.length);
	const middle: DistilledMessage[] = [];
	if (middleBudget > 0 && tailStart > head.length) {
		const middleSource = messages.slice(head.length, tailStart);
		const step = Math.max(1, Math.floor(middleSource.length / middleBudget));
		for (let index = 0; index < middleSource.length && middle.length < middleBudget; index += step) {
			middle.push(middleSource[index]);
		}
	}
	const selected = [...head, ...middle, ...tail];
	return selected
		.map((message) => `${message.author}: ${message.text.replace(/\n+/g, " / ")}`)
		.join("\n");
}

function parseDistillLlmOutput(text: string): DistillLlmOutput {
	const raw = extractJsonObject(text);
	const parsed = JSON.parse(raw) as Partial<DistillLlmOutput>;
	if (
		typeof parsed.soul !== "string" ||
		!Array.isArray(parsed.memoryBullets) ||
		typeof parsed.peopleNote !== "string"
	) {
		throw new Error("Model returned invalid distillation JSON");
	}
	return {
		soul: parsed.soul.trim(),
		memoryBullets: parsed.memoryBullets.map((value) => String(value).trim()).filter((value) => value.length > 0),
		peopleNote: parsed.peopleNote.trim(),
		runningJokes:
			parsed.runningJokes === null ? null : typeof parsed.runningJokes === "string" ? parsed.runningJokes.trim() : undefined,
	};
}

export function convertLlmOutputToFiles(
	output: DistillLlmOutput,
	fallback: DistilledWorkspaceFiles,
): DistilledWorkspaceFiles {
	const fallbackPeople = fallback.notes.find((note) => note.name === "people.md");
	const notes = [{ name: "people.md", content: output.peopleNote || fallbackPeople?.content || "" }];
	if (output.runningJokes) {
		notes.push({ name: "running-jokes.md", content: output.runningJokes });
	} else if (output.runningJokes === undefined) {
		const fallbackJokes = fallback.notes.find((note) => note.name === "running-jokes.md");
		if (fallbackJokes) {
			notes.push(fallbackJokes);
		}
	}
	return {
		soul: output.soul || fallback.soul,
		memory: output.memoryBullets.map((line) => `- ${line.replace(/^-+\s*/, "")}`).join("\n") || fallback.memory,
		notes,
	};
}

function extractResponseText(response: AssistantMessage): string {
	return response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return fenced[1].trim();
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) {
		throw new Error("No JSON object found in model response");
	}
	return text.slice(start, end + 1);
}

function parseModelSpec(spec: string): { provider: string; modelId: string } {
	return parseModelSpecWithAliases(spec, { provider: "anthropic", modelId: "claude-sonnet-4-6" });
}

function resolveModelOrThrow(modelRegistry: ModelRegistry, provider: string, modelId: string): Model<Api> {
	const found = modelRegistry.find(provider, modelId);
	if (found) {
		return found;
	}

	const knownProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
	if (!knownProviders.has(provider)) {
		throw new Error(`Unknown provider '${provider}'`);
	}
	throw new Error(`Unknown model '${provider}/${modelId}'`);
}

function getAuthJsonPaths(): { agentAuth: string; momWhatsappAuth: string } {
	return {
		agentAuth: join(homedir(), ".pi", "agent", "auth.json"),
		momWhatsappAuth: join(homedir(), ".pi", "mom-whatsapp", "auth.json"),
	};
}

function authFileHasProvider(authPath: string, provider: string): boolean {
	if (!existsSync(authPath)) return false;
	try {
		const content = requireJson(authPath) as Record<string, unknown>;
		return provider in content;
	} catch {
		return false;
	}
}

function resolvePreferredAuthJsonPath(provider: string): string {
	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	if (authFileHasProvider(agentAuth, provider)) {
		return agentAuth;
	}
	if (authFileHasProvider(momWhatsappAuth, provider)) {
		return momWhatsappAuth;
	}
	if (existsSync(agentAuth)) {
		return agentAuth;
	}
	return momWhatsappAuth;
}

function getSecondaryAuthJsonPath(primaryPath: string): string {
	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	return primaryPath === agentAuth ? momWhatsappAuth : agentAuth;
}

async function getApiKeyForProvider(
	provider: string | undefined,
	primaryAuthStorage: AuthStorage,
	secondaryAuthStorage: AuthStorage,
): Promise<string> {
	const resolvedProvider = provider?.trim();
	if (!resolvedProvider) {
		throw new Error("No model provider selected");
	}

	const primaryKey = await primaryAuthStorage.getApiKey(resolvedProvider);
	if (primaryKey) return primaryKey;

	const secondaryKey = await secondaryAuthStorage.getApiKey(resolvedProvider);
	if (secondaryKey) return secondaryKey;

	throw new Error(`No API key found for ${resolvedProvider}`);
}

function requireJson(filePath: string): unknown {
	return JSON.parse(requireText(filePath));
}

function requireText(filePath: string): string {
	if (!existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}
	return readFileSync(filePath, "utf-8");
}

function buildPersonStats(messages: DistilledMessage[]): Map<string, PersonStats> {
	const stats = new Map<string, PersonStats>();

	for (const message of messages) {
		const author = message.author;
		if (!author) {
			continue;
		}

		const existing = stats.get(author) ?? {
			author,
			messageCount: 0,
			wordCount: 0,
			shortMessages: 0,
			lowercaseMessages: 0,
			terms: new Map<string, number>(),
		};
		existing.messageCount += 1;

		const words = tokenize(message.text);
		existing.wordCount += words.length;
		if (words.length <= 6) {
			existing.shortMessages += 1;
		}
		if (isMostlyLowercase(message.text)) {
			existing.lowercaseMessages += 1;
		}
		for (const term of words) {
			if (STOP_WORDS.has(term) || term.length < 3) {
				continue;
			}
			existing.terms.set(term, (existing.terms.get(term) ?? 0) + 1);
		}
		stats.set(author, existing);
	}

	return stats;
}

function summarizeChat(messages: DistilledMessage[], topParticipants: PersonStats[]): DistillSummary {
	const allText = messages.map((message) => message.text);
	const slangCounts = countTerms(allText);
	const repeatedPhrases = findRepeatedPhrases(allText);

	return {
		messageCount: messages.length,
		participantCount: new Set(messages.map((message) => message.author).filter((value): value is string => Boolean(value))).size,
		topParticipants: topParticipants.map((person) => person.author),
		commonSlang: pickTopTerms(slangCounts, 6),
		repeatedPhrases,
	};
}

function buildSoulDocument(summary: DistillSummary): string {
	const topPeopleLine =
		summary.topParticipants.length > 0
			? `Most active in this export: ${summary.topParticipants.slice(0, 4).join(", ")}.`
			: "Most active members were not clear enough to list.";

	const slangLine =
		summary.commonSlang.length > 0
			? `Common markers in the room: ${summary.commonSlang.join(", ")}. Use them sparingly and only when the room already sounds like that.`
			: "Keep the tone casual and adapt to the room instead of forcing slang.";

	return [
		"# SOUL.md - Distilled From Group Export",
		"",
		"This file was generated from a WhatsApp chat export. Treat it as a starting point and edit it by hand after a few live conversations.",
		"",
		"## Group Vibe",
		"",
		"- The room is casual, fast, and conversational. Short replies are normal.",
		"- Dry observations land better than over-explaining or trying too hard to be funny.",
		"- Indo-English mixing is normal when the group is already doing it.",
		"- Playful teasing is part of the vibe, but do not dogpile and do not drag one joke past the point where it is still funny.",
		`- ${topPeopleLine}`,
		"",
		"## How To Enter The Room",
		"",
		"- Do not show up like an assistant. Show up like someone who already understands the pace of the chat.",
		"- Add signal or a genuinely good bit. If the room is already flowing, stay out of the way.",
		"- Match the room's casing and length. Default to lowercase unless the users are being formal or emphatic.",
		`- ${slangLine}`,
	].join("\n");
}

function buildMemoryDocument(summary: DistillSummary): string {
	const bullets = [
		`- Distilled from ${summary.messageCount} messages across ${summary.participantCount} participants.`,
		`- Most active speakers in this export: ${formatList(summary.topParticipants.slice(0, 6))}.`,
		"- Short back-and-forth replies are normal. Avoid essay replies unless explicitly asked.",
		"- Group banter includes teasing; keep it playful and do not turn it into humiliation loops.",
	];

	if (summary.commonSlang.length > 0) {
		bullets.push(`- Common slang markers in this export: ${summary.commonSlang.join(", ")}.`);
	}
	if (summary.repeatedPhrases.length > 0) {
		bullets.push(`- Repeated bits worth recognizing: ${summary.repeatedPhrases.join("; ")}.`);
	}

	return bullets.join("\n");
}

function buildNoteFiles(summary: DistillSummary, people: PersonStats[]): Array<{ name: string; content: string }> {
	const notes: Array<{ name: string; content: string }> = [];

	const peopleSections = people.slice(0, 6).map((person) => {
		const avgWords = person.messageCount === 0 ? 0 : Math.round(person.wordCount / person.messageCount);
		const shortRatio = person.messageCount === 0 ? 0 : person.shortMessages / person.messageCount;
		const lowercaseRatio = person.messageCount === 0 ? 0 : person.lowercaseMessages / person.messageCount;
		const signatureTerms = pickTopTerms(person.terms, 5);
		return [
			`## ${person.author}`,
			`- Activity in export: ${person.messageCount} messages`,
			`- Typical reply length: about ${avgWords} words`,
			`- Usually sends ${shortRatio >= 0.65 ? "short" : "mixed-length"} messages`,
			`- Casing style: ${lowercaseRatio >= 0.7 ? "mostly lowercase" : "mixed casing"}`,
			signatureTerms.length > 0 ? `- Recurring terms: ${signatureTerms.join(", ")}` : "- No strong recurring terms extracted",
		].join("\n");
	});

	if (peopleSections.length > 0) {
		notes.push({
			name: "people.md",
			content: ["# People", "", ...peopleSections].join("\n\n"),
		});
	}

	if (summary.repeatedPhrases.length > 0) {
		notes.push({
			name: "running-jokes.md",
			content: [
				"# Repeated Bits",
				"",
				...summary.repeatedPhrases.map((phrase) => `- ${phrase}`),
			].join("\n"),
		});
	}

	return notes;
}

function isMostlyLowercase(text: string): boolean {
	const letters = text.match(/[A-Za-z]/g) ?? [];
	if (letters.length === 0) {
		return true;
	}
	const upper = letters.filter((letter) => letter === letter.toUpperCase()).length;
	return upper / letters.length <= 0.2;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.split(/[^a-z0-9]+/i)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function countTerms(messages: string[]): Map<string, number> {
	const counts = new Map<string, number>();

	for (const message of messages) {
		for (const term of tokenize(message)) {
			if (term.length < 3 || STOP_WORDS.has(term)) {
				continue;
			}
			const matchesTeasing = TEASING_MARKERS.some((marker) => term.includes(marker));
			const matchesEnglish = ENGLISH_MARKERS.includes(term);
			const matchesIndonesian = INDONESIAN_MARKERS.includes(term);
			if (!matchesTeasing && !matchesEnglish && !matchesIndonesian) {
				continue;
			}
			counts.set(term, (counts.get(term) ?? 0) + 1);
		}
	}

	return counts;
}

function pickTopTerms(counts: Map<string, number>, limit: number): string[] {
	return Array.from(counts.entries())
		.filter(([, count]) => count >= 2)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([term]) => term);
}

function findRepeatedPhrases(messages: string[]): string[] {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const normalized = normalizePhrase(message);
		if (!normalized) {
			continue;
		}
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}

	return Array.from(counts.entries())
		.filter(([, count]) => count >= 2)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8)
		.map(([phrase, count]) => `${phrase} (${count}x)`);
}

function normalizePhrase(text: string): string | null {
	const normalized = text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length < 6 || normalized.length > 80) {
		return null;
	}
	const words = normalized.split(" ");
	if (words.length < 2 || words.length > 8) {
		return null;
	}
	if (words.every((word) => STOP_WORDS.has(word))) {
		return null;
	}
	return normalized;
}

function isOmittedMessage(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return normalized === "<media omitted>" || normalized === "image omitted" || normalized === "video omitted";
}

function formatList(values: string[]): string {
	if (values.length === 0) {
		return "(none)";
	}
	return values.join(", ");
}
