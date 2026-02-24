import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_EXTRACT_CHARS = 8000;
const MAX_BUFFER_BYTES = 6 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const MAX_PLAIN_TEXT_BYTES = 512 * 1024;

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".csv",
	".tsv",
	".yaml",
	".yml",
	".xml",
	".html",
	".htm",
	".js",
	".ts",
	".jsx",
	".tsx",
	".py",
	".rb",
	".java",
	".go",
	".rs",
	".sh",
	".sql",
]);

export interface AttachmentTextExtraction {
	method: string;
	text: string;
}

export interface AttachmentExtractionOptions {
	deadlineMs?: number;
	commandPrefix?: string[];
	commandPath?: string;
}

function trimAndTruncate(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
	if (normalized.length <= MAX_EXTRACT_CHARS) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_EXTRACT_CHARS)}\n\n[truncated to ${MAX_EXTRACT_CHARS} chars]`;
}

function decodeXmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#xA;/gi, "\n")
		.replace(/&#10;/g, "\n");
}

function xmlToText(xml: string): string {
	const withParagraphBreaks = xml
		.replace(/<w:p[^>]*>/g, "\n")
		.replace(/<a:p[^>]*>/g, "\n")
		.replace(/<row[^>]*>/g, "\n");

	const stripped = withParagraphBreaks
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+\n/g, "\n")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ");

	return decodeXmlEntities(stripped).trim();
}

function isDeadlineExpired(deadlineMs: number | undefined): boolean {
	return typeof deadlineMs === "number" && deadlineMs <= Date.now();
}

function getCommandTimeout(deadlineMs: number | undefined): number | null {
	if (typeof deadlineMs !== "number") {
		return COMMAND_TIMEOUT_MS;
	}

	const remainingMs = deadlineMs - Date.now();
	if (remainingMs <= 0) {
		return null;
	}

	return Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
}

function resolveCommandInvocation(
	command: string,
	args: string[],
	options: AttachmentExtractionOptions,
): { command: string; args: string[] } {
	const prefix = (options.commandPrefix || []).filter((part) => part.length > 0);
	if (prefix.length === 0) {
		return { command, args };
	}

	return {
		command: prefix[0],
		args: [...prefix.slice(1), command, ...args],
	};
}

async function runCommand(
	command: string,
	args: string[],
	options: AttachmentExtractionOptions,
): Promise<string | null> {
	const timeout = getCommandTimeout(options.deadlineMs);
	if (timeout === null) {
		return null;
	}

	const invocation = resolveCommandInvocation(command, args, options);
	try {
		const { stdout } = await execFileAsync(invocation.command, invocation.args, {
			maxBuffer: MAX_BUFFER_BYTES,
			timeout,
		});
		return stdout;
	} catch {
		return null;
	}
}

async function extractPdf(path: string, options: AttachmentExtractionOptions): Promise<AttachmentTextExtraction | null> {
	const commandPath = options.commandPath || path;
	const text = await runCommand("pdftotext", ["-q", commandPath, "-"], options);
	if (!text) return null;
	const cleaned = trimAndTruncate(text);
	if (!cleaned) return null;
	return { method: "pdftotext", text: cleaned };
}

async function extractDocx(path: string, options: AttachmentExtractionOptions): Promise<AttachmentTextExtraction | null> {
	const commandPath = options.commandPath || path;
	const xml = await runCommand("unzip", ["-p", commandPath, "word/document.xml"], options);
	if (!xml) return null;
	const cleaned = trimAndTruncate(xmlToText(xml));
	if (!cleaned) return null;
	return { method: "docx-xml", text: cleaned };
}

async function extractXlsx(path: string, options: AttachmentExtractionOptions): Promise<AttachmentTextExtraction | null> {
	const commandPath = options.commandPath || path;
	const sharedStringsXml = await runCommand("unzip", ["-p", commandPath, "xl/sharedStrings.xml"], options);
	const sheetXml = await runCommand("unzip", ["-p", commandPath, "xl/worksheets/sheet1.xml"], options);
	if (!sharedStringsXml && !sheetXml) return null;

	const sections: string[] = [];
	if (sharedStringsXml) {
		const strings = trimAndTruncate(xmlToText(sharedStringsXml));
		if (strings) sections.push(`shared strings:\n${strings}`);
	}
	if (sheetXml) {
		const sheet = trimAndTruncate(xmlToText(sheetXml));
		if (sheet) sections.push(`sheet1:\n${sheet}`);
	}
	if (sections.length === 0) return null;

	const combined = trimAndTruncate(sections.join("\n\n"));
	if (!combined) return null;
	return { method: "xlsx-xml", text: combined };
}

async function extractPptx(path: string, options: AttachmentExtractionOptions): Promise<AttachmentTextExtraction | null> {
	const commandPath = options.commandPath || path;
	const entries = await runCommand("unzip", ["-Z1", commandPath], options);
	if (!entries) return null;

	const slidePaths = entries
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^ppt\/slides\/slide\d+\.xml$/.test(line))
		.slice(0, 3);
	if (slidePaths.length === 0) return null;

	const slideTexts: string[] = [];
	for (const slidePath of slidePaths) {
		const xml = await runCommand("unzip", ["-p", commandPath, slidePath], options);
		if (!xml) continue;
		const text = trimAndTruncate(xmlToText(xml));
		if (!text) continue;
		slideTexts.push(`${slidePath}:\n${text}`);
	}

	if (slideTexts.length === 0) return null;
	const combined = trimAndTruncate(slideTexts.join("\n\n"));
	if (!combined) return null;
	return { method: "pptx-xml", text: combined };
}

async function readUtf8Prefix(
	path: string,
	maxBytes: number,
): Promise<{ content: string; wasTruncatedByBytes: boolean } | null> {
	let file: Awaited<ReturnType<typeof open>> | null = null;
	try {
		file = await open(path, "r");
		const stats = await file.stat();
		const byteLimit = Math.max(1, maxBytes);
		const bytesToRead = Math.min(stats.size, byteLimit);
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf-8"),
			wasTruncatedByBytes: stats.size > byteLimit,
		};
	} catch {
		return null;
	} finally {
		if (file) {
			await file.close();
		}
	}
}

async function extractPlainText(path: string, options: AttachmentExtractionOptions): Promise<AttachmentTextExtraction | null> {
	if (isDeadlineExpired(options.deadlineMs)) {
		return null;
	}

	const prefix = await readUtf8Prefix(path, MAX_PLAIN_TEXT_BYTES);
	if (!prefix) return null;

	const content = prefix.wasTruncatedByBytes
		? `${prefix.content}\n\n[truncated to first ${MAX_PLAIN_TEXT_BYTES} bytes before decode]`
		: prefix.content;
	const cleaned = trimAndTruncate(content);
	if (!cleaned) return null;
	return { method: "utf8", text: cleaned };
}

export async function extractAttachmentText(
	path: string,
	options: AttachmentExtractionOptions = {},
): Promise<AttachmentTextExtraction | null> {
	const extension = extname(path).toLowerCase();
	if (isDeadlineExpired(options.deadlineMs)) {
		return null;
	}

	if (TEXT_EXTENSIONS.has(extension)) {
		return extractPlainText(path, options);
	}

	if (extension === ".pdf") {
		return extractPdf(path, options);
	}

	if (extension === ".docx") {
		return extractDocx(path, options);
	}

	if (extension === ".xlsx") {
		return extractXlsx(path, options);
	}

	if (extension === ".pptx") {
		return extractPptx(path, options);
	}

	return null;
}
