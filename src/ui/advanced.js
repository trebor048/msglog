import chalk from 'chalk';
import inquirer from 'inquirer';
import { resetStdin, sleep, Validator } from '../utils/utils.js';

export async function showSearchMenu(search, client) {
    console.clear();
    resetStdin();

    const { searchType } = await inquirer.prompt([{
        type: 'list',
        name: 'searchType',
        message: 'Search Options:',
        choices: [
            '🔍 Search by Keyword',
            '👤 Search by Author',
            '📅 Search by Date Range',
            '📎 Messages with Attachments',
            '👍 Messages with Reactions',
            '✏️ Edited Messages',
            '💬 Text Only Messages',
            '📷 Media Only Messages',
            '📊 View Statistics',
            '⬅️ Back'
        ]
    }]);

    switch (searchType) {
        case '⬅️ Back':
            return;

        case '🔍 Search by Keyword': {
            resetStdin();
            const { keyword } = await inquirer.prompt([{
                type: 'input',
                name: 'keyword',
                message: 'Enter keyword to search:'
            }]);

            const results = search.search({ query: keyword, limit: 50 });
            displaySearchResults(results);
            break;
        }

        case '👤 Search by Author': {
            resetStdin();
            const { author } = await inquirer.prompt([{
                type: 'input',
                name: 'author',
                message: 'Enter author name or ID:'
            }]);

            const results = search.search({ authorId: author, limit: 50 });
            displaySearchResults(results);
            break;
        }

        case '📅 Search by Date Range': {
            resetStdin();
            const { startDate, endDate } = await inquirer.prompt([
                { type: 'input', name: 'startDate', message: 'Start date (YYYY-MM-DD):' },
                { type: 'input', name: 'endDate', message: 'End date (YYYY-MM-DD):' }
            ]);

            // Validate date range
            const validation = Validator.validateSearchFilters({ startDate, endDate });
            if (!validation.valid) {
                console.log(chalk.red(`❌ ${validation.errors.join(', ')}`));
                await sleep(2000);
                break;
            }

            const results = search.search({ startDate, endDate, limit: 50 });
            displaySearchResults(results);
            break;
        }

        case '📎 Messages with Attachments': {
            const results = search.search({ hasAttachments: true, limit: 50 });
            console.log(chalk.cyan(`\n📎 Found ${results.length} messages with attachments\n`));
            displaySearchResults(results);
            break;
        }

        case '👍 Messages with Reactions': {
            const results = search.search({ hasReactions: true, limit: 50 });
            console.log(chalk.cyan(`\n👍 Found ${results.length} messages with reactions\n`));
            displaySearchResults(results);
            break;
        }

        case '✏️ Edited Messages': {
            const results = search.search({ isEdited: true, limit: 50 });
            console.log(chalk.cyan(`\n✏️ Found ${results.length} edited messages\n`));
            displaySearchResults(results);
            break;
        }

        case '💬 Text Only Messages': {
            const results = search.search({ messageType: 'text', limit: 50 });
            console.log(chalk.cyan(`\n💬 Found ${results.length} text-only messages\n`));
            displaySearchResults(results);
            break;
        }

        case '📷 Media Only Messages': {
            const results = search.search({ messageType: 'media', limit: 50 });
            console.log(chalk.cyan(`\n📷 Found ${results.length} messages with media\n`));
            displaySearchResults(results);
            break;
        }

        case '📊 View Statistics': {
            const stats = search.getStats();
            console.clear();
            console.log(chalk.cyan('📊 Database Statistics\n'));
            console.log(chalk.gray('═'.repeat(50)));
            console.log(`Total Messages: ${chalk.green(stats.total)}`);
            console.log(`Unique Authors: ${chalk.green(stats.unique_authors)}`);
            console.log(`Unique Channels: ${chalk.green(stats.unique_channels)}`);
            console.log(`With Reactions: ${chalk.green(stats.with_reactions)}`);
            console.log(`With Attachments: ${chalk.green(stats.with_attachments)}`);
            console.log(`Edited: ${chalk.green(stats.edited)}`);
            console.log(`Deleted: ${chalk.yellow(stats.deleted)}`);
            console.log(`Bot Messages: ${chalk.blue(stats.bot_messages)}`);
            console.log(chalk.gray('═'.repeat(50)));

            const topAuthors = search.getTopAuthors(5);
            console.log(chalk.cyan('\n👥 Top 5 Authors:\n'));
            topAuthors.forEach((author, i) => {
                console.log(`${i + 1}. ${chalk.green(author.author_tag)} - ${author.message_count} messages`);
            });

            resetStdin();
            await inquirer.prompt([{ type: 'input', name: 'continue', message: '\nPress Enter to continue...' }]);
            break;
        }
    }
}

