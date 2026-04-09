import chalk from 'chalk';
import inquirer from 'inquirer';
import moment from 'moment';
import { resetStdin, sleep, formatDuration } from '../utils/utils.js';

// ============ CHANNEL STATISTICS ============
export async function viewChannelStats(db, client, listeningChannels) {
    if (!db) return;

    console.clear();
    console.log(chalk.cyan('📊 Channel Statistics'));

    if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }

    const rows = db.prepare('SELECT DISTINCT channel_id FROM messages ORDER BY channel_id').all();
    if (!rows.length) {
        console.log(chalk.yellow('No channel data found in database'));
        resetStdin();
        await inquirer.prompt([{ type: 'input', name: 'press', message: 'Press Enter to continue...' }]);
        return;
    }

    for (const { channel_id: id } of rows) {
        const ch = client.channels.cache.get(id);
        const guild = ch?.guild?.name ? `[${ch.guild.name}]` : '';
        const name = ch ? `#${ch.name} ${guild}` : `Unknown Channel (${id})`;
        const icon = listeningChannels.has(id) ? '🔊' : '🔇';

        const stats = db.prepare(`
            SELECT
                COUNT(*)                                                        AS total,
                COUNT(CASE WHEN is_bot  = 1            THEN 1 END)             AS bots,
                COUNT(CASE WHEN deleted = 1            THEN 1 END)             AS deleted,
                COUNT(CASE WHEN edited_at IS NOT NULL  THEN 1 END)             AS edited,
                COUNT(CASE WHEN reference_message_id IS NOT NULL THEN 1 END)   AS replies,
                COUNT(CASE WHEN json_array_length(reactions)   > 0 THEN 1 END) AS reactions,
                COUNT(CASE WHEN json_array_length(attachments) > 0 THEN 1 END) AS attachments
            FROM messages WHERE channel_id = ?
        `).get(id);

        const last = db.prepare(
            'SELECT timestamp FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 1'
        ).get(id);

        console.log(chalk.green(`\n${icon} ${name}`));
        console.log(chalk.gray(
            `Total: ${stats.total} | Bots: ${stats.bots} | Replies: ${stats.replies} | ` +
            `Reactions: ${stats.reactions} | Attachments: ${stats.attachments} | ` +
            `Edited: ${stats.edited} | Deleted: ${stats.deleted}`
        ));
        console.log(chalk.gray(`Last: ${moment(last?.timestamp).fromNow()}`));
    }

    console.log(chalk.cyan(`\n📈 Total synced channels: ${rows.length}`));

    resetStdin();
    await inquirer.prompt([{ type: 'input', name: 'press', message: '\nPress Enter to continue...' }]);
}

// ============ LIVE JOB MONITOR ============
export async function showLiveJobMonitor(jobManager) {
    let exit = false;

    const render = () => {
        console.clear();
        console.log(chalk.cyan('📋 Live Job Monitor'));
        console.log(chalk.gray('═'.repeat(58)));
        console.log(chalk.yellow('Press Enter / q / Ctrl+C to return'));

        if (!jobManager.activeJobs.size) {
            console.log(chalk.yellow('No active jobs'));
            return false;
        }

        const allJobs = jobManager.getAllJobs();
        const running = allJobs.filter(j => j.status === 'running');
        const completed = allJobs.filter(j => j.status === 'completed');
        const failed = allJobs.filter(j => j.status === 'error');

        console.log(
            chalk.green(`🟢 Running: ${running.length}`) + ' ' +
            chalk.yellow(`🟡 Completed: ${completed.length}`) + ' ' +
            chalk.red(`🔴 Failed: ${failed.length}`)
        );

        if (running.length) {
            console.log(chalk.cyan('⚡ RUNNING:'));
            running.forEach(j => console.log(chalk[j.color](
                `  #${j.id}: ${j.channel} (${j.direction}) — ${j.totalMessages} msgs — ${formatDuration(Date.now() - j.startTime)}`
            )));
        }
        if (completed.length) {
            console.log(chalk.green('✅ COMPLETED:'));
            completed.slice(0, 5).forEach(j => console.log(chalk[j.color](
                `  #${j.id}: ${j.channel} — ${j.totalMessages} msgs — ${formatDuration(j.duration)}`
            )));
        }
        if (failed.length) {
            console.log(chalk.red('❌ FAILED:'));
            failed.slice(0, 3).forEach(j => console.log(chalk.red(`  #${j.id}: ${j.channel} — Failed`)));
        }

        console.log(chalk.gray('═'.repeat(58)));
        console.log(chalk.yellow('Updated: ' + new Date().toLocaleTimeString()));
        return true;
    };

    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
    }

    const onKey = key => {
        if (['\u0003', 'q', '\r', '\n'].includes(key)) exit = true;
    };
    process.stdin.on('data', onKey);

    try {
        while (!exit) {
            const hasJobs = render();
            const wait = hasJobs ? 1000 : 5000;
            const start = Date.now();
            while (Date.now() - start < wait && !exit) await sleep(100);
        }
    } finally {
        process.stdin.removeListener('data', onKey);
        if (process.stdin.isTTY && process.stdin.isRaw) {
            try {
                process.stdin.setRawMode(false);
            } catch { }
        }
        process.stdin.pause();
    }
}
