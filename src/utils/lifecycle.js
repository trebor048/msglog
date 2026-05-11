import chalk from 'chalk';
import { sleep } from './utils.js';
import { closeDatabase } from './setup.js';

// ============ EVENT HANDLERS ============
export function setupEventHandlers(client, listeningChannels, messageStore, isPausedFn, storeMessageFn, logger = null) {
    client.on('messageCreate', async msg => {
        if (msg.author?.bot || (isPausedFn && isPausedFn()) || !msg.channel?.id || !listeningChannels.has(msg.channel.id)) return;
        try {
            await storeMessageFn([msg], msg.channel);
        } catch (err) {
            console.error(chalk.red('❌ Message store error:', err.message));
            logger?.error('Message store error', { error: err.message, messageId: msg.id });
        }
    });

    client.on('messageUpdate', async (oldMsg, newMsg) => {
        if (newMsg.author?.bot || !newMsg.channel?.id || !listeningChannels.has(newMsg.channel.id)) return;
        if (newMsg.content === undefined) return;
        try {
            messageStore.updateMessageContent(newMsg.id, newMsg.content, newMsg.editedAt);
        } catch (err) {
            console.error(chalk.red('❌ Message update error:', err.message));
            logger?.error('Message update error', { error: err.message, messageId: newMsg.id });
        }
    });

    client.on('messageDelete', msg => {
        if (!msg.channel?.id || !listeningChannels.has(msg.channel.id)) return;
        try {
            messageStore.markMessageDeleted(msg.id);
        } catch (err) {
            console.error(chalk.red('❌ Message delete error:', err.message));
            logger?.error('Message delete error', { error: err.message, messageId: msg.id });
        }
    });

    client.on('messageReactionAdd', (reaction, user) => {
        if (user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
        if (!reaction.message?.reactions?.cache) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions.cache);
        } catch (err) {
            console.error(chalk.red('❌ Reaction add error:', err.message));
            logger?.error('Reaction add error', { error: err.message });
        }
    });

    client.on('messageReactionRemove', (reaction, user) => {
        if (user.bot || !reaction.message?.channel?.id || !listeningChannels.has(reaction.message.channel.id)) return;
        if (!reaction.message?.reactions?.cache) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions.cache);
        } catch (err) {
            console.error(chalk.red('❌ Reaction remove error:', err.message));
            logger?.error('Reaction remove error', { error: err.message });
        }
    });
}

// ============ SHUTDOWN HANDLERS ============
export function setupShutdownHandlers(client, db, jobManager, ctx, gracefulShutdown) {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

export async function createGracefulShutdown(client, db, jobManager, ctx, logger = null) {
    return async (reason = 'signal') => {
        if (ctx.isShuttingDown) return;
        ctx.isShuttingDown = true;
        ctx.isPaused = true;

        // Restore console before printing shutdown messages
        if (ctx._restoreConsole) {
            ctx._restoreConsole();
            ctx._restoreConsole = null;
        }

        console.log(chalk.yellow(`\n🛑 Shutting down (${reason})...`));
        logger?.info('Shutting down', { reason });

        // Force exit if graceful shutdown hangs
        setTimeout(() => {
            console.error(chalk.red('❌ Forced exit: shutdown timed out'));
            process.exit(1);
        }, 5_000).unref();

        // Stop accepting new Discord events first
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
        }

        closeDatabase(db);

        try {
            if (process.stdin && !process.stdin.destroyed) {
                process.stdin.pause();
                process.stdin.unref();
            }
        } catch { }

        console.log(chalk.green('✅ Shutdown complete'));
        process.exit(0);
    };
}
