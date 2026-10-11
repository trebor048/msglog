import blessed from 'blessed';
import { COLORS, STYLES, border, tag, tagBold, dim } from '../themes/theme.js';
import { formatDuration } from '../../utils/utils.js';

/**
 * Main Menu Screen — entry point of the TUI
 *
 * Menu items are mapped to actions by index (not text matching).
 * Category headers are plain text rendered via style, not Blessed tags.
 */
export class MainMenu {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.updateInterval = null;
        this._resizeHandler = null;

        // Index-to-action mapping for the menu list
        this._actionMap = [];
        this._rebuildActionMap();
        this._lastMenuFingerprint = ''; // Track menu item changes

        this.create();
        this.setupKeyBindings();
        this.startUpdates();

        // Handle terminal resize — recalculate menu height
        this._resizeHandler = () => {
            const newHeight = this.screen.height - 9;
            if (newHeight >= 5) {
                this.widgets.menu.height = newHeight;
                this.screen.render();
            }
        };
        this.screen.on('resize', this._resizeHandler);
    }

    _rebuildActionMap() {
        // Build action map aligned with buildMenuItems()
        // Indices: 0=cat, 1=live-monitor, 2=view-channels, 3=manage-channels, 4=sync-all,
        //          5=toggle-pause, 6=toggle-autosync, 7=blank,
        //          8=cat, 9=search, 10=stats, 11=export, 12=blank,
        //          13=cat, 14=database, 15=config, 16=health-check, 17=system-info,
        //          18=blank, 19=exit
        this._actionMap = [
            null,                    // 0  category header
            'live-monitor',         // 1
            'view-channels',        // 2
            'manage-channels',      // 3
            'sync-all',             // 4
            'toggle-pause',         // 5
            'toggle-autosync',      // 6
            null,                    // 7  blank
            null,                    // 8  category header
            'search',               // 9
            'stats',                // 10
            'export',               // 11
            null,                    // 12 blank
            null,                    // 13 category header
            'database',             // 14
            'config',               // 15
            'health-check',         // 16
            'system-info',          // 17
            null,                    // 18 blank
            'exit',                 // 19
        ];
    }

    create() {
        // Main container
        this.widgets.main = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: '100%',
            style: STYLES.mainBox(),
        });

        // Header — app title + a subtle subtitle
        this.widgets.header = blessed.box({
            parent: this.widgets.main,
            top: 0, left: 0, width: '100%', height: 1,
            style: STYLES.header(),
            content: ' MSG-LOG  ·  DISCORD MESSAGE LOGGER',
        });

        // Dashboard status box — uses tags for colored output
        this.widgets.status = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%', height: 6,
            border: border(COLORS.BORDER),
            tags: true,
            label: ' Dashboard ',
            style: { border: { fg: COLORS.BORDER }, fg: COLORS.HIGHLIGHT },
        });

        // Menu list — items are plain strings, no Blessed tags in content
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 7, left: 0, width: '100%',
            height: this.screen.height - 9,
            border: border(COLORS.BORDER),
            tags: false,
            label: ' Menu ',
            style: {
                border: { fg: COLORS.BORDER },
                selected: { bg: COLORS.FOCUS_BG, fg: COLORS.FOCUS_FG, bold: true },
                item: { fg: COLORS.PRIMARY_FG },
            },
            mouse: true,
            keys: true,
            vi: true,
            items: this.buildMenuItems(),
        });

        // Footer
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: STYLES.footer(),
            content: ' UP/DOWN Navigate   ENTER Select   F1/? Help   ESC/Q Exit   Ctrl+C Quit',
        });

        this.widgets.menu.focus();

        this.widgets.menu.on('select', (item, index) => {
            const action = this._actionMap[index];
            if (action) this.onBack(action);
        });
    }

    buildMenuItems() {
        const items = [
            // Category headers use Unicode box-drawing prefix, no Blessed tags
            '\u2500\u2500 SYNC & MONITOR \u2500\u2500',
            '  Live Monitor',
            '  View Channels',
            '  Manage Channels',
            '  Sync All Channels',
            this.ctx.isPaused ? '  Resume Listening' : '  Pause Listening',
            this.ctx.autoSyncEnabled ? '  Disable Autosync' : '  Enable Autosync',
            '',
            '\u2500\u2500 DATA & SEARCH \u2500\u2500',
            '  Search Messages',
            '  View Statistics',
            '  Export Data',
            '',
            '\u2500\u2500 SYSTEM & CONFIG \u2500\u2500',
            '  Database Manager',
            '  Configuration',
            '  Health Check',
            '  System Information',
            '',
            '  Exit',
        ];

        this._rebuildActionMap();
        return items;
    }

    updateStatus() {
        const allJobs = this.ctx.jobManager.getAllJobs();
        const running = allJobs.filter(j => j.status === 'running');
        const completed = allJobs.filter(j => j.status === 'completed');
        const failed = allJobs.filter(j => j.status === 'error');

        const statusLabel = this.ctx.isPaused
            ? tagBold('yellow', 'PAUSED')
            : running.length
                ? tagBold('cyan', `WORKING (${running.length})`)
                : tagBold('green', 'ACTIVE');

        const uptime = formatDuration(this.ctx.performance?.getStats?.().uptime ?? 0);

        const text =
            `${tag('white', 'Status')}    ${statusLabel}\n` +
            `${tag('white', 'Autosync')}  ${this.ctx.autoSyncEnabled ? tag('green', 'ON') : dim('OFF')}\n` +
            `${tag('white', 'Channels')}  ${tag('cyan', String(this.ctx.listeningChannels.size))} listening\n` +
            `${tag('white', 'Jobs')}      ${tag('cyan', String(running.length))} running  ` +
            `${tag('green', String(completed.length))} done  ${tag('red', String(failed.length))} failed\n` +
            `${tag('white', 'Uptime')}    ${dim(uptime)}`;

        this.widgets.status.setContent(text);
    }

    setupKeyBindings() {
        this.widgets.menu.key(['escape', 'q'], () => this.onBack('exit'));
    }

    startUpdates() {
        this.updateStatus();
        this.updateInterval = setInterval(() => {
            this.updateStatus();

            // Only rebuild menu items when toggles change (avoid resetting scroll/navigation)
            const newItems = this.buildMenuItems();
            const fp = newItems.join('|');
            if (fp !== this._lastMenuFingerprint) {
                this._lastMenuFingerprint = fp;
                // Preserve the user's selection across setItems (blessed resets to
                // index 0 otherwise).
                const prevSelected = this.widgets.menu.selected;
                this.widgets.menu.setItems(newItems);
                if (prevSelected !== undefined && prevSelected < newItems.length) {
                    this.widgets.menu.select(prevSelected);
                }
            }

            this.screen.render();
        }, 500);
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this._resizeHandler) this.screen.removeListener('resize', this._resizeHandler);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default MainMenu;
