import { existsSync, readFileSync } from "fs";
import { copyFile, writeFile } from "fs/promises";
import { basename, resolve } from "path";
import { pathToFileURL } from "url";
import { parseWhatsAppExport, type DistilledMessage } from "./distill.js";
import type { LoggedMessage } from "./store.js";

export type ExportDateOrder = "dmy" | "mdy";

export interface ImportMonth {
	year: number;
	month: number;
}

export interface ImportLogOptions {
	exportPath: string;
	logPath: string;
	month: string;
	utcOffsetMinutes: number;
	excludedAuthors?: readonly string[];
	dryRun?: boolean;
}

export interface ImportLogResult {
	dateOrder: ExportDateOrder;
	parsedCount: number;
	candidateCount: number;
	importedCount: number;
	skippedExistingCount: number;
	finalCount: number;
	backupPath?: string;
}

interface LocalDateParts {
	year: number;
	month: number;
	day: number;
}

interface TimeParts {
	hour: number;
	minute: number;
	second: number;
}

interface ImportedCandidate {
	message: LoggedMessage;
	localDate: LocalDateParts;
}

const OMITTED_MEDIA_TEXTS = new Set([
	"<media omitted>",
	"media omitted",
	"image omitted",
	"video omitted",
	"sticker omitted",
	"gif omitted",
	"audio omitted",
	"voice message omitted",
	"document omitted",
]);

const SYSTEM_TEXT_PATTERNS: RegExp[] = [
	/end-to-end encrypted/i,
	/created this group/i,
	/changed the subject/i,
	/changed this group's icon/i,
	/changed the group description/i,
	/joined using this group's invite link/i,
	/turned on disappearing messages/i,
	/turned off disappearing messages/i,
	/you were added/i,
	/added you/i,
	/was added/i,
	/was removed/i,
	/left$/i,
	/security code/i,
];

export function parseImportMonth(value: string): ImportMonth {
	const match = value.trim().match(/^(\d{4})-(\d{2})$/);
	if (!match) {
		throw new Error(`Invalid month '${value}'. Expected YYYY-MM.`);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		throw new Error(`Invalid month '${value}'. Expected YYYY-MM.`);
	}
	return { year, month };
}

export function parseUtcOffsetMinutes(value: string): number {
	const trimmed = value.trim();
	if (/^[+-]?\d+$/.test(trimmed)) {
		return Number(trimmed);
	}
	const match = trimmed.match(/^([+-])(\d{2}):?(\d{2})$/);
	if (!match) {
		throw new Error(`Invalid UTC offset '${value}'. Expected minutes or ±HH:MM.`);
	}
	const sign = match[1] === "+" ? 1 : -1;
	const hours = Number(match[2]);
	const minutes = Number(match[3]);
	return sign * (hours * 60 + minutes);
}

export function detectExportDateOrder(messages: readonly DistilledMessage[]): ExportDateOrder {
	let dmyEvidence = 0;
	let mdyEvidence = 0;

	for (const message of messages) {
		const parts = message.rawDate.split(/[\/.-]/).map((value) => Number(value));
		if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
			continue;
		}
		const [first, second] = parts;
		if (first > 12 && second <= 12) {
			dmyEvidence += 1;
		} else if (second > 12 && first <= 12) {
			mdyEvidence += 1;
		}
	}

	if (mdyEvidence > dmyEvidence) {
		return "mdy";
	}
	return "dmy";
}

export function parseExportLocalDate(rawDate: string, order: ExportDateOrder): LocalDateParts {
	const parts = rawDate.split(/[\/.-]/).map((value) => Number(value));
	if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
		throw new Error(`Invalid export date '${rawDate}'`);
	}
	const [first, second, third] = parts;
	const day = order === "dmy" ? first : second;
	const month = order === "dmy" ? second : first;
	let year = third;
	if (year < 100) {
		year += 2000;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		throw new Error(`Invalid export date '${rawDate}'`);
	}
	return { year, month, day };
}

export function parseExportTime(rawTime: string): TimeParts {
	const normalized = rawTime.replace(/\./g, ":").replace(/\s+/g, " ").trim();
	const match = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?$/i);
	if (!match) {
		throw new Error(`Invalid export time '${rawTime}'`);
	}
	let hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = Number(match[3] ?? "0");
	const meridiem = match[4]?.toUpperCase();
	if (meridiem === "AM") {
		if (hour === 12) {
			hour = 0;
		}
	} else if (meridiem === "PM") {
		if (hour < 12) {
			hour += 12;
		}
	}
	if (hour > 23 || minute > 59 || second > 59) {
		throw new Error(`Invalid export time '${rawTime}'`);
	}
	return { hour, minute, second };
}

