import fs from 'fs/promises';
import Database from 'better-sqlite3';
import chalk from 'chalk';

// ─── Configuration ────────────────────────────────────────────────────────────

const defaultConfig = {
    databaseFile: './messages.db',
    globalDelay: 1500,
    maxFastRequests: 10,
    maxRateLimitChannels: 10000,
    maxSyncPages: 100000,
    randomDelayMin: 1000,
    randomDelayMax: 2500,
    maxEventQueueSize: 2000,
    deletedRetentionDays: 30,
    downloadAttachments: false,
    downloadTimeoutSeconds: 300,
    retryAttempts: 3,
    retryBaseDelayMs: 800,
    maxConcurrentJobs: 3,
    maxCacheSize: 10000,
    maxFailedReferences: 5000,
    maxReferenceCache: 10000
};

const configSchema = {
    databaseFile: 'string',
    globalDelay: 'number',
    maxFastRequests: 'number',
    maxRateLimitChannels: 'number',
    maxSyncPages: 'number',
    randomDelayMin: 'number',
    randomDelayMax: 'number',
    maxEventQueueSize: 'number',
    deletedRetentionDays: 'number',
    downloadAttachments: 'boolean',
    downloadTimeoutSeconds: 'number',
    retryAttempts: 'number',
    retryBaseDelayMs: 'number',
    maxConcurrentJobs: 'number',
    maxCacheSize: 'number',
    maxFailedReferences: 'number',
    maxReferenceCache: 'number'
};

function validateConfig(config) {
    const errors = [];
    for (const key of Object.keys(config)) {
        if (Object.prototype.hasOwnProperty.call(configSchema, key)) {
            const actual = typeof config[key];
            const expected = configSchema[key];
            if (actual !== expected) {
                errors.push(`Config "${key}" has type ${actual}, expected ${expected}`);
            }
        }
    }
    return errors;
}

