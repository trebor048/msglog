import chalk from 'chalk';
import inquirer from 'inquirer';
import { resetStdin, sleep, formatDuration } from '../utils/utils.js';
import { showLiveJobMonitor } from './views.js';
import { viewChannelStats } from './views.js';
import { showConfigMenu, manageChannels, viewChannels } from './management.js';
import { showSearchMenu, showExportMenu, showDatabaseMenu } from './advanced.js';
import { showSystemInfo, showCacheInfo } from './system.js';
import { startAutoSync, stopAutoSync } from '../utils/index.js';

export async function mainMenu(ctx) {
    try {
        while (!ctx.isShuttingDown) {
            console.clear();

            const allJobs = ctx.jobManager.getAllJobs();
            const running = allJobs.filter(j => j.status === 'running');
            const completed = allJobs.filter(j => j.status === 'completed');
            const failed = allJobs.filter(j => j.status === 'error');

            const status = ctx.isPaused ? chalk.yellow('PAUSED')
                : running.length ? chalk.blue('WORKING') + ` (${running.length} jobs)`
                    : chalk.green('ACTIVE');

            console.log(`🤖 Discord Logger | ${status}`);

            if (ctx.jobManager.activeJobs.size)
                console.log(
                    chalk.green(`🟢 Running: ${running.length}`) + ' ' +
                    chalk.yellow(`🟡 Completed: ${completed.length}`) + ' ' +
                    chalk.red(`🔴 Failed: ${failed.length}`)
                );

            if (ctx.autoSyncEnabled) {
                console.log(chalk.cyan(`🔄 Autosync: ${ctx.autoSyncEnabled ? 'ON' : 'OFF'}`));
            }

            console.log(chalk.gray('═'.repeat(58)));
            console.log(chalk.cyan('💡 Arrow Keys: Navigate // Enter: Select // Ctrl+C: Exit'));
            console.log(chalk.gray('═'.repeat(58)));

            resetStdin();
            const { action } = await inquirer.prompt([{
                type: 'list',
                name: 'action',
                message: 'Select action:\n' + chalk.gray('-'.repeat(25)),
                pageSize: 20,
                choices: [
                    '👁️ View Channels',
                    '📡 Manage Channels',
                    ctx.isPaused ? '▶️ Resume' : '⏸️ Pause',
                    '🚀 Sync All',
                    ctx.autoSyncEnabled ? '⏹️ Disable Autosync' : '🔄 Enable Autosync',
                    '📊 Stats',
                    '📋 Live Monitor',
                    '🔍 Search Messages',
                    '📤 Export Data',
                    '🗄️ Database Manager',
                    '💻 System Info',
                    '⚙️ Config',
                    '🏥 Health Check',
                    '❌ Exit'
                ]
            }]);

            switch (action) {
                case '👁️ View Channels':
                    await viewChannels(ctx.client, ctx.listeningChannels, ctx.jobManager);
                    break;

                case '📡 Manage Channels':
                    await manageChannels(ctx.client, ctx.listeningChannels, ctx.jobManager, ctx.syncEngine, ctx.withRetry, ctx.isShuttingDown, ctx.isPaused);
                    break;

                case '⏸️ Pause':
                case '▶️ Resume':
                    ctx.isPaused = !ctx.isPaused;
                    if (ctx.isPaused) {
                        console.log(chalk.yellow('⏸️ Paused — all jobs suspended'));
                    } else {
                        console.log(chalk.green('▶️ Resumed'));
                        if (ctx.listeningChannels.size) {
                            console.log(chalk.blue('🔄 Syncing all listening channels...'));
                            await ctx.syncEngine.syncAllChannelsParallel(ctx.client, ctx.listeningChannels, ctx.withRetry, ctx.isShuttingDown);
                            await showLiveJobMonitor(ctx.jobManager);
                        } else {
                            console.log(chalk.yellow('ℹ️ No channels listening — use Manage Channels first'));
                            await sleep(1500);
                        }
                    }
                    break;

                case '🔄 Enable Autosync':
                case '⏹️ Disable Autosync':
                    if (ctx.autoSyncEnabled) {
                        stopAutoSync(ctx);
                        await sleep(1000);
                    } else {
                        if (!ctx.listeningChannels.size) {
                            console.log(chalk.yellow('⚠️ No channels listening — add channels first'));
                            await sleep(2000);
                        } else {
                            startAutoSync(ctx);
                            await sleep(1000);
                        }
                    }
                    break;

                case '🚀 Sync All':
                    if (!ctx.listeningChannels.size) {
                        console.log(chalk.yellow('⚠️ No channels listening'));
                        await sleep(2000);
                        break;
                    }
                    const runningCount = running.length;
                    if (runningCount) {
                        resetStdin();
                        const { confirm } = await inquirer.prompt([{
                            type: 'confirm',
                            name: 'confirm',
                            message: `${runningCount} job(s) running. Start sync for all channels anyway?`,
                            default: false
                        }]);
                        if (!confirm) break;
                    }
                    await ctx.syncEngine.syncAllChannelsParallel(ctx.client, ctx.listeningChannels, ctx.withRetry, ctx.isShuttingDown);
                    await showLiveJobMonitor(ctx.jobManager);
                    break;

                case '📊 Stats':
                    await viewChannelStats(ctx.db, ctx.client, ctx.listeningChannels);
                    break;

                case '📋 Live Monitor':
                    await showLiveJobMonitor(ctx.jobManager);
                    break;

                case '🔍 Search Messages':
                    await showSearchMenu(ctx.search, ctx.client);
                    break;

                case '📤 Export Data':
                    await showExportMenu(ctx.exporter);
                    break;

                case '🗄️ Database Manager':
                    await showDatabaseMenu(ctx.dbManager);
                    break;

                case '💻 System Info':
                    await showSystemInfo(ctx.performance, ctx.performance);
                    break;

                case '⚙️ Config':
                    await showConfigMenu(ctx.config);
                    break;

                case '🏥 Health Check':
                    console.clear();
                    console.log(chalk.cyan('🏥 System Health Check'));
                    console.log(chalk.gray('═'.repeat(58)));
                    const healthStatus = ctx.performance.getHealthStatus(ctx.jobManager, ctx.circuitBreaker, ctx.listeningChannels);
                    console.log(chalk.blue('📊 Health Check:'));
                    console.log(`Uptime: ${formatDuration(healthStatus.uptime)}`);
                    console.log(`Messages processed: ${healthStatus.totalMessages}`);
                    console.log(`Jobs completed: ${healthStatus.totalJobs}`);
                    console.log(`Active jobs: ${healthStatus.activeJobs}`);
                    console.log(`Circuit Breaker: ${healthStatus.circuitBreaker.state}`);
                    console.log(`Memory: ${Math.round(healthStatus.memoryUsage.heapUsed / 1024 / 1024)}MB used`);
                    console.log(`Active channels: ${healthStatus.activeChannels}`);
                    console.log(chalk.gray('═'.repeat(58)));
                    resetStdin();
                    await inquirer.prompt([{
                        type: 'input',
                        name: 'continue',
                        message: 'Press Enter to continue...'
                    }]);
                    break;

                case '❌ Exit':
                    await ctx.gracefulShutdown('user exit');
                    return;
            }
        }
    } catch (err) {
        if (ctx.isShuttingDown) return;
        console.error(chalk.red('❌ Menu error:', err.message));
        await ctx.gracefulShutdown('error');
    }
}
