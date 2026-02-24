const DEFAULT_WHATSAPP_DOMAIN = "s.whatsapp.net";

/**
 * Normalize WhatsApp JIDs to a canonical form for equality checks.
 *
 * Examples:
 * - 12345:17@s.whatsapp.net -> 12345@s.whatsapp.net
 * - 12345@s.whatsapp.net:17 -> 12345@s.whatsapp.net
 * - 12345 -> 12345@s.whatsapp.net
 */
export function normalizeWhatsAppJid(jid: string): string {
	const trimmed = jid.trim().toLowerCase();
	if (!trimmed) return "";

	const [userPart = "", domainPart = DEFAULT_WHATSAPP_DOMAIN] = trimmed.split("@", 2);
	const normalizedUser = userPart.split(":")[0];
	if (!normalizedUser) return "";

	const normalizedDomain = (domainPart || DEFAULT_WHATSAPP_DOMAIN).split(":")[0] || DEFAULT_WHATSAPP_DOMAIN;
	return `${normalizedUser}@${normalizedDomain}`;
}
