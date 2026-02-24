# mom-whatsapp (Master Of Mischief for WhatsApp)

A WhatsApp bot powered by pi's coding-agent runtime. It executes bash/read/write/edit tools, keeps persistent memory, and is designed to run safely in a Docker sandbox.

## Features

- WhatsApp integration (DMs + group trigger)
- Same core agent/session architecture as `pi-mom`
- Persistent per-chat state (`log.jsonl`, `context.jsonl`, skills, memory)
- Event scheduler (`immediate`, `one-shot`, `periodic`)
- Inbound media download to `attachments/` and prompt context handoff
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
export MOM_WA_BOT_NAME="mom"
# Optional: comma-separated list of allowed group JIDs or name fragments
export MOM_WA_ALLOWED_GROUPS="1203...@g.us,engineering"
# Optional: show tool details/usage lines in chat
export MOM_WA_VERBOSE_DETAILS=0
# Optional: shared-number setup (bot and user use same WA account)
export MOM_WA_ASSISTANT_HAS_OWN_NUMBER=1
# Optional: model override (default: anthropic/claude-sonnet-4-6)
export MOM_WA_MODEL=anthropic/claude-sonnet-4-6
# Optional: fallback phone-number pairing if QR does not appear
export MOM_WA_PAIRING_PHONE=14155551234

# Option 1: Anthropic key
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: OAuth from pi coding agent (auto-detected)
# mom-whatsapp prefers ~/.pi/agent/auth.json if present.
# Optional fallback path: ~/.pi/mom-whatsapp/auth.json

# Recommended: run with Docker sandbox
mom-whatsapp --sandbox=docker:mom-sandbox ./data
```

On first run, scan the QR code printed in the terminal.

## Triggering Behavior

- **DMs**: always trigger the bot.
- **Groups**: trigger when `MOM_WA_BOT_NAME` is mentioned in text (e.g. `@mom` / `mom`), directly mentioned via WhatsApp mention metadata, or when replying to a recent bot-authored message.
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
- `!thinking` - show current thinking level
- `!thinking <off|minimal|low|medium|high|xhigh>` - set thinking level
- `!memory show [global|channel]` - show memory content
- `!memory add <text>` - append to channel memory
- `!memory add --global <text>` - append to global workspace memory

`/` prefix is also accepted (for example `/help`).

If `MOM_WA_OWNER_JIDS` is set, privileged commands are restricted to those JIDs.
The adapter also adds lightweight status reactions on incoming command messages: ⏳ (start), ✅ (success), ❌ (error), ⏹️ (aborted).

## CLI

```bash
mom-whatsapp [options] <working-directory>

Options:
  --sandbox=host
  --sandbox=docker:<container-name>
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MOM_WA_AUTH_DIR` | yes | Directory for Baileys auth/session files |
| `MOM_WA_BOT_NAME` | no | Group trigger token (default: `mom`) |
| `MOM_WA_ALLOWED_GROUPS` | no | CSV allowlist of group JIDs and/or group name fragments |
| `MOM_WA_VERBOSE_DETAILS` | no | `1` to emit tool detail stream to chat, default off |
| `MOM_WA_ASSISTANT_HAS_OWN_NUMBER` | no | `0` for shared-number setups (bot prefixes outbound text with bot name) |
| `MOM_WA_MODEL` | no | Default model override, e.g. `anthropic/claude-sonnet-4-6` |
| `MOM_WA_OWNER_JIDS` | no | Comma-separated owner JIDs allowed to run privileged chat commands (`!model`, `!thinking`, global memory writes) |
| `MOM_WA_PAIRING_PHONE` | no | Optional phone-number auth fallback (digits only, e.g. `14155551234`) to print a pairing code when QR does not arrive |
| `ANTHROPIC_API_KEY` | no* | API key if not using `auth.json` |

## Workspace Layout

```text
<data-dir>/
  MEMORY.md
  settings.json
  skills/
  events/
  <chat-jid>/
    MEMORY.md
    log.jsonl
    context.jsonl
    attachments/
    scratch/
    skills/
```

## Notes

- WhatsApp has no Slack-style threads, so details are either suppressed (default) or emitted directly in chat (`MOM_WA_VERBOSE_DETAILS=1`).
- Message edit/delete semantics differ from Slack; final responses are follow-up messages.
- Inbound media without text is still processed and forwarded as attachment context.
- Shared-number mode (`MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0`) prefixes outbound text with bot name and avoids self-loop processing.

## Security

Use Docker sandbox mode for normal operation. In host mode, commands run directly on your machine.

## Troubleshooting

- **QR keeps reappearing / not persisted**: verify `MOM_WA_AUTH_DIR` is stable and writable.
- **No QR appears and you see `Connection Failure` loops**: set `MOM_WA_PAIRING_PHONE` and link via phone-number pairing code instead.
- **No response in group**: verify bot name mention + allowlist match (`MOM_WA_ALLOWED_GROUPS`).
- **Messages delayed after reconnect**: queued outbound messages flush automatically after connection opens.
- **`Permission denied` when writing `/workspace/...` in Docker sandbox**: recreate sandbox container with `./docker.sh remove && ./docker.sh create ./data` (scripts use `--security-opt label=disable` for SELinux hosts).
- **Shared-number loops**: set `MOM_WA_ASSISTANT_HAS_OWN_NUMBER=0`.
- **Logged out event**: restart and scan QR again.

## Development

Helper scripts:

- `./docker.sh create ./data` to create sandbox container
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
- `src/store.ts` - persistence/logging
- `src/sandbox.ts` - host/docker execution adapter
