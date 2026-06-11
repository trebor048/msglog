import chalk from 'chalk';
import { closeDatabase } from './setup.js';

export async function cleanupStartupResources({
    client = null,
    db = null,
    teardownProcessErrorHandlers = null,
    teardownEventHandlers = null,
    teardownShutdownHandlers = null
} = {}) {
    try {
        if (typeof teardownProcessErrorHandlers === 'function') {
            teardownProcessErrorHandlers();
        }
    } catch {}
    try {
        if (typeof teardownEventHandlers === 'function') {
            teardownEventHandlers();
        }
    } catch {}
    try {
        if (typeof teardownShutdownHandlers === 'function') {
            teardownShutdownHandlers();
        }
    } catch {}

    try {
        if (client && typeof client.destroy === 'function') {
            client.destroy();
        }
    } catch {}

    closeDatabase(db);
}

export async function handleFatalStartup(stage, err, resources = {}) {
    const message = err?.message ?? String(err);
    const prefix = stage ? `${stage}: ` : '';
    console.error(chalk.red(`❌ ${prefix}${message}`));
    resources.logger?.error?.('Fatal startup error', { stage, error: message });

    await cleanupStartupResources(resources);

    // Avoid hard process termination; allow a coordinated exit path.
    if (!process.exitCode || process.exitCode === 0) {
        process.exitCode = 1;
    }
}
