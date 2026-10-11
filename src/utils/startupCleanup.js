import chalk from 'chalk';
import { closeDatabase } from './setup.js';

export async function cleanupStartupResources({
    client = null,
    db = null,
    teardownProcessErrorHandlers = null,
    teardownEventHandlers = null,
    teardownShutdownHandlers = null,
    logger = null
} = {}) {
    try {
        if (typeof teardownProcessErrorHandlers === 'function') {
            teardownProcessErrorHandlers();
        }
    } catch {}
    try {
        if (typeof teardownEventHandlers === 'function') {
            await teardownEventHandlers();
        }
    } catch {}
    try {
        if (typeof teardownShutdownHandlers === 'function') {
            teardownShutdownHandlers();
        }
    } catch {}

    try {
        if (client && typeof client.destroy === 'function') {
            await client.destroy();
        }
    } catch {}

    closeDatabase(db);

    try {
        if (logger && typeof logger.flush === 'function') {
            await logger.flush();
        }
    } catch {}
}

export async function handleFatalStartup(stage, err, resources = {}) {
    const message = err?.message ?? String(err);
    const prefix = stage ? `${stage}: ` : '';
    console.error(chalk.red(`❌ ${prefix}${message}`));
    resources.logger?.error?.('Fatal startup error', { stage, error: message });

    // Arm the force-exit BEFORE cleanup so a hanging client.destroy() on a
    // partially-initialized client can't block startup recovery forever.
    let forced = false;
    const forceExit = setTimeout(() => {
        if (!forced) { forced = true; process.exit(process.exitCode ?? 1); }
    }, 3_000);
    if (typeof forceExit.unref === 'function') forceExit.unref();

    try {
        await cleanupStartupResources(resources);
    } finally {
        clearTimeout(forceExit);
    }

    // Terminal — process is in an unrecoverable state after cleanup.
    // Set exitCode rather than hard-exiting so pending microtasks/test
    // assertions can complete; the unref'd fallback forces the exit if a stray
    // handle (socket/timer) would otherwise keep the loop alive.
    if (!process.exitCode || process.exitCode === 0) {
        process.exitCode = 1;
    }
    // Skip the force-exit fallback in tests so it can't kill the runner mid-suite.
    if (process.env.NODE_ENV !== 'test') {
        const fallbackExit = setTimeout(() => process.exit(process.exitCode ?? 1), 2_000);
        if (typeof fallbackExit.unref === 'function') fallbackExit.unref();
    }
}
