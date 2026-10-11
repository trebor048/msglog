import chalk from 'chalk';
import { sleep } from './utils.js';
import { closeDatabase } from './setup.js';

// ============ EVENT HANDLERS ============
export function setupEventHandlers(client, listeningChannels, messageStore, isPausedFn, storeMessageFn, logger = null, config = {}, runtimeMetrics = null) {
    const queue = [];
    let queueHead = 0;
    const maxEventQueueSize = Math.max(100, Number(config.maxEventQueueSize ?? 2000));
    const overflowLogIntervalMs = 5000;
    let droppedSinceLastLog = 0;
    let totalDropped = 0;
    let lastOverflowLogAt = 0;
    // Small worker pool instead of a single-flight flag: one slow message (e.g. a
    // long attachment download) blocks only its own slot, so the rest of the
    // queue keeps draining and overflow drops become rare. Writes stay safe
    // because better-sqlite3 is synchronous (transactions never interleave).
    const maxQueueWorkers = Math.max(1, Number(config.maxQueueWorkers ?? 2));
    let activeWorkers = 0;
    if (runtimeMetrics) {
        runtimeMetrics.maxEventQueueSize = maxEventQueueSize;
    }

    const getQueueSize = () => queue.length - queueHead;
    const enqueue = (msg) => {
        queue.push(msg);
    };
    const dequeue = () => {
        if (queueHead >= queue.length) return null;
        const msg = queue[queueHead];
        queueHead++;
        if (queueHead > 1000 && queueHead * 2 > queue.length) {
            queue.splice(0, queueHead);
            queueHead = 0;
        }
        return msg;
    };

    const processQueue = async () => {
        if (activeWorkers >= maxQueueWorkers) return;
        activeWorkers++;
        try {
            while (getQueueSize() > 0) {
                if (isPausedFn && isPausedFn()) break;
                const msg = dequeue();
                if (!msg) continue;
                if (!msg.channel?.id || !listeningChannels.has(msg.channel.id)) continue;
                try {
                    await storeMessageFn([msg], msg.channel);
                    if (runtimeMetrics) {
                        runtimeMetrics.queuedMessagesProcessed++;
                    }
                } catch (err) {
                    console.error(chalk.red('❌ Message store error:', err.message));
                    logger?.error('Message store error', { error: err.message, messageId: msg.id });
                }
            }
        } finally {
            activeWorkers--;
            if (runtimeMetrics) {
                runtimeMetrics.eventQueueSize = getQueueSize();
            }
        }
    };

    // Spawn a pump if a slot is free (deferred via setImmediate so a worker that
    // just finished a slow message can't synchronously re-enter and blow the stack).
    const ensurePump = () => {
        if (getQueueSize() > 0 && activeWorkers < maxQueueWorkers && !(isPausedFn && isPausedFn())) {
            setImmediate(() => {
                processQueue().catch(err => {
                    console.error(chalk.red('❌ Queue processor error:', err.message));
                    logger?.error('Queue processor error', { error: err.message });
                });
            });
        }
    };

    const onMessageCreate = msg => {
        if (msg.author?.bot || !msg.channel?.id || !listeningChannels.has(msg.channel.id)) return;
        if (getQueueSize() >= maxEventQueueSize) {
            totalDropped++;
            droppedSinceLastLog++;
            if (runtimeMetrics) {
                runtimeMetrics.queuedMessagesDropped++;
            }
            const now = Date.now();
            if (now - lastOverflowLogAt >= overflowLogIntervalMs) {
                logger?.warn('Message queue overflow; dropping messages', {
                    queueSize: getQueueSize(),
                    maxQueueSize: maxEventQueueSize,
                    droppedInInterval: droppedSinceLastLog,
                    totalDropped
                });
                droppedSinceLastLog = 0;
                lastOverflowLogAt = now;
            }
            return;
        }
        enqueue(msg);
        if (runtimeMetrics) {
            runtimeMetrics.eventQueueSize = getQueueSize();
        }
        ensurePump();
    };
    client.on('messageCreate', onMessageCreate);

    const queueTick = setInterval(() => {
        if (!getQueueSize()) return;
        ensurePump();
    }, 250);
    if (typeof queueTick.unref === 'function') queueTick.unref();

    const onMessageUpdate = async (oldMsg, newMsg) => {
        if (newMsg.partial) {
            try { await newMsg.fetch(); } catch { return; }
        }
        if (newMsg.author?.bot || !newMsg.channel?.id || !listeningChannels.has(newMsg.channel.id)) return;
        if (newMsg.content === undefined || newMsg.content === null) return;
        try {
            messageStore.updateMessageContent(newMsg.id, newMsg.content, newMsg.editedAt);
        } catch (err) {
            console.error(chalk.red('❌ Message update error:', err.message));
            logger?.error('Message update error', { error: err.message, messageId: newMsg.id });
        }
    };
    client.on('messageUpdate', onMessageUpdate);

    const onMessageDelete = msg => {
        if (!msg?.id) return;
        if (!msg.channel?.id || !listeningChannels.has(msg.channel.id)) return;
        try {
            messageStore.markMessageDeleted(msg.id);
        } catch (err) {
            console.error(chalk.red('❌ Message delete error:', err.message));
            logger?.error('Message delete error', { error: err.message, messageId: msg.id });
        }
    };
    client.on('messageDelete', onMessageDelete);

    // Bulk deletions (purges, channel clears) fire messageDeleteBulk with a
    // Collection of (possibly partial) messages — without this, purged messages
    // would stay marked live in the DB forever.
    const onMessageDeleteBulk = messages => {
        for (const msg of messages.values()) {
            if (!msg?.id) continue;
            if (!msg.channel?.id || !listeningChannels.has(msg.channel.id)) continue;
            try {
                messageStore.markMessageDeleted(msg.id);
            } catch (err) {
                console.error(chalk.red('❌ Bulk delete error:', err.message));
                logger?.error('Bulk delete error', { error: err.message, messageId: msg.id });
            }
        }
    };
    client.on('messageDeleteBulk', onMessageDeleteBulk);

    const onReactionAdd = (reaction, user) => {
        if (!user || user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
        if (!reaction.message?.reactions?.cache) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions.cache);
        } catch (err) {
            console.error(chalk.red('❌ Reaction add error:', err.message));
            logger?.error('Reaction add error', { error: err.message });
        }
    };
    client.on('messageReactionAdd', onReactionAdd);

    const onReactionRemove = (reaction, user) => {
        if (!user || user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
        if (!reaction.message?.reactions?.cache) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions.cache);
        } catch (err) {
            console.error(chalk.red('❌ Reaction remove error:', err.message));
            logger?.error('Reaction remove error', { error: err.message });
        }
    };
    client.on('messageReactionRemove', onReactionRemove);

    // "Clear all reactions" on a message — resets its reaction list to empty
    // instead of leaving a stale count.
    const onReactionRemoveAll = message => {
        if (!message?.id || !message.channel?.id || !listeningChannels.has(message.channel.id)) return;
        try {
            messageStore.updateMessageReactions(message.id, []);
        } catch (err) {
            console.error(chalk.red('❌ Reaction clear error:', err.message));
            logger?.error('Reaction clear error', { error: err.message, messageId: message.id });
        }
    };
    client.on('messageReactionRemoveAll', onReactionRemoveAll);

    return async () => {
        clearInterval(queueTick);
        client.off('messageCreate', onMessageCreate);
        client.off('messageUpdate', onMessageUpdate);
        client.off('messageDelete', onMessageDelete);
        client.off('messageDeleteBulk', onMessageDeleteBulk);
        client.off('messageReactionAdd', onReactionAdd);
        client.off('messageReactionRemove', onReactionRemove);
        client.off('messageReactionRemoveAll', onReactionRemoveAll);
        // Best-effort drain of the in-memory queue so pending writes aren't lost.
        // Only reachable from teardown (all Discord listeners already detached),
        // so no new enqueues can occur — flush whatever fits in the budget.
        // The drain MUST be bounded: each queued message can trigger a
        // reference-content fetch and/or an attachment download (each retried
        // several times), so an unbounded loop could stall shutdown for minutes
        // behind a large backlog. Messages dropped here are re-fetched by the
        // next resume sync.
        const drain = async () => {
            const drainDeadline = Date.now() + 4000;
            while (getQueueSize() > 0) {
                const msg = dequeue();
                if (!msg) continue;
                if (!msg.channel?.id || !listeningChannels.has(msg.channel.id)) continue;
                const remainingMs = drainDeadline - Date.now();
                if (remainingMs <= 0) break;
                // Cap each store so a single hung download can't stall shutdown.
                // A store abandoned by the race keeps running in the background —
                // never let it reject unhandled; its writes either complete
                // before the DB closes or fail harmlessly afterwards.
                const storePromise = Promise.resolve().then(() => storeMessageFn([msg], msg.channel));
                storePromise.catch(() => {});
                const stored = await Promise.race([
                    storePromise.then(() => true, () => false),
                    sleep(Math.min(remainingMs, 1000))
                ]);
                if (stored === true && runtimeMetrics) runtimeMetrics.queuedMessagesProcessed++;
            }
            if (runtimeMetrics) runtimeMetrics.eventQueueSize = getQueueSize();
        };
        try { await drain(); } catch {}
        // Wait briefly for any worker that already dequeued a message and is
        // mid-store (attachment downloads can take seconds) so shutdown doesn't
        // close the DB underneath an in-flight write.
        const workersDeadline = Date.now() + 3_000;
        while (activeWorkers > 0 && Date.now() < workersDeadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
}

// ============ SHUTDOWN HANDLERS ============
export function setupShutdownHandlers(client, db, jobManager, ctx, gracefulShutdown) {
    const onSigInt = () => gracefulShutdown('SIGINT');
    const onSigTerm = () => gracefulShutdown('SIGTERM');
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    return () => {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
    };
}

export function setupProcessErrorHandlers(gracefulShutdown, logger = null) {
    const onUnhandledRejection = (reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        console.error(chalk.red(`❌ Unhandled rejection: ${message}`));
        logger?.error('Unhandled rejection', { error: message });
        Promise.resolve(gracefulShutdown('unhandledRejection', { exitCode: 1 })).catch(() => {});
    };

    const onUncaughtException = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`❌ Uncaught exception: ${message}`));
        logger?.error('Uncaught exception', { error: message });
        Promise.resolve(gracefulShutdown('uncaughtException', { exitCode: 1 })).catch(() => {});
    };

    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    return () => {
        process.off('unhandledRejection', onUnhandledRejection);
        process.off('uncaughtException', onUncaughtException);
    };
}

