# mom-whatsapp (Master Of Mischief for WhatsApp)

A WhatsApp bot powered by pi's coding-agent runtime. It executes bash/read/write/edit tools, keeps persistent memory, and is designed to run safely in a Docker sandbox.

## Features

- WhatsApp integration (DMs + group trigger)
- Same core agent/session architecture as `pi-mom`
- Persistent per-chat state (`log.jsonl`, `context.jsonl`, skills, memory)
- Event scheduler (`immediate`, `one-shot`, `periodic`) with in-chat task management commands
- Inbound media download to `attachments/` and prompt context handoff
- Automatic document text extraction for common formats (`.pdf`, `.docx`, `.xlsx`, `.pptx`, text/code files)
- Artifact URL generation for files under `artifacts/files/`
- Outbound reliability queue (messages/files queued while disconnected)
- Group allowlist by JID and/or group name fragment
- Optional verbose tool details in chat (`MOM_WA_VERBOSE_DETAILS=1`)

## Installation

```bash
npm install @mariozechner/pi-mom-whatsapp
```

## Quick Start

```bash
export MOM_WA_AUTH_DIR="$HOME/.pi/mom-whatsapp/wa-auth"
export MOM_WA_BOT_NAME="ujang"
# Optional: comma-separated list of allowed group JIDs or name fragments
export MOM_WA_ALLOWED_GROUPS="1203...@g.us,engineering"
# Optional: extra group trigger words (comma-separated), e.g. nickname aliases
export MOM_WA_GROUP_TRIGGER_ALIASES="jang"
# Optional: show tool details/usage lines in chat
export MOM_WA_VERBOSE_DETAILS=0
# Optional: artifacts URL base (used by !artifact and auto-link on attach)
export MOM_WA_ARTIFACTS_BASE_URL=https://example.trycloudflare.com
# Optional: read base URL from a file (default: /tmp/artifacts-url.txt)
export MOM_WA_ARTIFACTS_URL_FILE=/tmp/artifacts-url.txt
# Optional: artifacts root on host (default: <working-dir>/artifacts/files)
export MOM_WA_ARTIFACTS_ROOT=/path/to/data/artifacts/files
# Optional: shared-number setup (bot and user use same WA account)
export MOM_WA_ASSISTANT_HAS_OWN_NUMBER=1
# Optional: model override (default: anthropic/claude-sonnet-4-6)
export MOM_WA_MODEL=anthropic/claude-sonnet-4-6
# Optional: phone-number pairing for auth setup
# (used by `npm run wa:auth`, not by the runtime process)
export MOM_WA_PAIRING_PHONE=14155551234

# Option 1: Anthropic key
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: OAuth from pi coding agent (auto-detected)
# mom-whatsapp prefers ~/.pi/agent/auth.json if present.
# Optional fallback path: ~/.pi/mom-whatsapp/auth.json

# Authenticate once (QR by default, or pairing-code if MOM_WA_PAIRING_PHONE is set)
npm run wa:auth

# Recommended: run with Docker sandbox
mom-whatsapp --sandbox=docker:mom-sandbox ./data
```

Runtime no longer performs QR/pairing setup. Authenticate first with `npm run wa:auth`.

## Triggering Behavior

- **DMs**: always trigger the bot.
- **Groups**: trigger when `MOM_WA_BOT_NAME` (or any `MOM_WA_GROUP_TRIGGER_ALIASES`) is mentioned in text, directly mentioned via WhatsApp mention metadata, when replying to a recent bot-authored message, or as a short same-user follow-up after a triggered turn.
- **Stop override**: `stop`, `!stop`, or `/stop` cancels an active run in the same chat; in groups this works even without mention when a run is currently active.
- **Allowlist**: if `MOM_WA_ALLOWED_GROUPS` is set, only matching groups are processed:
  - exact JID (`1203...@g.us`)
  - case-insensitive substring of group name (`engineering`)

## In-Chat Control Commands

Use text commands in DM/group chats:

