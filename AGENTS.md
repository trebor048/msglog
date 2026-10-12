# AGENTS.md — msg-log

This file contains essential context for AI coding agents working on this project.

---

## Project Overview

`msg-log` is a Discord message logger and analytics tool built as a Node.js CLI application. It connects to Discord as a **selfbot** (user account automation) using `discord.js-selfbot-v13`, listens to configured text channels in real time, stores messages in a local SQLite database, and provides interactive menus for historical syncing, search, export, and database maintenance.

**Important:** This tool uses a Discord user token (`USER_TOKEN`) to operate. Selfbot usage violates Discord's Terms of Service. The project is for educational/personal archiving purposes.

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js >= 20 (ES modules) |
| Discord API | `discord.js-selfbot-v13` v3.5.1 |
| Database | `better-sqlite3` v12.8.0 (SQLite with WAL mode) |
| HTTP client | `axios` v1.x (attachment downloads) |
| CLI UI | `blessed` v0.1.81 (terminal UI framework) |
| Styling | `chalk` v5.3.0 (colored console output) |
| Dates | `moment` v2.30.1 |
| Env vars | `dotenv` v16.4.5 |

---

## Project Structure

```
msg-log/
├── main.js                    # Entry point — imports src/utils/index.js
├── package.json               # Dependencies and npm scripts
├── config.json                # Runtime configuration (gitignored, created at first run)
├── config-example.json        # Example configuration template
├── .env                       # Discord USER_TOKEN (gitignored, sensitive)
├── logs/                      # Daily rotating log files
├── content/                   # Downloaded attachments (created at runtime)
├── exports/                   # JSON/CSV/HTML exports (created at runtime)
├── backups/                   # Database backups (created at runtime)
├── src/
│   ├── blessed-tui/            # Blessed terminal UI (primary interface)
│   │   ├── index.js            # TUI bootstrap & console redirect
│   │   ├── app.js              # Main TUI app — screen navigation
│   │   ├── core/
│   │   │   ├── screen.js       # ScreenManager (blessed screen wrapper)
│   │   │   └── base.js         # Screen base class
│   │   ├── screens/            # 11 interactive screens
│   │   │   ├── MainMenu.js
│   │   │   ├── LiveMonitor.js
│   │   │   ├── StatsScreen.js
│   │   │   ├── HealthScreen.js
│   │   │   ├── SearchScreen.js
│   │   │   ├── ExportScreen.js
│   │   │   ├── DatabaseScreen.js
│   │   │   ├── ConfigScreen.js
│   │   │   ├── ChannelScreen.js
│   │   │   ├── ViewChannelsScreen.js
│   │   │   └── SystemInfoScreen.js
│   │   └── themes/
│   │       └── theme.js        # Centralized color/style constants
│   ├── utils/                  # Core business logic
│   │   ├── index.js           # Bootstrap, AppContext, auto-sync helpers
│   │   ├── setup.js           # Config loader, SQLite schema init & migrations
│   │   ├── storage.js         # MessageStore (inserts, edits, deletes, reactions, attachments)
│   │   ├── syncEngine.js      # SyncEngine (historical fetch with pagination)
│   │   ├── jobManager.js      # JobManager (tracks fetch jobs, colors, logs, previews)
│   │   ├── resilience.js      # CircuitBreaker, retry wrapper, AdaptiveRateLimiter
│   │   ├── lifecycle.js       # Discord event handlers & graceful shutdown
│   │   ├── performance.js     # PerformanceManager (caching, stats, health)
│   │   ├── data.js            # MessageSearch, MessageExporter, DatabaseManager
│   │   ├── utils.js           # Sleep, formatDuration, getFileExtension, Validator
│   │   └── logger.js          # Logger (file logs, in-memory notifications)
```

**Note:** The legacy `src/ui/` (inquirer-based) menu system has been deprecated and removed. All UI is now handled by `src/blessed-tui/`.

---

## Build and Run Commands

```bash
# Install dependencies
npm install

# Start the application (requires .env with USER_TOKEN)
npm start

# Run ESLint on all JS files
npm run lint

# Run the test suite (node:test)
npm test

# Run the doctor (read-only checks on a temp DB copy)
npm run doctor
```

There is **no build step** and **no bundler**. The project runs directly as native ESM Node.js and uses Node's built-in `node:test` runner. Note: `better-sqlite3` v12 requires **Node >= 20**.

---

## Runtime Architecture

### Bootstrap Flow (`src/utils/index.js`)

1. Load `.env` and validate `USER_TOKEN`.
2. Load and validate `config.json` (creates default if missing).
3. Initialize `discord.js-selfbot-v13` Client.
4. Initialize SQLite database (`better-sqlite3`) with WAL mode.
5. Wire up resilience: `CircuitBreaker`, `createWithRetry`, `AdaptiveRateLimiter`.
6. Instantiate `JobManager`, `MessageStore`, `SyncEngine`, `PerformanceManager`, etc.
7. Build `AppContext` — a single container holding all dependencies to avoid deep parameter passing.
8. Set up Discord gateway event handlers (`messageCreate`, `messageUpdate`, `messageDelete`, `messageReactionAdd`, `messageReactionRemove`).
9. Register graceful shutdown handlers for `SIGINT` / `SIGTERM`.
10. Log in to Discord; on `ready`, launch the Blessed TUI via `startBlessedTUI(ctx)`.

