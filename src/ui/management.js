import chalk from 'chalk';
import inquirer from 'inquirer';
import { resetStdin, sleep } from '../utils/utils.js';
import { saveConfig } from '../utils/setup.js';
import { showLiveJobMonitor } from './views.js';

// ============ CONFIGURATION MENU ============
export async function showConfigMenu(config) {
    console.clear();
    resetStdin();
    const { type } = await inquirer.prompt([{
        type: 'list',
        name: 'type',
        message: 'Configure:\n' + chalk.gray('-'.repeat(25)),
        choices: ['🗄️ Database', '⏱️ Delays', '📥 Downloads', '⬅️ Back'],
        pageSize: 10
    }]);

    if (type === '🗄️ Database') {
        resetStdin();
        const { file } = await inquirer.prompt([{
            type: 'input',
            name: 'file',
            message: 'Database file:',
            default: config.databaseFile,
            validate: f => f.endsWith('.db') ? true : 'Must end with .db'
        }]);
        config.databaseFile = file;
        await saveConfig(config);
        console.log(chalk.yellow('⚠️ Restart required for DB change'));

    } else if (type === '⏱️ Delays') {
        resetStdin();
        const answers = await inquirer.prompt([
            { type: 'number', name: 'globalDelay', message: 'Global delay (ms):', default: config.globalDelay },
            { type: 'number', name: 'maxFastRequests', message: 'Max fast requests:', default: config.maxFastRequests },
            { type: 'number', name: 'randomDelayMin', message: 'Random delay min (ms):', default: config.randomDelayMin },
            { type: 'number', name: 'randomDelayMax', message: 'Random delay max (ms):', default: config.randomDelayMax },
            { type: 'number', name: 'retryAttempts', message: 'Retry attempts:', default: config.retryAttempts },
            { type: 'number', name: 'retryBaseDelayMs', message: 'Retry base delay (ms):', default: config.retryBaseDelayMs }
        ]);
        Object.assign(config, answers);
        await saveConfig(config);

    } else if (type === '📥 Downloads') {
        resetStdin();
        const answers = await inquirer.prompt([
            { type: 'confirm', name: 'downloadAttachments', message: 'Download attachments & embed media?', default: config.downloadAttachments },
            { type: 'number', name: 'downloadTimeoutSeconds', message: 'Download timeout (seconds):', default: config.downloadTimeoutSeconds }
        ]);
        config.downloadAttachments = answers.downloadAttachments;
        config.downloadTimeoutSeconds = answers.downloadTimeoutSeconds;
        await saveConfig(config);
    }
}

// ============ CHANNEL MANAGEMENT ============
export async function showFetchOptions(channel, listeningChannels, jobManager, syncEngine, client, withRetry, isShuttingDown, isPaused) {
    const isListening = listeningChannels.has(channel.id);
    const existingJob = [...jobManager.activeJobs.values()].find(j => j.channelId === channel.id && j.status === 'running');

    const choices = [
        ...(existingJob
            ? [{ name: `📋 View Active Job #${existingJob.id} (${existingJob.totalMessages} msgs)`, value: 'VIEW_JOB' }]
            : []),
        { name: isListening ? '🔇 Stop Listening' : '🎧 Start Listening', value: 'LISTEN' },
        { name: '📥 Fetch All (Oldest → Newest)', value: 'FULL_FORWARD' },
        { name: '📤 Fetch All (Newest → Oldest)', value: 'FULL_BACKWARD' },
        { name: '📅 Fetch Custom Date Range', value: 'CUSTOM_DATES' },
        { name: '⏩ Resume from Last Message', value: 'RESUME' },
        { name: '⬅️ Back', value: 'BACK' }
    ];

    resetStdin();
    const { fetchMode } = await inquirer.prompt([{
        type: 'list',
        name: 'fetchMode',
        message: `Channel: #${channel.name} ${isListening ? '(🔊 Listening)' : '(🔇 Not Listening)'}`,
        choices,
        pageSize: 10
    }]);

    switch (fetchMode) {
        case 'VIEW_JOB':
            console.log(chalk[existingJob.color](`📋 Job #${existingJob.id} — ${channel.name} (${existingJob.direction})`));
            console.log(chalk.gray(`Status: ${existingJob.status} | Messages: ${existingJob.totalMessages}`));
            if (existingJob.logs.length) {
                console.log('Recent logs:');
                existingJob.logs.slice(-5).forEach(l =>
                    console.log(chalk[existingJob.color](`[${new Date(l.timestamp).toLocaleTimeString()}] ${l.message}`))
                );
            }
            resetStdin();
            await inquirer.prompt([{ type: 'input', name: 'press', message: 'Press Enter to continue...' }]);
            break;

        case 'LISTEN':
            if (isListening) {
                listeningChannels.delete(channel.id);
                console.log(chalk.yellow(`🛑 Stopped listening to #${channel.name}`));
            } else {
                listeningChannels.add(channel.id);
                console.log(chalk.green(`✅ Now listening to #${channel.name}`));
                await showLiveJobMonitor(jobManager);
            }
            break;

        case 'FULL_FORWARD':
        case 'FULL_BACKWARD':
        case 'CUSTOM_DATES':
        case 'RESUME': {
            if (jobManager.channelHasActiveJob(channel.id)) {
                console.log(chalk.yellow(`⚠️ Channel #${channel.name} already has an active job`));
                await sleep(2000);
                break;
            }

            let job;
            if (fetchMode === 'CUSTOM_DATES') {
                resetStdin();
                const { startDate, endDate } = await inquirer.prompt([
                    { type: 'input', name: 'startDate', message: 'Start date (YYYY-MM-DD HH:mm:ss or "start"):', default: 'start' },
                    { type: 'input', name: 'endDate', message: 'End date   (YYYY-MM-DD HH:mm:ss or "now"):', default: 'now' }
                ]);
                job = jobManager.createJob(channel, 'custom', startDate, endDate);
                syncEngine.syncChannelMessages(channel, 'custom', startDate, endDate, job.id, withRetry, isShuttingDown, isPaused);
            } else if (fetchMode === 'RESUME') {
                job = jobManager.createJob(channel, 'resume', null, null);
                syncEngine.syncChannelMessages(channel, 'resume', null, null, job.id, withRetry, isShuttingDown, isPaused);
            } else {
                const direction = fetchMode === 'FULL_FORWARD' ? 'forward' : 'backward';
                job = jobManager.createJob(channel, direction, null, null);
                syncEngine.syncChannelMessages(channel, direction, null, null, job.id, withRetry, isShuttingDown, isPaused);
            }

            console.log(chalk.cyan(`🚀 Started job #${job.id}: Fetching #${channel.name}`));
            await showLiveJobMonitor(jobManager);
            break;
        }
    }
}

