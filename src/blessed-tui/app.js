import blessed from 'blessed';
import ScreenManager from './core/screen.js';
import MainMenu from './screens/MainMenu.js';
import LiveMonitor from './screens/LiveMonitor.js';
import StatsScreen from './screens/StatsScreen.js';
import HealthScreen from './screens/HealthScreen.js';
import SearchScreen from './screens/SearchScreen.js';
import ExportScreen from './screens/ExportScreen.js';
import DatabaseScreen from './screens/DatabaseScreen.js';
import ConfigScreen from './screens/ConfigScreen.js';
import ChannelScreen from './screens/ChannelScreen.js';
import ViewChannelsScreen from './screens/ViewChannelsScreen.js';
import SystemInfoScreen from './screens/SystemInfoScreen.js';
import { sleep } from '../utils/utils.js';
import { startAutoSync, stopAutoSync } from '../utils/autosync.js';
import { BORDER_TYPE } from '../utils/terminal.js';

// Table-driven action dispatch — add new screens here, no switch-statement changes needed
const ACTION_SCREENS = {
    'view-channels':    ViewChannelsScreen,
    'manage-channels':  ChannelScreen,
    'stats':            StatsScreen,
    'search':           SearchScreen,
    'export':           ExportScreen,
    'database':         DatabaseScreen,
    'system-info':      SystemInfoScreen,
    'config':           ConfigScreen,
    'health-check':     HealthScreen,
};

/**
 * Main TUI Application
 * Manages screen navigation and user interactions — fully Blessed-native, no legacy fallback
 */
export class BlessedTUIApp {
    constructor(ctx) {
        this.ctx = ctx;
        this.screenManager = new ScreenManager();
        this.currentScreen = null;
        this.isRunning = true;
    }

    async start() {
        try {
            this.setupGlobalKeys();
            this.showMainMenu();
        } catch (err) {
            console.error('TUI Error:', err);
            this.cleanup();
            throw err;
        }
    }

    setupGlobalKeys() {
        const screen = this.screenManager.getScreen();

        // An input widget currently owns the keyboard. Blessed's `grabKeys`
        // gate already suppresses screen-level keys while a textbox/textarea is
        // *reading*, but the blessed `question` widget never sets grabKeys, so
        // global shortcuts WOULD fire while a y/n question is on screen. Guard
        // every global shortcut so Ctrl+L/S/E/V and F1/? never yank the user
        // out of a prompt mid-typing.
        const isTyping = () => {
            const focused = screen.focused;
            return Boolean(focused && (
                focused.type === 'textbox' ||
                focused.type === 'textarea' ||
                focused.type === 'question'
            ));
        };

        // Global shortcuts
        screen.key(['f1', '?'], () => {
            // Don't open help while typing in a text input — a literal '?' typed
            // into a search/filename prompt shouldn't pop the overlay.
            if (isTyping()) return;
            // Don't re-create the overlay if it is already open (avoids the
            // flicker/focus-churn of destroy + rebuild on every '?').
            if (this._helpBox) return;
            this.showHelpOverlay();
        });
        screen.key(['C-l'], () => { if (!isTyping()) this.handleAction('live-monitor'); });
        screen.key(['C-s'], () => { if (!isTyping()) this.handleAction('search'); });
        screen.key(['C-e'], () => { if (!isTyping()) this.handleAction('export'); });
        screen.key(['C-v'], () => { if (!isTyping()) this.handleAction('view-channels'); });

        // NOTE: no 'C-m' binding — in blessed a physical Ctrl+M is the same
        // byte as Enter (\r) and is normalized to the 'enter' key, so a
        // 'C-m' handler can never fire. Manage Channels stays reachable via
        // the main menu.
    }

    showHelpOverlay() {
        const screen = this.screenManager.getScreen();

        // Close any existing help overlay and remove its stale close handler
        if (this._helpBox) {
            if (this._helpClose) screen.removeKey(['escape', 'q', 'enter', 'space'], this._helpClose);
            try { this._helpBox.destroy(); } catch {}
            this._helpBox = null;
            this._helpClose = null;
        }

        const helpBox = blessed.box({
            parent: screen,
            top: 'center', left: 'center',
            width: 66, height: 16,
            border: { type: BORDER_TYPE },
            tags: true,
            label: ' Help ',
            focusable: true,
            keys: true,
            mouse: true,
            style: {
                border: { fg: 'yellow' },
                bg: 'black',
                fg: 'white'
            },
            content:
                '\n{cyan-fg}{bold}Global Shortcuts{/bold}{/cyan-fg}\n' +
                ' {yellow-fg}F1/?{/yellow-fg}   Help          {yellow-fg}CTRL+L{/yellow-fg}  Live Monitor\n' +
                ' {yellow-fg}CTRL+S{/yellow-fg} Search        {yellow-fg}CTRL+E{/yellow-fg}  Export Data\n' +
                ' {yellow-fg}CTRL+V{/yellow-fg} View Channels {yellow-fg}ESC/Q{/yellow-fg}    Back\n\n' +
                '{cyan-fg}{bold}Navigation{/bold}{/cyan-fg}\n' +
                ' {yellow-fg}Arrows/HJKL{/yellow-fg} Move       {yellow-fg}ENTER{/yellow-fg}  Select\n' +
                ' {yellow-fg}TAB{/yellow-fg}  Switch panel\n\n' +
                '{cyan-fg}{bold}Live Monitor{/bold}{/cyan-fg}\n' +
                ' {yellow-fg}C{/yellow-fg}  Cancel job    {yellow-fg}D{/yellow-fg}  Delete job\n' +
                ' {yellow-fg}UP/DOWN{/yellow-fg} Scroll log (pauses auto-scroll)\n\n' +
                ' {gray-fg}ESC / Q / ENTER / SPACE to close{/gray-fg}'
        });
        this._helpBox = helpBox;
        helpBox.focus();
        screen.render();

        const close = () => {
            if (this._helpClose) screen.removeKey(['escape', 'q', 'enter', 'space'], this._helpClose);
            helpBox.destroy();
            this._helpBox = null;
            this._helpClose = null;
            screen.render();
            // Re-focus current screen's main interactive widget
            if (this.currentScreen?.widgets) {
                const w = this.currentScreen.widgets;
                (w.menu || w.jobList || w.list || w.table || w.health || w.content)?.focus();
            }
        };
        this._helpClose = close;

        helpBox.on('click', close);
        // Focus the help box so close keys don't also reach the underlying screen
        screen.onceKey(['escape', 'q', 'enter', 'space'], close);
    }

