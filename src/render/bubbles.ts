// Bubble splitting and typing delay for natural WhatsApp responses.
// Extracted from src/main.ts — the model uses \n---\n as a bubble separator.

const BUBBLE_DELAY_ENABLED = process.env.MOM_WA_BUBBLE_DELAY !== "0";
const BUBBLE_DELAY_PER_CHAR_MS = Math.max(0, readBubbleDelayEnv("MOM_WA_BUBBLE_DELAY_PER_CHAR_MS", 10));
const BUBBLE_DELAY_MIN_MS = Math.max(0, readBubbleDelayEnv("MOM_WA_BUBBLE_DELAY_MIN_MS", 80));
const BUBBLE_DELAY_MAX_MS = Math.max(
	BUBBLE_DELAY_MIN_MS,
	readBubbleDelayEnv("MOM_WA_BUBBLE_DELAY_MAX_MS", 600),
);

function readBubbleDelayEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Split a response into chat bubbles on \n---\n separators, falling back to paragraphs. */
export function splitIntoBubbles(text: string): string[] {
	const explicitParts = text.split(/\n[ \t]*---[ \t]*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
	if (explicitParts.length > 1) return explicitParts;
	return text.split(/\n\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Compute a realistic typing delay before sending a bubble. */
export function typingDelayMs(text: string): number {
	if (!BUBBLE_DELAY_ENABLED) return 0;
	const ms = text.length * BUBBLE_DELAY_PER_CHAR_MS;
	return Math.min(Math.max(ms, BUBBLE_DELAY_MIN_MS), BUBBLE_DELAY_MAX_MS);
}