export async function manageChannels(client, listeningChannels, jobManager, syncEngine, withRetry, isShuttingDown, isPaused) {
    console.clear();
    const guilds = [...new Set(
        [...client.channels.cache.values()]
            .filter(c => c.type === 'GUILD_TEXT' && c.viewable)
            .map(c => c.guild)
    )].sort((a, b) => a.name.localeCompare(b.name));

    resetStdin();
    const { guildId } = await inquirer.prompt([{
        type: 'list',
        name: 'guildId',
        message: 'Select guild:\n' + chalk.gray('-'.repeat(25)),
        pageSize: 20,
        choices: guilds.map(g => ({
            name: `${g.name} (${g.channels.cache.filter(c => c.type === 'GUILD_TEXT' && c.viewable).size})`,
            value: g.id
        })).concat({ name: '⬅️ Back', value: 'BACK' })
    }]);

    if (guildId === 'BACK') return;

    const guildChannels = [...client.guilds.cache.get(guildId).channels.cache.values()]
        .filter(c => c.type === 'GUILD_TEXT' && c.viewable)
        .sort((a, b) => a.name.localeCompare(b.name));

    resetStdin();
    const { channelId } = await inquirer.prompt([{
        type: 'list',
        name: 'channelId',
        message: 'Select channel:\n' + chalk.gray('-'.repeat(25)),
        pageSize: 20,
        choices: guildChannels.map(c => ({
            name: `${listeningChannels.has(c.id) ? '🔊' : '🔇'} #${c.name}`,
            value: c.id
        })).concat({ name: '⬅️ Back', value: 'BACK' })
    }]);

    if (channelId !== 'BACK')
        await showFetchOptions(client.channels.cache.get(channelId), listeningChannels, jobManager, syncEngine, client, withRetry, isShuttingDown, isPaused);
}

export async function viewChannels(client, listeningChannels, jobManager) {
    console.clear();
    if (listeningChannels.size) {
        console.log(chalk.cyan(`📺 Listening to ${listeningChannels.size} channel(s):`));
        listeningChannels.forEach(id => {
            const ch = client.channels.cache.get(id);
            if (ch) console.log(chalk.green(`• 🔊 #${ch.name}`));
        });
    } else {
        console.log(chalk.yellow('📺 No channels currently listening'));
    }

    const activeRunning = jobManager.getAllJobs().filter(j => j.status === 'running');
    const jobChannelIds = new Set(activeRunning.map(j => j.channelId));
    if (jobChannelIds.size) {
        console.log(chalk.cyan(`\n⚡ ${jobChannelIds.size} channel(s) with active jobs:`));
        jobChannelIds.forEach(cid => {
            const ch = client.channels.cache.get(cid);
            const jobs = activeRunning.filter(j => j.channelId === cid).map(j => `#${j.id}`).join(', ');
            if (ch) console.log(chalk.blue(`• 📋 #${ch.name} (${jobs})`));
        });
    }

    await showLiveJobMonitor(jobManager);
}
