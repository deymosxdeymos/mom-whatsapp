export interface ParsedModelSpec {
	provider: string;
	modelId: string;
}

const MODEL_ALIASES: Readonly<Record<string, ParsedModelSpec>> = {
	"gpt-5.4": { provider: "openai-codex", modelId: "gpt-5.4" },
	"openai-codex/gpt-5.4": { provider: "openai-codex", modelId: "gpt-5.4" },
	"kimi-k2.5-turbo": { provider: "fireworks", modelId: "accounts/fireworks/routers/kimi-k2p5-turbo" },
	"fireworks/kimi-k2.5-turbo": { provider: "fireworks", modelId: "accounts/fireworks/routers/kimi-k2p5-turbo" },
};

export function parseModelSpecWithAliases(
	spec: string,
	defaults: { provider: string; modelId: string },
): ParsedModelSpec {
	const trimmed = spec.trim();
	if (!trimmed) {
		return defaults;
	}

	const alias = MODEL_ALIASES[trimmed.toLowerCase()];
	if (alias) {
		return alias;
	}

	if (trimmed.includes("/")) {
		const [provider, ...rest] = trimmed.split("/");
		const modelId = rest.join("/").trim();
		return {
			provider: provider.trim() || defaults.provider,
			modelId: modelId || defaults.modelId,
		};
	}

	return { provider: defaults.provider, modelId: trimmed };
}