    showMainMenu() {
        this.closeHelpOverlay();
        if (this.currentScreen) this.currentScreen.destroy();
        this.currentScreen = new MainMenu(
            this.screenManager.getScreen(),
            this.ctx,
            (action) => this.handleAction(action)
        );
        this.screenManager.render();
    }

    closeHelpOverlay() {
        if (this._helpBox) {
            if (this._helpClose) this.screenManager.getScreen().removeKey(['escape', 'q', 'enter', 'space'], this._helpClose);
            try { this._helpBox.destroy(); } catch {}
            this._helpBox = null;
            this._helpClose = null;
            this.screenManager.render();
        }
    }

    async handleAction(action) {
        try {
            // Table-driven screen dispatch
            if (ACTION_SCREENS[action]) {
                this.showScreen(ACTION_SCREENS[action]);
                return;
            }

            switch (action) {
                case 'toggle-pause':
                    this.handleTogglePause();
                    break;

                case 'sync-all':
                    await this.handleSyncAll();
                    break;

                case 'toggle-autosync':
                    await this.handleToggleAutosync();
                    break;

                case 'live-monitor':
                    this.showLiveMonitor();
                    break;

                case 'exit':
                    await this.handleExit();
                    break;

                default:
                    this.showMainMenu();
            }
        } catch (err) {
            console.error('Action error:', err);
            this.showMainMenu();
        }
    }

    /**
     * Generic screen launcher — creates a screen with standard onBack
     */
    showScreen(ScreenClass) {
        this.closeHelpOverlay();
        if (this.currentScreen) this.currentScreen.destroy();
        this.currentScreen = new ScreenClass(
            this.screenManager.getScreen(),
            this.ctx,
            () => this.showMainMenu()
        );
        this.screenManager.render();
    }

    showLiveMonitor() {
        this.closeHelpOverlay();
        if (this.currentScreen) this.currentScreen.destroy();
        this.currentScreen = new LiveMonitor(
            this.screenManager.getScreen(),
            this.ctx,
            () => this.showMainMenu()
        );
        this.screenManager.render();
    }

    handleTogglePause() {
        this.ctx.isPaused = !this.ctx.isPaused;

        if (!this.ctx.isPaused && this.ctx.listeningChannels.size) {
            Promise.resolve().then(() => this.ctx.syncEngine.syncAllChannelsParallel(
                this.ctx.client,
                this.ctx.listeningChannels,
                this.ctx.withRetry,
                () => this.ctx.isShuttingDown,
                () => this.ctx.isPaused
            )).catch(err => console.error('Sync error:', err));
            this.showLiveMonitor();
            return;
        }

        this.showMainMenu();
    }

    async handleSyncAll() {
        if (!this.ctx.listeningChannels.size) {
            await sleep(500);
            this.showMainMenu();
            return;
        }

        this.ctx.syncEngine.syncAllChannelsParallel(
            this.ctx.client,
            this.ctx.listeningChannels,
            this.ctx.withRetry,
            () => this.ctx.isShuttingDown,
            () => this.ctx.isPaused
        ).catch(err => console.error('Sync error:', err));

        this.showLiveMonitor();
    }

    async handleToggleAutosync() {
        if (this.ctx.autoSyncEnabled) {
            stopAutoSync(this.ctx);
            const saved = this.ctx.dbManager?.saveAutoSync(false, this.ctx.autoSyncIntervalMs) ?? true;
            if (!saved) {
                // Can't revert by re-enabling (that would refire sync bursts),
                // so at least warn loudly — the live state is authoritative.
                this.ctx.logger?.warn?.('Autosync disabled for this session, but the preference failed to persist');
            }
        } else {
            if (this.ctx.listeningChannels.size) {
                startAutoSync(this.ctx);
                const saved = this.ctx.dbManager?.saveAutoSync(true, this.ctx.autoSyncIntervalMs) ?? true;
                if (!saved) {
                    // Revert (cheap: just clears the interval) so live state
                    // and persisted preference can't silently diverge.
                    stopAutoSync(this.ctx);
                    this.ctx.logger?.warn?.('Autosync enable failed to persist — autosync left disabled');
                }
            } else {
                // No channels to sync — surface feedback instead of silently no-op
                this.ctx.logger?.warn?.('Autosync toggle ignored: no listening channels');
            }
        }

        this.showMainMenu();
    }

    async handleExit() {
        this.isRunning = false;
        this.cleanup();
        await this.ctx.gracefulShutdown('user exit');
    }

    cleanup() {
        if (this.currentScreen) this.currentScreen.destroy();
        if (this.screenManager) this.screenManager.destroy();
    }
}

export default BlessedTUIApp;
