import fs from 'fs/promises';
import Database from 'better-sqlite3';
import chalk from 'chalk';

// ─── Configuration ────────────────────────────────────────────────────────────

const defaultConfig = {
    databaseFile: './messages.db',
    globalDelay: 1500,
    maxFastRequests: 10,
    randomDelayMin: 1000,
    randomDelayMax: 2500,
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
    randomDelayMin: 'number',
    randomDelayMax: 'number',
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
    for (const key of Object.keys(config)) {
        if (Object.prototype.hasOwnProperty.call(configSchema, key)) {
            const actual = typeof config[key];
            const expected = configSchema[key];
            if (actual !== expected) {
                console.warn(`Config "${key}" has type ${actual}, expected ${expected}`);
            }
        }
    }
}

export async function loadConfig() {
    const config = { ...defaultConfig };
    try {
        const raw = await fs.readFile('./config.json', 'utf-8');
        Object.assign(config, JSON.parse(raw));
        validateConfig(config);
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
    return fs.writeFile('./config.json', JSON.stringify(config, null, 2));
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

        // ── FTS5 full-text search (discrawl-inspired) ────────────────────────
        // Uses content= so FTS rows reference the messages table by rowid.
        // Triggers keep the index in sync.
        // NOTE: We use INSERT OR REPLACE (not INSERT OR IGNORE) for messages so
        // the after-insert trigger always fires correctly.
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

        // ── Schema migrations ────────────────────────────────────────────────
        _runMigrations(db);

        return db;
    } catch (err) {
        console.error(chalk.red('❌ Database init failed:', err.message));
        process.exit(1);
    }
}

function _runMigrations(db) {
    try {
        const columns = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
        if (!columns.includes('deleted'))   db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0');
        if (!columns.includes('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at DATETIME');
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
