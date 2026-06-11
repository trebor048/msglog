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
    let processing = false;
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
        if (processing) return;
        processing = true;
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
            if (runtimeMetrics) {
                runtimeMetrics.eventQueueSize = getQueueSize();
            }
        } finally {
            processing = false;
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
        processQueue().catch(err => {
            console.error(chalk.red('❌ Queue processor error:', err.message));
            logger?.error('Queue processor error', { error: err.message });
        });
    };
    client.on('messageCreate', onMessageCreate);

    const queueTick = setInterval(() => {
        if (!getQueueSize()) return;
        processQueue().catch(err => {
            console.error(chalk.red('❌ Queue processor error:', err.message));
            logger?.error('Queue processor error', { error: err.message });
        });
    }, 250);
    if (typeof queueTick.unref === 'function') queueTick.unref();

    const onMessageUpdate = async (oldMsg, newMsg) => {
        if (newMsg.partial) {
            try { await newMsg.fetch(); } catch { return; }
        }
        if (newMsg.author?.bot || !newMsg.channel?.id || !listeningChannels.has(newMsg.channel.id)) return;
        if (newMsg.content === undefined) return;
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

    const onReactionAdd = (reaction, user) => {
        if (user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
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
        if (user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
        if (!reaction.message?.reactions?.cache) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions.cache);
        } catch (err) {
            console.error(chalk.red('❌ Reaction remove error:', err.message));
            logger?.error('Reaction remove error', { error: err.message });
        }
    };
    client.on('messageReactionRemove', onReactionRemove);

    return () => {
        clearInterval(queueTick);
        client.off('messageCreate', onMessageCreate);
        client.off('messageUpdate', onMessageUpdate);
        client.off('messageDelete', onMessageDelete);
        client.off('messageReactionAdd', onReactionAdd);
        client.off('messageReactionRemove', onReactionRemove);
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
        ctx.isPaused = true;

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

        // Force exit if graceful shutdown hangs
        const forceExitTimer = setTimeout(() => {
            console.error(chalk.red('❌ Forced exit: shutdown timed out'));
            process.exit(1);
        }, 5_000).unref();

        // Stop accepting new Discord events first
        try {
            if (typeof ctx.teardownEventHandlers === 'function') {
                ctx.teardownEventHandlers();
                ctx.teardownEventHandlers = null;
            }
        } catch {}
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
