import fs from 'fs/promises';
import Database from 'better-sqlite3';
import chalk from 'chalk';

// ============ CONFIGURATION ============
const defaultConfig = {
    databaseFile: './messages.db',
    globalDelay: 500,
    maxFastRequests: 10,
    randomDelayMin: 1000,
    randomDelayMax: 2500,
    downloadAttachments: false,
    downloadTimeoutSeconds: 300,
    retryAttempts: 3,
    retryBaseDelayMs: 800,
    maxConcurrentJobs: 5,
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
    for (const [key, value] of Object.entries(config)) {
        if (configSchema.hasOwnProperty(key)) {
            const expectedType = configSchema[key];
            const actualType = typeof config[key];
            if (actualType !== expectedType) {
                console.warn(`Config ${key} has type ${actualType}, expected ${expectedType}`);
            }
        }
    }
}

export async function loadConfig() {
    const config = { ...defaultConfig };
    try {
        const configData = JSON.parse(await fs.readFile('./config.json', 'utf-8'));
        Object.assign(config, configData);
        validateConfig(config);
    } catch {
        await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
    }
    return config;
}

export async function saveConfig(config) {
    return fs.writeFile('./config.json', JSON.stringify(config, null, 2));
}

// ============ DATABASE ============
export function initDatabase(config) {
    try {
        const db = new Database(config.databaseFile);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
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
            CREATE INDEX IF NOT EXISTS idx_channel_id ON messages (channel_id);
            CREATE INDEX IF NOT EXISTS idx_timestamp  ON messages (timestamp);
        `);

        try {
            const columns = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
            if (!columns.includes('deleted')) db.prepare("ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0").run();
            if (!columns.includes('edited_at')) db.prepare("ALTER TABLE messages ADD COLUMN edited_at DATETIME").run();
        } catch (migrationErr) {
            console.warn(chalk.yellow('Migration warning:'), migrationErr.message);
        }

        return db;
    } catch (err) {
        console.error(chalk.red('❌ Database init failed:', err.message));
        process.exit(1);
    }
}

export function closeDatabase(db) {
    try {
        if (db) {
            db.close();
            console.log(chalk.green('✅ Database closed'));
        }
    } catch (err) {
        console.error(chalk.red('❌ DB close error:', err.message));
    }
}
