export function formatVerboseDetailsMessage(text: string, verboseEnabled: boolean): string | null {
	if (!verboseEnabled) {
		return null;
	}
	return `[details]\n${text}`;
}
