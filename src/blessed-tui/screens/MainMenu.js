import blessed from 'blessed';

/**
 * Enhanced Main Menu Screen
 */
export class MainMenu {
    constructor(screen, ctx, onAction) {
        this.screen = screen;
        this.ctx = ctx;
        this.onAction = onAction;
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
            content: ' DISCORD MESSAGE LOGGER'
        });

        // Status box — plain text, no tags needed
        this.widgets.status = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%', height: 4,
            border: { type: 'line' },
            style: {
                border: { fg: 'cyan' },
                fg: 'cyan'
            }
        });

        // Menu list — items can have tags for categories
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 5, left: 0, width: '100%',
            height: this.screen.height - 7,
            border: { type: 'line' },
            tags: true,
            label: ' Menu ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items: this.buildMenuItems()
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' UP/DOWN Navigate  ENTER Select  ? Help  Q/CTRL+C Exit'
        });

        this.widgets.menu.focus();

        this.widgets.menu.on('select', (item, index) => {
            const text = item.getText().trim();
            const actions = {
                'Live Monitor': 'live-monitor',
                'View Channels': 'view-channels',
                'Manage Channels': 'manage-channels',
                'Sync All Channels': 'sync-all',
                'Resume Listening': 'toggle-pause',
                'Pause Listening': 'toggle-pause',
                'Disable Autosync': 'toggle-autosync',
                'Enable Autosync': 'toggle-autosync',
                'Search Messages': 'search',
                'View Statistics': 'stats',
                'Export Data': 'export',
                'Database Manager': 'database',
                'Configuration': 'config',
                'Health Check': 'health-check',
                'System Information': 'system-info',
                'Exit': 'exit'
            };
            const action = actions[text];
            if (action) this.onAction(action);
        });
    }

    buildMenuItems() {
        const items = [
            '{bold}--- SYNC & MONITOR ---{/bold}',
            '  Live Monitor',
            '  View Channels',
            '  Manage Channels',
            '  Sync All Channels',
            this.ctx.isPaused ? '  Resume Listening' : '  Pause Listening',
            this.ctx.autoSyncEnabled ? '  Disable Autosync' : '  Enable Autosync',
            '',
            '{bold}--- DATA & SEARCH ---{/bold}',
            '  Search Messages',
            '  View Statistics',
            '  Export Data',
            '',
            '{bold}--- SYSTEM & CONFIG ---{/bold}',
            '  Database Manager',
            '  Configuration',
            '  Health Check',
            '  System Information',
            '',
            '  Exit'
        ];
        return items;
    }

    updateStatus() {
        const allJobs = this.ctx.jobManager.getAllJobs();
        const running = allJobs.filter(j => j.status === 'running');
        const completed = allJobs.filter(j => j.status === 'completed');
        const failed = allJobs.filter(j => j.status === 'error');

        const statusLabel = this.ctx.isPaused
            ? 'PAUSED'
            : running.length
                ? `WORKING (${running.length} jobs)`
                : 'ACTIVE';

        const text =
            ` Status: ${statusLabel}\n` +
            ` Autosync: ${this.ctx.autoSyncEnabled ? 'ON' : 'OFF'}\n` +
            ` Channels: ${this.ctx.listeningChannels.size} listening\n` +
            ` Jobs: ${running.length} running  ${completed.length} completed  ${failed.length} failed`;

        this.widgets.status.setContent(text);
    }

    setupKeyBindings() {
        this.widgets.menu.key(['q'], () => this.onAction('exit'));
    }

    startUpdates() {
        this.updateStatus();
        this.updateInterval = setInterval(() => {
            this.updateStatus();
            this.widgets.menu.setItems(this.buildMenuItems());
            this.screen.render();
        }, 500);
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default MainMenu;