export async function createGracefulShutdown(client, db, jobManager, ctx, logger = null) {
    return async (reason = 'signal', options = {}) => {
        const requestedExitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
        if (ctx.isShuttingDown) {
            ctx.shutdownExitCode = Math.max(ctx.shutdownExitCode ?? 0, requestedExitCode);
            return;
        }
        ctx.shutdownExitCode = requestedExitCode;
        ctx.isShuttingDown = true;

        // Restore console before printing shutdown messages
        if (ctx._restoreConsole) {
            ctx._restoreConsole();
            ctx._restoreConsole = null;
        }

        console.log(chalk.yellow(`\n🛑 Shutting down (${reason})...`));
        logger?.info('Shutting down', { reason });

        if (ctx.autoSyncInterval) {
            clearInterval(ctx.autoSyncInterval);
            ctx.autoSyncInterval = null;
            ctx.autoSyncEnabled = false;
        }

        // Stop accepting new Discord events first. Temporarily clear a manual
        // pause so the teardown drain can actually flush queued messages (the
        // realtime store guard gates on ctx.isPaused).
        ctx.isPaused = false;
        try {
            if (typeof ctx.teardownEventHandlers === 'function') {
                await ctx.teardownEventHandlers();
                ctx.teardownEventHandlers = null;
            }
        } catch {}
        // Realtime queue has been drained by teardown; now pause any remaining
        // processing so nothing new is enqueued.
        ctx.isPaused = true;
        try {
            if (typeof ctx.teardownShutdownHandlers === 'function') {
                ctx.teardownShutdownHandlers();
                ctx.teardownShutdownHandlers = null;
            }
        } catch {}
        try {
            if (typeof ctx.teardownProcessErrorHandlers === 'function') {
                ctx.teardownProcessErrorHandlers();
                ctx.teardownProcessErrorHandlers = null;
            }
        } catch {}

        // Force exit if graceful shutdown hangs. Started AFTER the teardown drain
        // so a legitimately slow drain (attachment downloads) isn't cut short.
        const forceExitTimer = setTimeout(() => {
            console.error(chalk.red('❌ Forced exit: shutdown timed out'));
            process.exit(1);
        }, 5_000).unref();

        try {
            client.destroy();
            console.log(chalk.green('✅ Discord client destroyed'));
        } catch { }

        const deadline = Date.now() + 2_000;
        const running = jobManager.getAllJobs().filter(j => j.status === 'running');
        if (running.length) {
            console.log(chalk.yellow(`⏳ Waiting for ${running.length} job(s) to reach a safe stop point...`));
            while (Date.now() < deadline) {
                const stillRunning = jobManager.getAllJobs().filter(j => j.status === 'running');
                if (!stillRunning.length) break;
                await sleep(50);
            }
            jobManager.getAllJobs()
                .filter(j => j.status === 'running')
                .forEach(j => {
                    jobManager.logToJob(j.id, '🛑 Job stopped due to shutdown');
                    jobManager.setJobError(j.id, 'Stopped due to shutdown');
                    jobManager.updateJobStatus(j.id, 'error', j.totalMessages);
                });
        }

        if (ctx.messageStore?.finalizeAllStatements) {
            try { ctx.messageStore.finalizeAllStatements(); } catch {}
        }
        try {
            if (logger && typeof logger.flush === 'function') await logger.flush();
        } catch {}
        closeDatabase(db);

        try {
            if (process.stdin && !process.stdin.destroyed) {
                process.stdin.pause();
                process.stdin.unref();
            }
        } catch { }

        clearTimeout(forceExitTimer);
        console.log(chalk.green('✅ Shutdown complete'));
        process.exit(ctx.shutdownExitCode ?? requestedExitCode);
    };
}
