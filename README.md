# msg-log

`msg-log` is a local Discord message logger and analytics CLI. It listens to configured text channels, stores messages in SQLite, and provides a Blessed terminal interface for syncing, search, export, health checks, and database maintenance.

> **Warning:** This application uses a Discord user token through `discord.js-selfbot-v13`. Automating a user account violates Discord's Terms of Service and can result in account action. Use it only if you understand and accept that risk.

## Requirements

- Node.js 16 or newer
- A terminal with TTY support for the interactive interface
- A Discord user token in a local `.env` file

## Setup

```powershell
npm install
Copy-Item .env.example .env
Copy-Item config-example.json config.json
```

Set `USER_TOKEN` in `.env`, then start the application:

```powershell
npm start
```

`config.json`, `.env`, databases, logs, downloaded content, exports, and backups are intentionally ignored by Git.

## Validation

```powershell
npm run verify
```

This runs ESLint, the Node.js test suite, and the local doctor command. The doctor validates configuration, opens the configured SQLite database, applies migrations, and verifies the schema.

## Main Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the logger and Blessed TUI |
| `npm run lint` | Lint all JavaScript files |
| `npm test` | Run the Node.js test suite |
| `npm run doctor` | Validate configuration and database startup |
| `npm run verify` | Run all pre-push checks |

## Data Safety

- Keep `.env` and `config.json` local.
- Attachment downloads block common executable extensions and enforce a 100 MB limit.
- Exported files and database backups are written under `exports/` and `backups/`.
- Start historical syncs against a small channel first and monitor the Live Monitor for errors.
