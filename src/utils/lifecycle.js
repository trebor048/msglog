import chalk from 'chalk';
import { sleep } from './utils.js';
import { closeDatabase } from './setup.js';

// ============ EVENT HANDLERS ============
export function setupEventHandlers(client, listeningChannels, messageStore, isPaused, storeMessageFn) {
    client.on('messageCreate', async msg => {
        if (msg.author.bot || isPaused || !listeningChannels.has(msg.channel.id)) return;
        try {
            await storeMessageFn([msg], msg.channel);
        } catch (err) {
            console.error(chalk.red('❌ Message store error:', err.message));
        }
    });

    client.on('messageUpdate', async (oldMsg, newMsg) => {
        if (newMsg.author.bot || !listeningChannels.has(newMsg.channel.id)) return;
        try {
            messageStore.updateMessageContent(newMsg.id, newMsg.content, newMsg.editedAt);
        } catch (err) {
            console.error(chalk.red('❌ Message update error:', err.message));
        }
    });

    client.on('messageDelete', msg => {
        if (!listeningChannels.has(msg.channel.id)) return;
        try {
            messageStore.markMessageDeleted(msg.id);
        } catch (err) {
            console.error(chalk.red('❌ Message delete error:', err.message));
        }
    });

    client.on('messageReactionAdd', (reaction, user) => {
        if (user.bot || !listeningChannels.has(reaction.message.channel.id)) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions);
        } catch (err) {
            console.error(chalk.red('❌ Reaction add error:', err.message));
        }
    });

    client.on('messageReactionRemove', (reaction, user) => {
        if (user.bot || !listeningChannels.has(reaction.message.channel.id)) return;
        try {
            messageStore.updateMessageReactions(reaction.message.id, reaction.message.reactions);
        } catch (err) {
            console.error(chalk.red('❌ Reaction remove error:', err.message));
        }
    });
}

// ============ SHUTDOWN HANDLERS ============
export function setupShutdownHandlers(client, db, jobManager, isShuttingDown, gracefulShutdown) {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    setTimeout(() => {
        if (isShuttingDown) {
            console.error(chalk.red('❌ Forced exit: shutdown timed out'));
            process.exit(1);
        }
    }, 3_000).unref();
}

export async function createGracefulShutdown(client, db, jobManager, isShuttingDown, isPaused) {
    return async (reason = 'signal') => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        isPaused = true;

        console.log(chalk.yellow(`\n🛑 Shutting down (${reason})...`));

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
            client.destroy();
            console.log(chalk.green('✅ Discord client destroyed'));
        } catch { }

        try {
            process.removeAllListeners('SIGINT');
            process.removeAllListeners('SIGTERM');
            process.removeAllListeners('unhandledRejection');
            client.removeAllListeners();
        } catch { }

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
