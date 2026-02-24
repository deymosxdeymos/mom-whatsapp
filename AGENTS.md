# Development Rules

## First Message
If the user request is not concrete, read `README.md` and ask which area to work on.

## Code Quality
- No `any` unless absolutely necessary
- Prefer explicit types over inference for public interfaces
- Do not remove intentional functionality without asking first

## Commands
- After code changes (not docs-only): run `npm run check`
- `npm run check` currently runs TypeScript typecheck only
- Do not run long-lived commands unless explicitly requested

## Jujutsu (jj)
- Use `jj` for day-to-day VCS commands
- Never use destructive commands that discard uncommitted work
- Stage specific files only
- Commit only after checks pass and user asks

## Style
- Keep responses concise and technical
- No emojis in commit messages or code comments

## Hooks
- Pre-commit hook is stored in `.githooks/pre-commit`
- Enable it once per clone:
  ```bash
  npm run setup:hooks
  ```
