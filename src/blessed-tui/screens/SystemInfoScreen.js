import blessed from 'blessed';
import { formatDuration } from '../../utils/utils.js';

/**
 * System Info Screen
 * Performance stats and system details
 */
export class SystemInfoScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};

        this.create();
        this.setupKeyBindings();
    }

    create() {
        // Main container
        this.widgets.main = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: '100%',
            style: { bg: 'black', fg: 'white' }
        });

        // Header — plain text, no tags needed
        this.widgets.header = blessed.box({
            parent: this.widgets.main,
            top: 0, left: 0, width: '100%', height: 1,
            style: { bg: 'blue', fg: 'white', bold: true },
            content: ' SYSTEM INFORMATION'
        });

        // Content box — uses color tags in setContent, needs tags:true
        this.widgets.content = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Performance & Runtime ',
            style: { border: { fg: 'cyan' } },
            scrollable: true,
            mouse: true,
            keys: true
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' ENTER/Q Back'
        });

        this.updateDisplay();
        this.widgets.content.focus();
    }

    updateDisplay() {
        const stats = this.ctx.performance.getStats();

        let c = '\n{cyan-fg}{bold}Session Statistics{/bold}{/cyan-fg}\n';
        c += '{gray-fg}' + '─'.repeat(50) + '{/gray-fg}\n\n';

        c += `  Messages Fetched:  {green-fg}${stats.totalMessagesFetched.toLocaleString()}{/green-fg}\n`;
        c += `  Messages Stored:   {green-fg}${stats.totalMessagesStored.toLocaleString()}{/green-fg}\n`;
        c += `  Files Downloaded:  {green-fg}${stats.totalAttachmentsDownloaded.toLocaleString()}{/green-fg}\n`;
        c += `  Sync Operations:   {green-fg}${stats.totalSyncs.toLocaleString()}{/green-fg}\n`;
        c += `  Search Queries:    {green-fg}${stats.totalSearches.toLocaleString()}{/green-fg}\n`;
        c += `  Runtime Errors:    {red-fg}${stats.totalErrors.toLocaleString()}{/red-fg}\n`;

        c += `\n{cyan-fg}{bold}System Uptime{/bold}{/cyan-fg}\n`;
        c += `  {white-fg}${formatDuration(stats.uptime)}{/white-fg}\n`;

        if (stats.lastSync) {
            c += `\n{cyan-fg}{bold}Latest Sync{/bold}{/cyan-fg}\n`;
            c += `  Channel ID: {gray-fg}${stats.lastSync.channelId}{/gray-fg}\n`;
            c += `  Messages:   {green-fg}${stats.lastSync.messageCount}{/green-fg}\n`;
            c += `  Time:       {gray-fg}${stats.lastSync.timestamp}{/gray-fg}\n`;
        }

        if (stats.lastError) {
            c += `\n{red-fg}{bold}Last Error{/bold}{/red-fg}\n`;
            c += `  {red-fg}${stats.lastError.message}{/red-fg}\n`;
            c += `  {gray-fg}${stats.lastError.timestamp}{/gray-fg}\n`;
        }

        this.widgets.content.setContent(c);
        this.screen.render();
    }

    setupKeyBindings() {
        this.widgets.content.key(['enter', 'q', 'escape'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default SystemInfoScreen;