export async function showExportMenu(exporter) {
    console.clear();
    resetStdin();

    const { exportFormat } = await inquirer.prompt([{
        type: 'list',
        name: 'exportFormat',
        message: 'Export Format:',
        choices: [
            '📄 JSON',
            '📊 CSV',
            '🌐 HTML',
            '💾 Database Backup',
            '⬅️ Back'
        ]
    }]);

    if (exportFormat === '⬅️ Back') return;

    resetStdin();
    const { filename } = await inquirer.prompt([{
        type: 'input',
        name: 'filename',
        message: 'Filename (without extension):',
        default: `export_${new Date().toISOString().split('T')[0]}`
    }]);

    try {
        let filepath;
        switch (exportFormat) {
            case '📄 JSON':
                filepath = await exporter.exportToJSON(`${filename}.json`);
                break;
            case '📊 CSV':
                filepath = await exporter.exportToCSV(`${filename}.csv`);
                break;
            case '🌐 HTML':
                filepath = await exporter.exportToHTML(`${filename}.html`);
                break;
            case '💾 Database Backup':
                filepath = await exporter.backupDatabase(`${filename}.db`);
                break;
        }

        console.log(chalk.green(`\n✅ Export complete: ${filepath}`));
        resetStdin();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    } catch (err) {
        console.error(chalk.red(`\n❌ Export failed: ${err.message}`));
        await sleep(2000);
    }
}

export async function showDatabaseMenu(dbManager) {
    console.clear();
    resetStdin();

    const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'Database Management:',
        choices: [
            '📊 View Statistics',
            '🔧 Optimize Database',
            '✅ Check Integrity',
            '🧹 Cleanup Old Data',
            '🔨 Rebuild Indexes',
            '🧽 Deduplicate Messages',
            '📋 View Table Info',
            '⬅️ Back'
        ]
    }]);

    switch (action) {
        case '⬅️ Back':
            return;

        case '📊 View Statistics': {
            const stats = dbManager.getStats();
            console.clear();
            console.log(chalk.cyan('📊 Database Statistics\n'));
            console.log(chalk.gray('═'.repeat(50)));
            console.log(`Total Messages: ${chalk.green(stats.totalMessages)}`);
            console.log(`Total Channels: ${chalk.green(stats.totalChannels)}`);
            console.log(`Total Authors: ${chalk.green(stats.totalAuthors)}`);
            console.log(`Deleted Messages: ${chalk.yellow(stats.deletedMessages)}`);
            console.log(`Edited Messages: ${chalk.blue(stats.editedMessages)}`);
            console.log(`Bot Messages: ${chalk.blue(stats.botMessages)}`);
            console.log(`Total Attachments: ${chalk.green(stats.totalAttachments)}`);
            console.log(`Total Reactions: ${chalk.green(stats.totalReactions)}`);
            console.log(`Avg Message Length: ${stats.averageMessageLength} chars`);
            console.log(`Database Size: ${chalk.cyan(stats.databaseSize.toFixed(2))} MB`);
            console.log(chalk.gray('═'.repeat(50)));

            const channelStats = dbManager.getChannelStats();
            console.log(chalk.cyan('\n📈 Top Channels by Message Count:\n'));
            channelStats.slice(0, 5).forEach((ch, i) => {
                console.log(`${i + 1}. Channel ${ch.channel_id}: ${chalk.green(ch.message_count)} messages`);
            });

            resetStdin();
            await inquirer.prompt([{ type: 'input', name: 'continue', message: '\nPress Enter to continue...' }]);
            break;
        }

        case '🔧 Optimize Database': {
            dbManager.optimize();
            await sleep(1000);
            break;
        }

        case '✅ Check Integrity': {
            const result = dbManager.checkIntegrity();
            await sleep(1000);
            break;
        }

        case '🧹 Cleanup Old Data': {
            resetStdin();
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: 'Remove deleted messages older than 30 days?',
                default: false
            }]);

            if (confirm) {
                const removed = dbManager.cleanup();
                console.log(chalk.green(`✅ Removed ${removed} old messages`));
                await sleep(1500);
            }
            break;
        }

        case '🔨 Rebuild Indexes': {
            dbManager.rebuildIndexes();
            await sleep(1000);
            break;
        }

        case '🧽 Deduplicate Messages': {
            resetStdin();
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: 'Remove duplicate messages? This keeps the first occurrence of each message ID.',
                default: false
            }]);

            if (confirm) {
                const removed = dbManager.deduplicateMessages();
                console.log(chalk.green(`✅ Removed ${removed} duplicate messages`));
                await sleep(1500);
            }
            break;
        }

        case '📋 View Table Info': {
            const tableInfo = dbManager.getTableInfo();
            console.clear();
            console.log(chalk.cyan('📋 Database Tables\n'));
            for (const [tableName, info] of Object.entries(tableInfo)) {
                console.log(chalk.green(`${tableName}: ${info.rowCount} rows`));
                info.columns.forEach(col => {
                    console.log(`  - ${col.name} (${col.type})`);
                });
                console.log();
            }

            resetStdin();
            await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
            break;
        }
    }
}

function displaySearchResults(results) {
    if (!results.length) {
        console.log(chalk.yellow('\n❌ No results found\n'));
        return;
    }

    console.log(chalk.cyan(`\n📋 Found ${results.length} messages\n`));
    console.log(chalk.gray('═'.repeat(70)));

    results.slice(0, 10).forEach(msg => {
        console.log(`${chalk.green(msg.author_tag)} - ${new Date(msg.timestamp).toLocaleString()}`);
        console.log(`${msg.content.substring(0, 60)}${msg.content.length > 60 ? '...' : ''}`);
        console.log(chalk.gray('─'.repeat(70)));
    });

    if (results.length > 10) {
        console.log(chalk.yellow(`\n... and ${results.length - 10} more results`));
    }
}
