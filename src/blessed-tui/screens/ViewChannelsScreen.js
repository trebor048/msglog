import blessed from 'blessed';

/**
 * View Channels Screen
 * Displays listening status and active jobs for all channels
 */
export class ViewChannelsScreen {
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
            content: ' ACTIVE CHANNELS'
        });

        // Content box — uses color tags in setContent, needs tags:true
        this.widgets.content = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Monitoring Status ',
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
            content: ' ENTER/Q Back  ? Help'
        });

        this.updateDisplay();
        this.widgets.content.focus();
    }

    updateDisplay() {
        let c = '\n';

        if (this.ctx.listeningChannels?.size) {
            c += `{cyan-fg}Monitoring ${this.ctx.listeningChannels.size} channel(s):{/cyan-fg}\n`;
            c += '{gray-fg}' + '─'.repeat(50) + '{/gray-fg}\n';
            this.ctx.listeningChannels.forEach(id => {
                const ch = this.ctx.client.channels.cache.get(id);
                if (ch) {
                    const guild = ch.guild?.name ? ` {gray-fg}[${ch.guild.name}]{/gray-fg}` : '';
                    c += `  {green-fg}• #${ch.name}{/green-fg}${guild}\n`;
                } else {
                    c += `  {gray-fg}• Unknown channel (${id}){/gray-fg}\n`;
                }
            });
        } else {
            c += '{yellow-fg}No channels currently listening{/yellow-fg}\n';
        }

        const activeRunning = this.ctx.jobManager.getAllJobs().filter(j => j.status === 'running');
        const jobChannelIds = new Set(activeRunning.map(j => j.channelId));

        if (jobChannelIds.size) {
            c += `\n\n{blue-fg}${jobChannelIds.size} Active Sync Job(s):{/blue-fg}\n`;
            c += '{gray-fg}' + '─'.repeat(50) + '{/gray-fg}\n';
            jobChannelIds.forEach(cid => {
                const ch = this.ctx.client.channels.cache.get(cid);
                const jobs = activeRunning.filter(j => j.channelId === cid).map(j => `#${j.id}`).join(', ');
                if (ch) {
                    c += `  {blue-fg}• #${ch.name}{/blue-fg} {gray-fg}(Jobs: ${jobs}){/gray-fg}\n`;
                }
            });
        } else {
            c += '\n\n{gray-fg}No sync jobs currently running{/gray-fg}\n';
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

export default ViewChannelsScreen;