function clamp(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function normalizeConfig(config) {
    const normalized = { ...config };
    if (!normalized.databaseFile || typeof normalized.databaseFile !== 'string') {
        normalized.databaseFile = defaultConfig.databaseFile;
    }

    normalized.globalDelay = clamp(normalized.globalDelay, 50, 30000, defaultConfig.globalDelay);
    normalized.maxFastRequests = clamp(normalized.maxFastRequests, 1, 1000, defaultConfig.maxFastRequests);
    normalized.maxRateLimitChannels = clamp(normalized.maxRateLimitChannels, 100, 500000, defaultConfig.maxRateLimitChannels);
    normalized.maxSyncPages = clamp(normalized.maxSyncPages, 1, 1_000_000, defaultConfig.maxSyncPages);
    normalized.randomDelayMin = clamp(normalized.randomDelayMin, 0, 30000, defaultConfig.randomDelayMin);
    normalized.randomDelayMax = clamp(normalized.randomDelayMax, 0, 30000, defaultConfig.randomDelayMax);
    if (normalized.randomDelayMax < normalized.randomDelayMin) {
        normalized.randomDelayMax = normalized.randomDelayMin;
    }
    normalized.maxEventQueueSize = clamp(normalized.maxEventQueueSize, 100, 100000, defaultConfig.maxEventQueueSize);
    normalized.deletedRetentionDays = clamp(normalized.deletedRetentionDays, 1, 3650, defaultConfig.deletedRetentionDays);
    normalized.downloadTimeoutSeconds = clamp(normalized.downloadTimeoutSeconds, 1, 3600, defaultConfig.downloadTimeoutSeconds);
    normalized.retryAttempts = clamp(normalized.retryAttempts, 1, 10, defaultConfig.retryAttempts);
    normalized.retryBaseDelayMs = clamp(normalized.retryBaseDelayMs, 100, 30000, defaultConfig.retryBaseDelayMs);
    normalized.maxConcurrentJobs = clamp(normalized.maxConcurrentJobs, 1, 20, defaultConfig.maxConcurrentJobs);
    normalized.maxCacheSize = clamp(normalized.maxCacheSize, 100, 1_000_000, defaultConfig.maxCacheSize);
    normalized.maxFailedReferences = clamp(normalized.maxFailedReferences, 100, 1_000_000, defaultConfig.maxFailedReferences);
    normalized.maxReferenceCache = clamp(normalized.maxReferenceCache, 100, 1_000_000, defaultConfig.maxReferenceCache);

    return normalized;
}

export async function loadConfig() {
    const config = { ...defaultConfig };
    try {
        const raw = await fs.readFile('./config.json', 'utf-8');
        const parsed = JSON.parse(raw);
        for (const [key, expectedType] of Object.entries(configSchema)) {
            if (Object.prototype.hasOwnProperty.call(parsed, key) && typeof parsed[key] === expectedType) {
                config[key] = parsed[key];
            }
        }

        const validationErrors = validateConfig({ ...config, ...parsed });
        validationErrors.forEach(err => console.warn(chalk.yellow(`⚠️ ${err}`)));
        Object.assign(config, normalizeConfig(config));
    } catch (err) {
        if (err.code === 'ENOENT') {
            await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
        } else {
            console.warn(chalk.yellow('⚠️ Config load error, using defaults:', err.message));
        }
    }
    return config;
}

export async function saveConfig(config) {
    const normalized = normalizeConfig({
        ...defaultConfig,
        ...config
    });
    normalized.downloadAttachments = Boolean(normalized.downloadAttachments);
    return fs.writeFile('./config.json', JSON.stringify(normalized, null, 2));
}

// ─── Database ─────────────────────────────────────────────────────────────────

export function initDatabase(config) {
    try {
        const db = new Database(config.databaseFile);

        // Performance pragmas
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('temp_store = memory');
        db.pragma('cache_size = -64000'); // 64 MB page cache
        db.pragma('foreign_keys = ON');
        db.pragma('mmap_size = 268435456'); // 256 MB memory-mapped I/O

        // ── Core messages table ──────────────────────────────────────────────
        db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id                        TEXT PRIMARY KEY,
                author_id                 TEXT,
                author_tag                TEXT,
                content                   TEXT,
                timestamp                 DATETIME,
                channel_id                TEXT,
                attachments               TEXT,
                embeds                    TEXT,
                reference_message_id      TEXT,
                reference_message_content TEXT,
                reactions                 TEXT    DEFAULT '[]',
                is_bot                    INTEGER DEFAULT 0,
                edited_at                 DATETIME,
                deleted                   INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_channel_id        ON messages (channel_id);
            CREATE INDEX IF NOT EXISTS idx_timestamp         ON messages (timestamp);
            CREATE INDEX IF NOT EXISTS idx_channel_timestamp ON messages (channel_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_author_id         ON messages (author_id);
        `);

        let ftsEnabled = true;
        // ── FTS5 full-text search (discrawl-inspired) ────────────────────────
        // Uses content= so FTS rows reference the messages table by rowid.
        // Triggers keep the index in sync.
        // NOTE: message inserts use INSERT OR IGNORE in storage.js.
        // Update triggers still keep FTS synchronized for edits/deletes.
        try {
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    content,
                    author_tag,
                    content='messages',
                    content_rowid='rowid',
                    tokenize='unicode61 remove_diacritics 1'
                );

                -- Keep FTS in sync with the messages table
                CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, content, author_tag)
                    VALUES (new.rowid, COALESCE(new.content, ''), COALESCE(new.author_tag, ''));
                END;

                CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, author_tag)
                    VALUES ('delete', old.rowid, COALESCE(old.content, ''), COALESCE(old.author_tag, ''));
                END;

                CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, author_tag)
                    VALUES ('delete', old.rowid, COALESCE(old.content, ''), COALESCE(old.author_tag, ''));
                    INSERT INTO messages_fts(rowid, content, author_tag)
                    VALUES (new.rowid, COALESCE(new.content, ''), COALESCE(new.author_tag, ''));
                END;
            `);
        } catch (err) {
            ftsEnabled = false;
            console.warn(chalk.yellow(`⚠️ FTS5 unavailable; falling back to LIKE search (${err.message})`));
        }

        // ── Per-channel sync cursors (discrawl-inspired) ─────────────────────
        // Stores oldest/newest fetched message IDs so every sync is resumable.
        db.exec(`
            CREATE TABLE IF NOT EXISTS channel_sync_state (
                channel_id      TEXT PRIMARY KEY,
                oldest_id       TEXT,               -- oldest message ID fetched (backward cursor)
                newest_id       TEXT,               -- newest message ID fetched (resume cursor)
                total_fetched   INTEGER DEFAULT 0,
                last_synced_at  DATETIME,
                is_complete     INTEGER DEFAULT 0   -- 1 = full history fetched to oldest message
            );
        `);

        // ── App settings KV store ────────────────────────────────────────────
        db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        setSetting(db, 'ftsEnabled', ftsEnabled);

        // ── Schema migration tracking ────────────────────────────────────────
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // ── Schema migrations ────────────────────────────────────────────────
        _runMigrations(db);

        return db;
    } catch (err) {
        throw new Error(`Database init failed: ${err.message}`);
    }
}