- `!help` - list available commands
- `!stop` - stop active run in this chat (`/stop` and plain `stop` also work)
- `!model` - show current model
- `!model <provider/model-id>` - set default model for future runs in this workspace
- `!model gpt-5.4` - alias for `openai-codex/gpt-5.4`
- `!model fireworks/kimi-k2.5-turbo` - alias for `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo`
- `!thinking` - show current thinking level
- `!thinking <off|minimal|low|medium|high|xhigh>` - set thinking level
- `!remember <text>` - append to channel memory
- `!remember --global <text>` - append to global workspace memory
- `!memory show [global|channel]` - show memory content
- `!memory add <text>` - append to channel memory
- `!memory add --global <text>` - append to global workspace memory
- `!soul show [global|channel]` - show persona file content
- `!soul set <text>` - replace channel persona
- `!soul set --global <text>` - replace global persona
- `!note list [global|channel]` - list note files
- `!note show [global|channel] <name>` - show a note file
- `!note add <name> <text>` - create/replace a channel note
- `!note add --global <name> <text>` - create/replace a global note
- `!task list` - list scheduled tasks for this chat
- `!task now <text>` - queue an immediate scheduled task message
- `!task once <ISO-8601-with-timezone> <text>` - schedule one-shot task (example: `2026-03-01T09:00:00+07:00`)
- `!task every <min> <hour> <dom> <mon> <dow> <text> [--tz <timezone>]` - schedule periodic task (cron)
- `!task pause <task-id>` - pause a scheduled task
- `!task resume <task-id>` - resume a paused task
- `!task history <task-id> [limit]` - show recent run history for a task
- `!task failures [limit]` - show recent failed task runs for this chat
- `!task cancel <task-id>` - cancel a task by id (shown in `!task list`)
- `!session status` - show context/session persistence stats for this chat
- `!session reset` - start a fresh context while keeping historical entries on disk
- `!artifact status` - show artifacts root + configured base URL
- `!artifact link <path>` - generate a public URL for an artifact file/path
- `!artifact live <path>` - same as link, with `?ws=true` for live reload

`/` prefix is also accepted (for example `/help`).

If `MOM_WA_OWNER_JIDS` is set, privileged commands are restricted to those JIDs.
The adapter also adds lightweight status reactions on incoming command messages: ⏳ (start), ✅ (success), ❌ (error), ⏹️ (aborted).

## Agent IPC

Agents can write JSON files to `<working-dir>/ipc/<chat-jid>/` to trigger host actions.

Supported IPC message types:

- `message`
- `schedule_task` (`immediate`, `one-shot`, `periodic`)
- `pause_task`
- `resume_task`
- `cancel_task`

IPC watcher only processes files named `ipc-<type>-<timestamp>-<random>.json`.
Write atomically (`.tmp` then rename to `.json`) to avoid partial reads.

## CLI

```bash
mom-whatsapp [options] <working-directory>

Options:
  --sandbox=host
  --sandbox=docker:<container-name>
  --distill-export <path>
  --distill-channel <chat-jid>
```

One-shot group vibe distillation from a WhatsApp export:

```bash
mom-whatsapp --distill-export ~/Downloads/group-chat.txt --distill-channel 1203...@g.us ./data
```

This parses the exported chat text and writes channel-scoped:
- `SOUL.md`
- `MEMORY.md`
- `memory/people.md`
- `memory/running-jokes.md` when repeated bits are detected

If the configured model/API key is available, mom-whatsapp first parses the export deterministically, then asks the model to refine those files from transcript excerpts. If no model auth is available, it falls back to the deterministic distillation only.

Authentication helper:

```bash
npm run wa:auth                    # QR mode
npm run wa:auth -- --pairing-code --phone 14155551234
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MOM_WA_AUTH_DIR` | yes | Directory for Baileys auth/session files |
| `MOM_WA_BOT_NAME` | no | Group trigger token (default: `ujang`) |
| `MOM_WA_GROUP_TRIGGER_ALIASES` | no | CSV extra trigger tokens for groups (e.g. `jang,bro`) |
| `MOM_WA_ALLOWED_GROUPS` | no | CSV allowlist of group JIDs and/or group name fragments |
| `MOM_WA_VERBOSE_DETAILS` | no | `1` to emit tool detail stream to chat, default off |
| `MOM_WA_ARTIFACTS_BASE_URL` | no | Public base URL for artifact links (e.g. Cloudflare Tunnel URL) |
| `MOM_WA_ARTIFACTS_URL_FILE` | no | File containing base URL (default `/tmp/artifacts-url.txt`) |
| `MOM_WA_ARTIFACTS_ROOT` | no | Artifact root directory (default `<working-dir>/artifacts/files`) |
| `MOM_WA_ASSISTANT_HAS_OWN_NUMBER` | no | `0` for shared-number setups (bot prefixes outbound text with bot name) |
| `MOM_WA_MODEL` | no | Default model override, e.g. `anthropic/claude-sonnet-4-6`, `gpt-5.4`, or `fireworks/kimi-k2.5-turbo` |
| `MOM_WA_OWNER_JIDS` | no | Comma-separated owner JIDs allowed to run privileged chat commands (`!model`, `!thinking`, global memory writes) |
| `MOM_WA_PAIRING_PHONE` | no | Optional phone number for `npm run wa:auth` pairing-code mode (digits only, e.g. `14155551234`) |
| `ANTHROPIC_API_KEY` | no* | API key if not using `auth.json` |

