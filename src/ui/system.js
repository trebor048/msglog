import chalk from 'chalk';
import inquirer from 'inquirer';
import { resetStdin, formatDuration } from '../utils/utils.js';

export async function showSystemInfo(statsTracker, cache, logger, loggerInstance) {
    console.clear();
    const stats = statsTracker.getStats();

    console.log(chalk.cyan('📊 System Information\n'));
    console.log(chalk.gray('═'.repeat(60)));

    console.log(chalk.green('📈 Statistics:'));
    console.log(`  Messages Fetched: ${chalk.cyan(stats.totalMessagesFetched)}`);
    console.log(`  Messages Stored: ${chalk.cyan(stats.totalMessagesStored)}`);
    console.log(`  Attachments Downloaded: ${chalk.cyan(stats.totalAttachmentsDownloaded)}`);
    console.log(`  Total Syncs: ${chalk.cyan(stats.totalSyncs)}`);
    console.log(`  Total Searches: ${chalk.cyan(stats.totalSearches)}`);
    console.log(`  Total Exports: ${chalk.cyan(stats.totalExports)}`);
    console.log(`  Total Errors: ${chalk.red(stats.totalErrors)}`);

    console.log(chalk.green('\n⏱️ Uptime:'));
    console.log(`  ${chalk.cyan(formatDuration(stats.uptime))}`);

    console.log(chalk.green('\n💾 Cache:'));
    const cacheStats = cache.getStats();
    console.log(`  Size: ${chalk.cyan(cacheStats.size)} / ${cacheStats.maxSize}`);
    console.log(`  Utilization: ${chalk.cyan(cacheStats.utilization)}`);

    console.log(chalk.green('\n🔔 Notifications:'));
    const notifStats = loggerInstance.getStats();
    console.log(`  Total: ${chalk.cyan(notifStats.total)}`);
    console.log(`  Unread: ${chalk.yellow(notifStats.unread)}`);
    console.log(`  Success: ${chalk.green(notifStats.byType.success)}`);
    console.log(`  Errors: ${chalk.red(notifStats.byType.error)}`);
    console.log(`  Warnings: ${chalk.yellow(notifStats.byType.warn)}`);

    if (stats.lastSync) {
        console.log(chalk.green('\n🔄 Last Sync:'));
        console.log(`  Channel: ${chalk.cyan(stats.lastSync.channelId)}`);
        console.log(`  Messages: ${chalk.cyan(stats.lastSync.messageCount)}`);
        console.log(`  Time: ${chalk.cyan(stats.lastSync.timestamp)}`);
    }

    if (stats.lastError) {
        console.log(chalk.red('\n❌ Last Error:'));
        console.log(`  ${chalk.red(stats.lastError.message)}`);
        console.log(`  Time: ${chalk.cyan(stats.lastError.timestamp)}`);
    }

    console.log(chalk.gray('═'.repeat(60)));

    resetStdin();
    await inquirer.prompt([{ type: 'input', name: 'continue', message: '\nPress Enter to continue...' }]);
}

export async function showNotifications(logger) {
    console.clear();
    const notifs = logger.getNotifications();

    if (!notifs.length) {
        console.log(chalk.yellow('No notifications'));
        return;
    }

    console.log(chalk.cyan('🔔 Notifications\n'));
    console.log(chalk.gray('═'.repeat(60)));

    notifs.slice(-20).reverse().forEach(n => {
        const icon = n.read ? '  ' : '🔴';
        const color = n.type === 'error' ? chalk.red : n.type === 'warning' ? chalk.yellow : chalk.green;
        console.log(`${icon} ${color(n.title)}`);
        console.log(`   ${n.data ? JSON.stringify(n.data) : ''}`);
        console.log(`   ${chalk.gray(n.timestamp)}`);
        console.log();
    });

    console.log(chalk.gray('═'.repeat(60)));

    resetStdin();
    await inquirer.prompt([{ type: 'input', name: 'continue', message: '\nPress Enter to continue...' }]);
}

export async function showCacheInfo(cache) {
    console.clear();
    const stats = cache.getStats();

    console.log(chalk.cyan('💾 Cache Information\n'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(`Size: ${chalk.green(stats.size)} / ${stats.maxSize}`);
    console.log(`Utilization: ${chalk.cyan(stats.utilization)}`);
    console.log(chalk.gray('═'.repeat(60)));

    resetStdin();
    await inquirer.prompt([{ type: 'input', name: 'continue', message: '\nPress Enter to continue...' }]);
}
