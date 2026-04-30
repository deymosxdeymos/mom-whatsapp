// Attachment helpers extracted from src/whatsapp.ts.
// Mirror of pi-chat's materializeAttachments style — service-neutral filename/mime utilities.

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

export function mimeFromExtension(ext: string): string {
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".txt") return "text/plain";
	if (ext === ".json") return "application/json";
	if (ext === ".csv") return "text/csv";
	if (ext === ".zip") return "application/zip";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	if (ext === ".mp4") return "video/mp4";
	return "application/octet-stream";
}

export function extensionFromMime(mime: string): string {
	if (mime === "image/jpeg") return ".jpg";
	if (mime === "image/png") return ".png";
	if (mime === "image/gif") return ".gif";
	if (mime === "image/webp") return ".webp";
	if (mime === "application/pdf") return ".pdf";
	if (mime === "video/mp4") return ".mp4";
	return ".bin";
}

export function sanitizeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function guessMimeType(path: string): string | undefined {
	const ext = path.toLowerCase().split(".").pop();
	if (!ext) return undefined;
	if (ext === "png") return "image/png";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "gif") return "image/gif";
	if (ext === "webp") return "image/webp";
	if (ext === "mp4" || ext === "mov" || ext === "webm") return "video/mp4";
	if (ext === "pdf") return "application/pdf";
	if (ext === "json") return "application/json";
	if (ext === "md") return "text/markdown";
	if (ext === "txt" || ext === "log") return "text/plain";
	if (ext === "csv") return "text/csv";
	return undefined;
}
