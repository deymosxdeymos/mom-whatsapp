// Centralized control command detection + shared utilities.
// Extracted from src/whatsapp.ts and src/main.ts.

/** Check if the raw text is a stop / !stop / /stop command. */
export function isStopCommandText(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return normalized === "stop" || normalized === "!stop" || normalized === "/stop";
}

/** Escape a string for use in a RegExp literal. */
export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is ENOENT (file not found). */
export function isFileNotFoundError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}
