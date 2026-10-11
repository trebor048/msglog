import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { loadConfig, initDatabase, closeDatabase } from '../src/utils/setup.js';
import { Validator } from '../src/utils/utils.js';

async function runDoctor() {
    console.log(chalk.blue('🔎 Running msg-log doctor checks...'));

    const config = await loadConfig();
    const configValidation = Validator.validateConfig(config);
    if (!configValidation.valid) {
        console.error(chalk.red('❌ Config validation failed:'));
        for (const err of configValidation.errors) {
            console.error(chalk.red(`  - ${err}`));
        }
        process.exit(1);
    }
    console.log(chalk.green('✅ Config validation passed'));

    // Never run initDatabase/migrations/FTS rebuild against the LIVE database
    // while the app may be running. Work on a temporary copy instead: copy the
    // .db plus any -wal/-shm sidecars, run the checks read-only on the copy,
    // then delete the copy.
    const dbPath = path.resolve(config.databaseFile);
    if (!fs.existsSync(dbPath)) {
        console.log(chalk.yellow(`⚠️ Database file not found (${dbPath}) — skipping DB checks`));
        console.log(chalk.green('✅ Doctor checks completed (config only)'));
        return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-log-doctor-'));
    const tmpDb = path.join(tmpDir, 'doctor.db');
    let db;
    try {
        // Copying a live DB mid-checkpoint can capture a torn page; retry once.
        const copyDb = () => {
            fs.copyFileSync(dbPath, tmpDb);
            for (const sidecar of [dbPath + '-wal', dbPath + '-shm']) {
                if (fs.existsSync(sidecar)) {
                    fs.copyFileSync(sidecar, path.join(tmpDir, path.basename(sidecar)));
                }
            }
        };
        try {
            copyDb();
        } catch (copyErr) {
            console.log(chalk.gray(`  (copy retry after: ${copyErr.message})`));
            try { fs.unlinkSync(tmpDb); } catch {}
            copyDb();
        }
        console.log(chalk.gray(`  (working on temp copy: ${tmpDb})`));

        // Validate the copy is a real SQLite database BEFORE initDatabase opens
        // it read-write. better-sqlite3 defers the header check to the first
        // query, and initDatabase discards its internal handle when that query
        // throws — the file descriptor stays open, so the temp dir can never be
        // deleted (EBUSY/EPERM on Windows). Probing with our own read-only
        // handle, which we always close, both detects non-DB files and avoids
        // the leak.
        let probe = null;
        try {
            probe = new Database(tmpDb, { readonly: true });
            probe.prepare('PRAGMA quick_check(1)').get();
        } catch (probeErr) {
            throw new Error(`Database file is not a readable SQLite database (${probeErr.message})`);
        } finally {
            if (probe) {
                try { probe.close(); } catch {}
            }
        }

        db = initDatabase({ ...config, databaseFile: tmpDb });
        const tableCount = db.prepare(
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).get().count;
        console.log(chalk.green(`✅ Database opened (${tableCount} app table(s) found)`));

        const migrationCount = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get().count;
        console.log(chalk.green(`✅ Migration tracking active (${migrationCount} migration record(s))`));

        const integrity = db.prepare('PRAGMA integrity_check').get();
        if (integrity.integrity_check === 'ok') {
            console.log(chalk.green('✅ Database integrity check passed'));
        } else {
            console.error(chalk.red(`❌ Database integrity issue: ${integrity.integrity_check}`));
            process.exitCode = 1;
        }
    } finally {
        closeDatabase(db);
        // Windows can transiently lock a freshly-written file (antivirus scan,
        // a better-sqlite3 open that just failed still draining its fd), so a
        // single rmSync can fail with EBUSY/EPERM. Retry briefly; if it still
        // fails, surface the error instead of silently leaking temp files.
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                break;
            } catch (err) {
                console.error(chalk.red(`  (temp cleanup attempt ${attempt + 1} failed: ${err.message})`));
                if (attempt < 4) {
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
            }
        }
    }

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
    console.log(chalk.green('✅ Doctor checks completed successfully'));
}

runDoctor().catch((err) => {
    console.error(chalk.red(`❌ Doctor failed: ${err.message}`));
    process.exit(1);
});