function _runMigrations(db) {
    const isApplied = (version) =>
        db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
    const markApplied = (version, name) =>
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);

    if (!isApplied(1)) {
        markApplied(1, 'initial_schema_tracking');
    }

    try {
        const columns = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
        if (!isApplied(2) && !columns.includes('deleted')) {
            db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0');
            markApplied(2, 'add_messages_deleted');
        } else if (!isApplied(2)) {
            markApplied(2, 'add_messages_deleted');
        }

        if (!isApplied(3) && !columns.includes('edited_at')) {
            db.exec('ALTER TABLE messages ADD COLUMN edited_at DATETIME');
            markApplied(3, 'add_messages_edited_at');
        } else if (!isApplied(3)) {
            markApplied(3, 'add_messages_edited_at');
        }
    } catch (err) {
        console.warn(chalk.yellow('Migration warning:'), err.message);
    }

    // Rebuild FTS index if it exists but is empty while messages table has rows
    // (happens when upgrading from a version without FTS)
    try {
        const msgCount = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
        const ftsCount = db.prepare("SELECT COUNT(*) as n FROM messages_fts").get().n;
        if (msgCount > 0 && ftsCount === 0) {
            console.log(chalk.blue('🔍 Building FTS index for existing messages...'));
            db.exec(`INSERT INTO messages_fts(rowid, content, author_tag)
                     SELECT rowid, COALESCE(content,''), COALESCE(author_tag,'') FROM messages`);
            console.log(chalk.green(`✅ FTS index built (${msgCount.toLocaleString()} messages)`));
        }
    } catch {
        // FTS table may not exist yet on very old DBs — that's fine, it was just created above
    }
}

// ─── Settings KV ─────────────────────────────────────────────────────────────

export function getSetting(db, key, defaultValue = null) {
    try {
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        if (row?.value !== undefined) {
            try { return JSON.parse(row.value); } catch { return row.value; }
        }
        return defaultValue;
    } catch {
        return defaultValue;
    }
}

export function setSetting(db, key, value) {
    try {
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.error(chalk.red('❌ Failed to save setting:', err.message));
        return false;
    }
}

// ─── Close ────────────────────────────────────────────────────────────────────

export function closeDatabase(db) {
    try {
        if (db) {
            // TRUNCATE checkpoint: flush WAL fully so the DB file is self-contained
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            db.close();
            console.log(chalk.green('✅ Database closed'));
        }
    } catch (err) {
        console.error(chalk.red('❌ DB close error:', err.message));
    }
}
