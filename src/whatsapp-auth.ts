#!/usr/bin/env node

import * as readline from "node:readline";
import { mkdirSync } from "node:fs";
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

interface ParsedArgs {
	usePairingCode: boolean;
	phoneNumber?: string;
}

const AUTH_DIR = process.env.MOM_WA_AUTH_DIR?.trim();
const ENV_PAIRING_PHONE = process.env.MOM_WA_PAIRING_PHONE?.trim();

function parseArgs(argv: string[]): ParsedArgs {
	let usePairingCode = false;
	let phoneNumber: string | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--pairing-code") {
			usePairingCode = true;
			continue;
		}
		if (arg === "--phone") {
			phoneNumber = argv[i + 1];
			i += 1;
			continue;
		}
		if (arg.startsWith("--phone=")) {
			phoneNumber = arg.slice("--phone=".length);
		}
	}

	return { usePairingCode, phoneNumber };
}

function normalizePhoneNumber(value: string): string {
	return value.replace(/[^\d]/g, "");
}

function askQuestion(prompt: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function getDisconnectStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const output = (error as { output?: unknown }).output;
	if (!output || typeof output !== "object") return undefined;
	const statusCode = (output as { statusCode?: unknown }).statusCode;
	return typeof statusCode === "number" ? statusCode : undefined;
}

function getDisconnectMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "unknown";
}

async function connectSocket(phoneNumber: string | undefined, usePairingCode: boolean, isReconnect = false): Promise<void> {
	if (!AUTH_DIR) {
		console.error("Missing env: MOM_WA_AUTH_DIR");
		process.exit(1);
	}

	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	let saveQueue: Promise<void> = Promise.resolve();
	const enqueueSaveCreds = (): void => {
		saveQueue = saveQueue.then(() => Promise.resolve(saveCreds())).catch((err) => {
			console.error(`Failed to save WhatsApp creds: ${getDisconnectMessage(err)}`);
		});
	};
	if (state.creds.registered === true && !isReconnect) {
		console.log("✓ Already authenticated with WhatsApp");
		console.log("  Run mom-whatsapp directly.");
		process.exit(0);
	}

	const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
		version: [2, 3000, 1027934701] as [number, number, number],
		isLatest: false,
	}));
	console.log(`Using Baileys WA version ${version.join(".")} (isLatest: ${isLatest})`);

	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys),
		},
		version,
		printQRInTerminal: false,
		browser: ["mom-whatsapp", "cli", "0.54.1"],
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});

	let pairingCodeTimer: ReturnType<typeof setTimeout> | undefined;

	if (usePairingCode && phoneNumber && state.creds.registered !== true) {
		pairingCodeTimer = globalThis.setTimeout(() => {
			pairingCodeTimer = undefined;
			void (async () => {
				try {
					const code = await sock.requestPairingCode(phoneNumber);
					console.log(`\nWhatsApp pairing code: ${code}\n`);
					console.log("1. Open WhatsApp on your phone");
					console.log("2. Linked Devices > Link with phone number instead");
					console.log(`3. Enter this code: ${code}\n`);
				} catch (err) {
					console.error(`Failed to request pairing code: ${getDisconnectMessage(err)}`);
					process.exit(1);
				}
			})();
		}, 3000);
	}

	sock.ev.on("connection.update", (update) => {
		const { connection, lastDisconnect, qr } = update;
		console.log(
			`connection.update: connection=${connection ?? "none"} qr=${qr ? "yes" : "no"} status=${getDisconnectStatusCode(lastDisconnect?.error) ?? "none"} message=${lastDisconnect?.error ? getDisconnectMessage(lastDisconnect.error) : "none"}`,
		);

		if (qr && !usePairingCode) {
			console.log("Scan this QR code with WhatsApp:\n");
			console.log("1. Open WhatsApp on your phone");
			console.log("2. Linked Devices > Link a device");
			console.log("3. Scan this QR:\n");
			qrcode.generate(qr, { small: true });
		}

		if (connection === "close") {
			clearTimeout(pairingCodeTimer);
			pairingCodeTimer = undefined;

			const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
			const message = getDisconnectMessage(lastDisconnect?.error);

			if (statusCode === DisconnectReason.loggedOut) {
				console.error("✗ Logged out. Re-run this auth command.");
				process.exit(1);
				return;
			}

			if (statusCode === DisconnectReason.timedOut) {
				console.error("✗ Pairing timed out. Re-run this command and try again.");
				process.exit(1);
				return;
			}

			if (statusCode === 515) {
				console.log("⟳ WhatsApp requested restart after pairing (515); waiting for creds save, then reconnecting...");
				void (async () => {
					await saveQueue;
					await new Promise((resolve) => setTimeout(resolve, 1000));
					await connectSocket(phoneNumber, usePairingCode, true);
				})();
				return;
			}

			console.error(`✗ Connection failed (status: ${statusCode ?? "unknown"}, message: ${message})`);
			process.exit(1);
			return;
		}

		if (connection === "open") {
			clearTimeout(pairingCodeTimer);
			pairingCodeTimer = undefined;

			console.log("\n✓ Successfully authenticated with WhatsApp!");
			console.log(`Credentials saved to: ${AUTH_DIR}`);
			globalThis.setTimeout(() => process.exit(0), 1000);
		}
	});

	sock.ev.on("creds.update", () => {
		console.log("creds.update: saving credentials");
		enqueueSaveCreds();
	});
}

async function main(): Promise<void> {
	if (!AUTH_DIR) {
		console.error("Missing env: MOM_WA_AUTH_DIR");
		process.exit(1);
	}
	mkdirSync(AUTH_DIR, { recursive: true });

	const args = parseArgs(process.argv.slice(2));
	let phoneNumber = args.phoneNumber || ENV_PAIRING_PHONE;
	const usePairingCode = args.usePairingCode || Boolean(phoneNumber);

	if (usePairingCode && !phoneNumber) {
		phoneNumber = await askQuestion("Enter your phone number (country code, digits only): ");
	}

	const normalizedPhoneNumber = phoneNumber ? normalizePhoneNumber(phoneNumber) : undefined;
	if (usePairingCode && !normalizedPhoneNumber) {
		console.error("Pairing code mode requires a valid phone number.");
		process.exit(1);
	}

	console.log("Starting WhatsApp authentication...");
	if (usePairingCode) {
		console.log("Using phone-number pairing mode.");
	} else {
		console.log("Using QR pairing mode.");
	}

	await connectSocket(normalizedPhoneNumber, usePairingCode);
}

void main().catch((err) => {
	console.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