### Key Architectural Patterns

- **AppContext container**: All major objects (client, db, config, jobManager, syncEngine, etc.) live in one `AppContext` instance passed around UI functions.
- **Dependency injection via wrappers**: Functions like `downloadAttachment` and `processEmbeds` are wrapped with `withRetry` and `config` before being injected into `SyncEngine` and `MessageStore`.
- **Prepared statement caching**: SQLite prepared statements are lazily initialized and reused on classes like `MessageStore`, `MessageSearch`, and `DatabaseManager`. Some dynamic queries explicitly call `.finalize()` after use.
- **Job-centric sync model**: Every historical fetch creates a `Job` object with logs, recent message previews, status (`running` | `completed` | `error`), and a rotating color.
- **Rate limiting**: `AdaptiveRateLimiter` enforces per-channel delays and adapts based on Discord `X-RateLimit-*` response headers.

---

## Database Schema

SQLite file defined by `config.databaseFile` (default `./messages.db`).

```sql
CREATE TABLE messages (
    id                        TEXT PRIMARY KEY,
    author_id                 TEXT,
    author_tag                TEXT,
    content                   TEXT,
    timestamp                 DATETIME,
    channel_id                TEXT,
    attachments               TEXT,        -- JSON array
    embeds                    TEXT,        -- JSON array
    reference_message_id      TEXT,
    reference_message_content TEXT,
    reactions                 TEXT DEFAULT '[]',
    is_bot                    INTEGER DEFAULT 0,
    edited_at                 DATETIME,
    deleted                   INTEGER DEFAULT 0
);

CREATE INDEX idx_channel_id        ON messages (channel_id);
CREATE INDEX idx_timestamp         ON messages (timestamp);
CREATE INDEX idx_channel_timestamp ON messages (channel_id, timestamp);
CREATE INDEX idx_author_id         ON messages (author_id);
```

### Migrations

At startup, `setup.js` runs `PRAGMA table_info(messages)` and adds `deleted` and `edited_at` columns if missing. New schema changes should follow this pattern.

---

## Configuration

`config.json` is read at startup and auto-created with defaults if absent.

| Key | Default | Description |
|-----|---------|-------------|
| `databaseFile` | `./messages.db` | SQLite database path |
| `globalDelay` | 1500 | Base ms delay between Discord API requests |
| `syncRequestDelayMs` | 300 | Fast pacing between bulk historical-sync fetches (lower = faster catch-up) |
| `maxFastRequests` | 10 | Threshold before adaptive delay increases |
| `randomDelayMin` | 1000 | Minimum jitter ms |
| `randomDelayMax` | 2500 | Maximum jitter ms |
| `downloadAttachments` | false | Whether to download attachments & embed media locally |
| `downloadTimeoutSeconds` | 300 | Axios timeout for media downloads |
| `retryAttempts` | 3 | Retry attempts for failed Discord API calls |
| `retryBaseDelayMs` | 800 | Base exponential-backoff delay |
| `maxConcurrentJobs` | 3 | Max parallel historical sync jobs |
| `maxCacheSize` | 10000 | In-memory cache size limit |
| `maxFailedReferences` | 5000 | Max failed reference message IDs to track |
| `maxReferenceCache` | 10000 | Max resolved reference message contents to cache |
| `maxRateLimitChannels` | 10000 | Per-channel rate-limit state LRU cap |
| `maxSyncPages` | 100000 | Safety cap on fetch pages per sync job |
| `maxEventQueueSize` | 2000 | Max queued live messages before overflow drops |
| `maxQueueWorkers` | 2 | Concurrent workers draining the live-event queue |
| `deletedRetentionDays` | 30 | Days to keep soft-deleted messages before cleanup |

**Environment variables:**
- `USER_TOKEN` — Discord user account token (required).

---

## Code Style Guidelines

- **ES modules only** (`"type": "module"`). Use `import`/`export`.
- **Classes for stateful modules**: `MessageStore`, `SyncEngine`, `JobManager`, `PerformanceManager`, etc.
- **Blessed TUI screens**: All screens follow the pattern: constructor(screen, ctx, onBack) → create() → setupKeyBindings() → [startUpdates()] → destroy().
  - Use `Validator.sanitizeBlessedTags()` on ALL user-controlled strings (Discord message content, author names, channel names, guild names) before rendering in Blessed `tags:true` boxes.
  - Use `Validator.sanitizeErrorMessage()` before displaying error messages in the TUI to avoid leaking internal paths or API details.
  - Import theme constants from `src/blessed-tui/themes/theme.js` for new screens.
- **Console output**: Use `chalk` with emoji prefixes. Common patterns:
  - `✅` success, `❌` error, `⚠️` warning, `📊` stats, `🚀` start, `⏹️` stop
