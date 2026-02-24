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

## Git
- Never use destructive commands (`git reset --hard`, `git checkout .`, `git clean -fd`)
- Stage specific files only (no `git add .`)
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
