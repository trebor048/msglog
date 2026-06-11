import blessed from 'blessed';
import { formatDuration, Validator } from '../../utils/utils.js';

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
        this.updateInterval = null;

        this.create();
        this.setupKeyBindings();
        this.startUpdates();
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
            content: ' ESC/Q/ENTER Back'
        });

        this.widgets.content.focus();
    }

    updateDisplay() {
        const stats = this.ctx.performance.getStats();
        const runtime = this.ctx.runtimeMetrics || {};

        let c = '\n{cyan-fg}{bold}Session Statistics{/bold}{/cyan-fg}\n';
        c += '{gray-fg}' + '─'.repeat(50) + '{/gray-fg}\n\n';

        c += `  Messages Fetched:  {green-fg}${stats.totalMessagesFetched.toLocaleString()}{/green-fg}\n`;
        c += `  Messages Stored:   {green-fg}${stats.totalMessagesStored.toLocaleString()}{/green-fg}\n`;
        c += `  Files Downloaded:  {green-fg}${stats.totalAttachmentsDownloaded.toLocaleString()}{/green-fg}\n`;
        c += `  Sync Operations:   {green-fg}${stats.totalSyncs.toLocaleString()}{/green-fg}\n`;
        c += `  Search Queries:    {green-fg}${stats.totalSearches.toLocaleString()}{/green-fg}\n`;
        c += `  Runtime Errors:    {red-fg}${stats.totalErrors.toLocaleString()}{/red-fg}\n`;
        c += `  Queue Processed:   {green-fg}${(runtime.queuedMessagesProcessed ?? 0).toLocaleString()}{/green-fg}\n`;
        c += `  Queue Dropped:     {red-fg}${(runtime.queuedMessagesDropped ?? 0).toLocaleString()}{/red-fg}\n`;

        c += `\n{cyan-fg}{bold}System Uptime{/bold}{/cyan-fg}\n`;
        c += `  {white-fg}${formatDuration(stats.uptime)}{/white-fg}\n`;

        if (stats.lastSync) {
            c += `\n{cyan-fg}{bold}Latest Sync{/bold}{/cyan-fg}\n`;
            c += `  Channel ID: {gray-fg}${stats.lastSync.channelId}{/gray-fg}\n`;
            c += `  Messages:   {green-fg}${stats.lastSync.messageCount}{/green-fg}\n`;
            c += `  Time:       {gray-fg}${stats.lastSync.timestamp}{/gray-fg}\n`;
        }

        if (stats.lastError) {
            const safeMsg = Validator.sanitizeErrorMessage(stats.lastError);
            c += `\n{red-fg}{bold}Last Error{/bold}{/red-fg}\n`;
            c += `  {red-fg}${safeMsg}{/red-fg}\n`;
            c += `  {gray-fg}${stats.lastError.timestamp}{/gray-fg}\n`;
        }

        this.widgets.content.setContent(c);
        this.screen.render();
    }

    setupKeyBindings() {
        this.widgets.content.key(['escape', 'q', 'enter'], () => this.onBack());
    }

    startUpdates() {
        this.updateDisplay();
        this.updateInterval = setInterval(() => this.updateDisplay(), 1000);
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default SystemInfoScreen;