- **Prepared SQLite statements**: Lazy-init in getters like `_getInsertStatement()` and cache on the instance.
- **Error handling**: Wrap most I/O and DB calls in `try/catch`. Log with `chalk.red('❌ ...')`.
- **Path security**: Always use `Validator.validatePathConfinement()` for user-supplied file paths. Use `Validator.validateDatabasePath()` for database file paths.
- **TUI console redirect**: Console output is redirected to `logs/tui-console-*.log` during TUI operation. Sensitive patterns are redacted before writing.

---

## Testing Instructions

The project uses Node's built-in **`node:test`** runner (`npm test`, `node --test test/`). Tests live in `test/` and are **gitignored**, so a fresh clone has no tests — restore them from a prior checkout or copy. Note that the DB-dependent tests (`database-manager`, `message-search`, `exporter-security`, `setup`, `doctor`) require a native `better-sqlite3` binary matching the host platform (run `npm rebuild better-sqlite3` after switching OS). Date-filter tests (`message-search.test.js`, `exporter-security.test.js`) pin `process.env.TZ = 'UTC'` at the top of the file so their date-boundary assertions are deterministic on any machine.

Manual validation against Discord:

1. Ensure `.env` contains a valid `USER_TOKEN`.
2. Run `npm start`.
3. Use the interactive menu to add a listening channel, trigger a sync, and verify messages appear in the SQLite database.
4. Check `logs/` for runtime file logs.

When modifying critical paths (sync engine, storage batch inserts, shutdown logic), run the non-DB tests (`node --test test/lifecycle.test.js test/resilience.test.js test/sync-engine.test.js ...`), then test against a small channel and monitor the live job monitor (`📋 Live Monitor`) for errors.

---

## Security Considerations

- **Selfbot usage is against Discord ToS.** This project requires a user token and operates as a selfbot. Use at your own risk.
- **Token storage**: `USER_TOKEN` lives in `.env`, which is gitignored. Never commit it.
- **Attachment download safety**: `downloadAttachment()` in `storage.js` blocks executable extensions (`.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.js`, `.vbs`) and enforces a 100 MB size cap.
- **SQL injection**: The project uses parameterized prepared statements almost everywhere. Dynamic SQL is limited to internal schema queries.
- **File path sanitization**: `Validator.sanitizeFilename()` strips unsafe characters (including `/` and `\`) and limits length to 255.
- **Path confinement**: `Validator.validatePathConfinement()` blocks directory traversal. `Validator.validateDatabasePath()` ensures database files stay within the project directory. Both are used by ExportScreen and ConfigScreen.
- **Blessed tag injection**: `Validator.sanitizeBlessedTags()` escapes `{` and `}` in user-controlled strings before rendering in Blessed `tags:true` boxes, preventing terminal display corruption via malicious Discord messages.
- **Error message sanitization**: `Validator.sanitizeErrorMessage()` truncates and strips internal paths from error messages displayed in the TUI.
- **Console log redaction**: The TUI console redirect (`src/blessed-tui/index.js`) filters sensitive patterns (Authorization, token, password, secret) before writing to log files.
- **Export confirmation**: ExportScreen shows a confirmation dialog before writing files to disk.
- **Configuration path validation**: ConfigScreen validates database file paths with `Validator.validateDatabasePath()` before saving.

---

## Learned User Preferences

- Prefers multi-wave bug-finding using parallel subagents followed by direct fixes.
- Wants commits pushed immediately after fixes with concise descriptive messages.

## Learned Workspace Facts

- `downloadAttachment` signature is `(url, channelId, filename, withRetry, config, messageId, size)` — all six params must be threaded correctly through wrappers and call sites.
- `processEmbeds` signature is `(embeds, channelId, downloadAttachmentFn, config, messageId, withRetry)` — `withRetry` is the 6th positional arg.
- TUI screens must wrap the initial call in `startUpdates()` with try/catch; the interval callback is already wrapped but the first call is not.
- `formatElapsed` and similar time-formatters must guard against negative/NaN input to avoid garbage UI strings.
- LIKE queries in `data.js` must escape `%` and `_` wildcards with `ESCAPE '\'` to prevent incorrect search results.
- `fs.createWriteStream` in the TUI console redirect needs an `'error'` listener to prevent process crash on I/O errors.
- Cache eviction in `checkMemoryUsage` should delete oldest N entries, not `.clear()` the entire Map.
- The `_seenJobIds` Set in LiveMonitor must be pruned when it grows beyond a threshold to prevent unbounded memory growth.
- Fire-and-forget promises in `app.js` and `autosync.js` should use `Promise.resolve().then(...).catch(...)` to catch synchronous throws.

---

## Deployment Notes

- This is a **long-running CLI process**, not a server. It expects an interactive terminal (`process.stdin.isTTY`).
- Graceful shutdown waits up to ~2 seconds for running sync jobs to reach a safe stopping point before closing the DB and destroying the Discord client.
- Logs rotate daily into `logs/YYYY-MM-DD.log`.
- SQLite WAL mode produces `.db-shm` and `.db-wal` files during runtime.
