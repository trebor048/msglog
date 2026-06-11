import chalk from 'chalk';
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

    let db;
    try {
        db = initDatabase(config);
        const tableCount = db.prepare(
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).get().count;
        console.log(chalk.green(`✅ Database opened (${tableCount} app table(s) found)`));

        const migrationCount = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get().count;
        console.log(chalk.green(`✅ Migration tracking active (${migrationCount} migration record(s))`));
    } finally {
        closeDatabase(db);
    }

    console.log(chalk.green('✅ Doctor checks completed successfully'));
}

runDoctor().catch((err) => {
    console.error(chalk.red(`❌ Doctor failed: ${err.message}`));
    process.exit(1);
});