export function buildImportedLogMessage(params: {
	message: DistilledMessage;
	dateOrder: ExportDateOrder;
	utcOffsetMinutes: number;
	stripLeadingMentionAuthors?: readonly string[];
}): ImportedCandidate | null {
	if (!params.message.author) {
		return null;
	}
	const cleanedText = stripLeadingMentionForAuthors(
		cleanImportedText(params.message.text),
		params.stripLeadingMentionAuthors ?? [],
	);
	if (!cleanedText || shouldSkipImportedText(cleanedText)) {
		return null;
	}

	const localDate = parseExportLocalDate(params.message.rawDate, params.dateOrder);
	const time = parseExportTime(params.message.rawTime);
	const utcMs =
		Date.UTC(localDate.year, localDate.month - 1, localDate.day, time.hour, time.minute, time.second) -
		params.utcOffsetMinutes * 60_000;
	const utcDate = new Date(utcMs);
	const author = params.message.author.trim();
	return {
		localDate,
		message: {
			date: utcDate.toISOString(),
			ts: String(utcMs),
			user: buildImportedUserId(author),
			userName: author,
			displayName: author,
			text: cleanedText,
			attachments: [],
			isBot: false,
		},
	};
}

export function mergeImportedMessages(params: {
	existingMessages: readonly LoggedMessage[];
	importedMessages: readonly LoggedMessage[];
}): { mergedMessages: LoggedMessage[]; importedCount: number; skippedExistingCount: number } {
	const existingDedupKeys = new Set<string>();
	for (const message of params.existingMessages) {
		if (message.isBot) {
			continue;
		}
		existingDedupKeys.add(buildDedupKey(message));
	}

	const mergedMessages: LoggedMessage[] = [...params.existingMessages];
	let importedCount = 0;
	let skippedExistingCount = 0;

	for (const message of params.importedMessages) {
		const key = buildDedupKey(message);
		if (existingDedupKeys.has(key)) {
			skippedExistingCount += 1;
			continue;
		}
		existingDedupKeys.add(key);
		mergedMessages.push(message);
		importedCount += 1;
	}

	mergedMessages.sort((left, right) => getMessageSortTimestamp(left) - getMessageSortTimestamp(right));

	return { mergedMessages, importedCount, skippedExistingCount };
}

export async function importWhatsAppExportToLog(options: ImportLogOptions): Promise<ImportLogResult> {
	const exportText = readFileSync(options.exportPath, "utf-8");
	const parsedMessages = parseWhatsAppExport(exportText);
	const dateOrder = detectExportDateOrder(parsedMessages);
	const month = parseImportMonth(options.month);
	const excludedAuthors = new Set((options.excludedAuthors ?? []).map((value) => normalizeAuthor(value)));

	const importedCandidates: LoggedMessage[] = [];
	for (const parsedMessage of parsedMessages) {
		const normalizedAuthor = normalizeAuthor(parsedMessage.author);
		if (normalizedAuthor && excludedAuthors.has(normalizedAuthor)) {
			continue;
		}

		const candidate = buildImportedLogMessage({
			message: parsedMessage,
			dateOrder,
			utcOffsetMinutes: options.utcOffsetMinutes,
			stripLeadingMentionAuthors: options.excludedAuthors,
		});
		if (!candidate) {
			continue;
		}
		if (candidate.localDate.year !== month.year || candidate.localDate.month !== month.month) {
			continue;
		}
		importedCandidates.push(candidate.message);
	}

	const existingMessages = readLoggedMessages(options.logPath);
	const merged = mergeImportedMessages({
		existingMessages,
		importedMessages: importedCandidates,
	});

	let backupPath: string | undefined;
	if (!options.dryRun && merged.importedCount > 0) {
		backupPath = `${options.logPath}.bak-import-${Date.now()}`;
		if (existsSync(options.logPath)) {
			await copyFile(options.logPath, backupPath);
		}
		await writeFile(options.logPath, serializeJsonLines(merged.mergedMessages), "utf-8");
	}

	return {
		dateOrder,
		parsedCount: parsedMessages.length,
		candidateCount: importedCandidates.length,
		importedCount: merged.importedCount,
		skippedExistingCount: merged.skippedExistingCount,
		finalCount: merged.mergedMessages.length,
		backupPath,
	};
}

export function readLoggedMessages(logPath: string): LoggedMessage[] {
	if (!existsSync(logPath)) {
		return [];
	}
	const content = readFileSync(logPath, "utf-8");
	const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const messages: LoggedMessage[] = [];
	for (const line of lines) {
		const parsed = JSON.parse(line) as LoggedMessage;
		messages.push(parsed);
	}
	return messages;
}

