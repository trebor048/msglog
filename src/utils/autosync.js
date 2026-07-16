import chalk from 'chalk';

export function startAutoSync(ctx) {
    if (ctx.autoSyncEnabled || !ctx.listeningChannels.size) return;

    ctx.autoSyncEnabled = true;
    const mins = (ctx.autoSyncIntervalMs / 1000 / 60).toFixed(0);
    console.log(chalk.green(`✅ Autosync enabled (every ${mins} minutes)`));

    const runSync = async () => {
        if (ctx.isShuttingDown || ctx.isPaused) return;

        const running = ctx.jobManager.getAllJobs().filter(j => j.status === 'running');
        if (running.length >= ctx.config.maxConcurrentJobs) return;

        await ctx.syncEngine.syncAllChannelsParallel(
            ctx.client,
            ctx.listeningChannels,
            ctx.withRetry,
            () => ctx.isShuttingDown,
            () => ctx.isPaused
        );
    };

    // Run immediately on startup, but don't block
    runSync().catch(err => {
        console.error(chalk.red('❌ Autosync run failed:', err.message));
        ctx.logger?.error('Autosync run failed', { error: err.message });
    });

    ctx.autoSyncInterval = setInterval(() => {
        if (ctx.isShuttingDown) {
            clearInterval(ctx.autoSyncInterval);
            ctx.autoSyncInterval = null;
            return;
        }
        runSync().catch(err => {
            console.error(chalk.red('❌ Autosync run failed:', err.message));
            ctx.logger?.error('Autosync run failed', { error: err.message });
        });
    }, ctx.autoSyncIntervalMs);

    if (typeof ctx.autoSyncInterval?.unref === 'function') {
        ctx.autoSyncInterval.unref();
    }
}

export function stopAutoSync(ctx) {
    if (!ctx.autoSyncEnabled) return;

    ctx.autoSyncEnabled = false;
    if (ctx.autoSyncInterval) {
        clearInterval(ctx.autoSyncInterval);
        ctx.autoSyncInterval = null;
    }
    console.log(chalk.yellow('⏹️ Autosync disabled'));
}