## Workspace Layout

```text
<data-dir>/
  SOUL.md
  MEMORY.md
  memory/
  settings.json
  skills/
  events/
  ipc/
  task-runs.jsonl
  <chat-jid>/
    SOUL.md
    MEMORY.md
    memory/
    log.jsonl
    context.jsonl
    attachments/
    scratch/
    skills/
```

On first startup, ujang creates a starter global `SOUL.md` if one does not exist yet. The template is derived from OpenClaw's `SOUL.md` pattern and is meant to be edited, not treated as fixed.

## Notes

- WhatsApp has no Slack-style threads, so details are either suppressed (default) or emitted directly in chat (`MOM_WA_VERBOSE_DETAILS=1`).
- Message edit/delete semantics differ from Slack; final responses are follow-up messages.
- Inbound media without text is still processed and forwarded as attachment context.
- For non-image attachments, ujang attempts automatic text extraction and includes extracted snippets in model context.
- PDF/Office extraction requires `pdftotext` and `unzip` where extraction commands execute: in Docker sandbox mode this runs inside the sandbox container (`./docker.sh create` installs `poppler-utils` + `unzip` there on Debian); in host sandbox mode it uses host-installed binaries.
- When `attach` uploads a file under artifacts root, ujang auto-posts a public artifact URL if configured.
- Shared-number mode (`MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0`) prefixes outbound text with bot name and avoids self-loop processing.

## Security

Use Docker sandbox mode for normal operation. In host mode, commands run directly on your machine.

### Docker mount allowlist

When using Docker sandbox mode, mom-whatsapp validates your working directory against:

- `~/.config/mom-whatsapp/mount-allowlist.json`

If the file does not exist, it is created automatically with your current workspace as the initial allowed root.

The allowlist supports:

- `allowedRoots[]` with `path` + `allowReadWrite`
- `blockedPatterns[]` (for sensitive paths like `.ssh`, `.aws`, etc.)

If validation fails, startup exits with `SANDBOX_MOUNT_NOT_ALLOWED` and prints the allowlist path to edit.

## Troubleshooting

- **QR keeps reappearing / not persisted**: run `npm run wa:auth` again and verify `MOM_WA_AUTH_DIR` is stable/writable.
- **No QR appears / repeated `Connection Failure` during auth**: set `MOM_WA_PAIRING_PHONE` and run `npm run wa:auth` for phone-number pairing mode.
- **No response in group**: verify bot name mention + allowlist match (`MOM_WA_ALLOWED_GROUPS`).
- **Messages delayed after reconnect**: queued outbound messages flush automatically after connection opens.
- **`Permission denied` when writing `/workspace/...` in Docker sandbox**: recreate sandbox container with `./docker.sh remove && ./docker.sh create ./data` (scripts use `--security-opt label=disable` for SELinux hosts).
- **Shared-number loops**: set `MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0`.
- **Logged out event**: run `npm run wa:auth` again, then restart `mom-whatsapp`.

## Development

Helper scripts:

- `./docker.sh create ./data` to create a Debian sandbox container with `node`, `npm`, `python3`, `uv`, `unzip`, and `pdftotext`
- `./dev.sh` for local watch-mode run
- `npm run runtime:checklist` to execute the focused runtime checklist harness

Runtime checklist output:

- Prints strict PASS/FAIL for startup/auth, DM stop flow, group allowlist behavior, shared-number loop prevention, media ingestion, reconnect queue flush, verbose detail toggle, events, and Docker sandbox persistence.
- Saves JSON evidence to `packages/mom-whatsapp/runtime-checklist/report-<timestamp>.json`.
- Note: this harness uses a deterministic fake WhatsApp socket + real events/sandbox execution; run a live phone/QR pass separately before production use.

Key files:

- `src/main.ts` - CLI/startup + per-chat orchestration
- `src/whatsapp.ts` - WhatsApp transport adapter (Baileys)
- `src/agent.ts` - agent runner/session/tool orchestration
- `src/events.ts` - scheduled wakeups
- `src/tasks.ts` - in-chat task CRUD over event files
- `src/store.ts` - persistence/logging
- `src/artifacts.ts` - artifact URL resolution
- `src/attachment-extractor.ts` - document text extraction pipeline
- `src/sandbox.ts` - host/docker execution adapter
