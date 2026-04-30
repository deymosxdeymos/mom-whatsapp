// WhatsApp-specific text formatting.

export function formatVerboseDetailsMessage(text: string, verboseEnabled: boolean): string | null {
	if (!verboseEnabled) return null;
	return `[details]\n${text}`;
}

export function maxWhatsAppMessageLength(): number {
	return 4096;
}
