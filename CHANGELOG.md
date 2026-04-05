# Changelog

## [Unreleased]

### Added

- Initial WhatsApp transport package `@deymosxdeymos/pi-mom-whatsapp` with Baileys-based connectivity.
- Per-chat agent runtime with persistent `log.jsonl` + `context.jsonl` state, memory files, skills, and event scheduling.
- WhatsApp media ingestion: inbound image/video/document attachments are downloaded into `<chat>/attachments/` and included in prompt context.
- Group allowlist matching by exact JID and group-name substring (`MOM_WA_ALLOWED_GROUPS`).
- Outbound reliability improvements: reconnect-aware outgoing queue and retry logic for pending text/file messages.
- Type-aware outbound file sending (image/video/document selection by extension).
- Optional verbose detail stream in chat via `MOM_WA_VERBOSE_DETAILS=1`.
- Shared-number operation mode via `MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0` for accounts where user and bot share one WhatsApp identity.
- Package helper scripts `dev.sh` and `docker.sh` for fast local setup.
- Runtime checklist harness (`npm run runtime:checklist`) that validates startup/auth persistence, DM stop flow, group allowlist behavior, shared-number loop prevention, media ingestion, reconnect queue flush, verbose toggle behavior, event scheduling, and Docker sandbox persistence with strict PASS/FAIL output plus JSON evidence report.
- In-chat command layer for WhatsApp control (`!help`, `!status`, `!model`, `!thinking`, `!memory`) with `/` alias support.
- Lightweight message reaction status markers on incoming events (`⏳`, `✅`, `❌`, `⏹️`).
- Group trigger enhancement: replies to recent bot-authored messages now trigger processing even without explicit mention token.
- Stop command aliases (`stop`, `!stop`, `/stop`) now cancel active group runs even without mention token while a run is active.

### Changed

- Monorepo root scripts now include `packages/mom-whatsapp` in `npm run build` and `npm run dev`.
- Replaced Slack-specific package documentation with WhatsApp-specific setup and troubleshooting guidance.
- Refactored WhatsApp transport to support dependency injection for auth/socket/media/timer operations, enabling deterministic runtime checklist verification and faster reconnect-path testing.
- Centralized verbose detail message formatting in `src/verbose.ts` and wired it into runtime context response handling.
- Upgraded WhatsApp transport stack to `@whiskeysockets/baileys@^7.0.0-rc.9`, switched to explicit terminal QR rendering, and added optional phone-number pairing-code fallback via `MOM_WA_PAIRING_PHONE`.
- Auth resolution now prefers `~/.pi/agent/auth.json` (shared with local pi agent login) and falls back to `~/.pi/mom-whatsapp/auth.json`.
- Model/thinking defaults can now be changed at runtime through in-chat commands and persisted in workspace settings.
- Added owner-gated command controls via `MOM_WA_OWNER_JIDS` and startup model override via `MOM_WA_MODEL`.
- Docker sandbox helper scripts now create containers with `--security-opt label=disable` to avoid SELinux mount label write failures on `/workspace`.

### Fixed

- Outgoing queue flush now drops stale/missing file attachments (ENOENT) instead of retry-looping forever, which previously spammed logs when temp files like `/tmp/screenshot-*.png` disappeared.