function normalizeAuthor(author: string | null): string {
	return author?.trim().toLowerCase() ?? "";
}

function cleanImportedText(text: string): string {
	return text
		.replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+/, "")
		.replace(/\s*[\u200e\u200f\u202a-\u202e\u2066-\u2069]*<This message was edited>\s*$/i, "")
		.trim();
}

function stripLeadingMentionForAuthors(text: string, authors: readonly string[]): string {
	let next = text.trim();
	const normalizedAuthors = Array.from(
		new Set(authors.map((author) => author.trim()).filter((author) => author.length > 0)),
	).sort((left, right) => right.length - left.length);

	for (;;) {
		let stripped = false;
		for (const author of normalizedAuthors) {
			const escapedAuthor = escapeRegExp(author);
			const pattern = new RegExp(`^@[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*${escapedAuthor}[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*[,:-]?\\s*`, "i");
			const updated = next.replace(pattern, "").trimStart();
			if (updated !== next) {
				next = updated;
				stripped = true;
				break;
			}
		}
		if (!stripped) {
			return next;
		}
	}
}

function shouldSkipImportedText(text: string): boolean {
	const normalized = text
		.replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (!normalized) {
		return true;
	}
	if (OMITTED_MEDIA_TEXTS.has(normalized)) {
		return true;
	}
	return SYSTEM_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildImportedUserId(author: string): string {
	const slug = author
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `export:${slug || "unknown"}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDedupText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function buildDedupKey(message: Pick<LoggedMessage, "date" | "text">): string {
	const parsedDate = Date.parse(message.date);
	const normalizedDate = Number.isFinite(parsedDate)
		? new Date(parsedDate).toISOString().slice(0, 19)
		: message.date.trim();
	return `${normalizedDate}|${normalizeDedupText(message.text)}`;
}

function getMessageSortTimestamp(message: LoggedMessage): number {
	const parsedDate = Date.parse(message.date);
	if (Number.isFinite(parsedDate)) {
		return parsedDate;
	}
	const numericTs = Number(message.ts);
	if (Number.isFinite(numericTs)) {
		return numericTs < 1_000_000_000_000 ? numericTs * 1000 : numericTs;
	}
	return Number.MAX_SAFE_INTEGER;
}

function serializeJsonLines(messages: readonly LoggedMessage[]): string {
	return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

interface CliOptions {
	exportPath: string;
	logPath: string;
	month: string;
	utcOffsetMinutes: number;
	excludedAuthors: string[];
	dryRun: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
	let exportPath = "";
	let logPath = "";
	let month = new Date().toISOString().slice(0, 7);
	let utcOffsetMinutes = 7 * 60;
	const excludedAuthors: string[] = [];
	let dryRun = true;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--export") {
			exportPath = resolve(argv[index + 1] ?? "");
			index += 1;
		} else if (arg === "--log") {
			logPath = resolve(argv[index + 1] ?? "");
			index += 1;
		} else if (arg === "--month") {
			month = argv[index + 1] ?? "";
			index += 1;
		} else if (arg === "--utc-offset") {
			utcOffsetMinutes = parseUtcOffsetMinutes(argv[index + 1] ?? "");
			index += 1;
		} else if (arg === "--exclude-author") {
			excludedAuthors.push(argv[index + 1] ?? "");
			index += 1;
		} else if (arg === "--apply") {
			dryRun = false;
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else {
			throw new Error(`Unknown argument '${arg}'`);
		}
	}

	if (!exportPath) {
		throw new Error("Missing required --export <path>");
	}
	if (!logPath) {
		throw new Error("Missing required --log <path>");
	}

	return {
		exportPath,
		logPath,
		month,
		utcOffsetMinutes,
		excludedAuthors,
		dryRun,
	};
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const result = await importWhatsAppExportToLog({
		exportPath: options.exportPath,
		logPath: options.logPath,
		month: options.month,
		utcOffsetMinutes: options.utcOffsetMinutes,
		excludedAuthors: options.excludedAuthors,
		dryRun: options.dryRun,
	});

	const mode = options.dryRun ? "DRY RUN" : "APPLIED";
	console.log(
		[
			`${mode}: ${basename(options.exportPath)} -> ${options.logPath}`,
			`month: ${options.month}`,
			`date order: ${result.dateOrder}`,
			`parsed messages: ${result.parsedCount}`,
			`candidate imports: ${result.candidateCount}`,
			`imported: ${result.importedCount}`,
			`already present: ${result.skippedExistingCount}`,
			`final log entries: ${result.finalCount}`,
			result.backupPath ? `backup: ${result.backupPath}` : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n"),
	);
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
	void main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	});
}
