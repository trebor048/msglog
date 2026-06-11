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

        // Global shortcuts
        screen.key(['f1', '?'], () => this.showHelpOverlay());
        screen.key(['C-l'], () => this.handleAction('live-monitor'));
        screen.key(['C-s'], () => this.handleAction('search'));
        screen.key(['C-m'], () => this.handleAction('manage-channels'));
        screen.key(['C-e'], () => this.handleAction('export'));
        screen.key(['C-v'], () => this.handleAction('view-channels'));
    }

    showHelpOverlay() {
        const screen = this.screenManager.getScreen();
        const helpBox = blessed.box({
            parent: screen,
            top: 'center', left: 'center',
            width: 60, height: 16,
            border: { type: 'line' },
            tags: true,
            label: ' Global Help ',
            style: {
                border: { fg: 'yellow' },
                bg: 'black',
                fg: 'white'
            },
            content: 
                '\n{cyan-fg}{bold}Global Shortcuts{/bold}{/cyan-fg}\n' +
                ' {yellow-fg}F1 / ?{/yellow-fg}      Show this help\n' +
                ' {yellow-fg}CTRL+M{/yellow-fg}      Manage Channels\n' +
                ' {yellow-fg}CTRL+L{/yellow-fg}      Live Monitor\n' +
                ' {yellow-fg}CTRL+S{/yellow-fg}      Search Messages\n' +
                ' {yellow-fg}CTRL+E{/yellow-fg}      Export Data\n' +
                ' {yellow-fg}CTRL+V{/yellow-fg}      View Channels\n' +
                ' {yellow-fg}ESC / Q{/yellow-fg}      Back / Close Overlay\n\n' +
                '{cyan-fg}{bold}Navigation{/bold}{/cyan-fg}\n' +
                ' {yellow-fg}Arrows / HJ KL{/yellow-fg} Navigate lists\n' +
                ' {yellow-fg}ENTER{/yellow-fg}           Select / Confirm\n' +
                ' {yellow-fg}TAB{/yellow-fg}             Switch between panels\n\n' +
                ' {gray-fg}Press any key to close{/gray-fg}'
        });

        screen.render();

        const close = () => {
            helpBox.destroy();
            screen.render();
            // onceKey auto-unregisters on fire, but click path needs explicit cleanup
            screen.removeKey(['escape', 'q', 'enter', 'space'], close);
            // Re-focus current screen's main interactive widget
            if (this.currentScreen?.widgets) {
                const w = this.currentScreen.widgets;
                (w.menu || w.jobList || w.table || w.health || w.content || w.main)?.focus();
            }
        };

        helpBox.on('click', close);
        screen.onceKey(['escape', 'q', 'enter', 'space'], close);
    }

    showMainMenu() {
        if (this.currentScreen) this.currentScreen.destroy();
        this.currentScreen = new MainMenu(
            this.screenManager.getScreen(),
            this.ctx,
            (action) => this.handleAction(action)
        );
        this.screenManager.render();
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
        if (this.currentScreen) this.currentScreen.destroy();
        this.currentScreen = new ScreenClass(
            this.screenManager.getScreen(),
            this.ctx,
            () => this.showMainMenu()
        );
        this.screenManager.render();
    }

    showLiveMonitor() {
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
            this.ctx.syncEngine.syncAllChannelsParallel(
                this.ctx.client,
                this.ctx.listeningChannels,
                this.ctx.withRetry,
                () => this.ctx.isShuttingDown,
                () => this.ctx.isPaused
            ).catch(err => console.error('Sync error:', err));
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
            this.ctx.dbManager?.saveAutoSync(false, this.ctx.autoSyncIntervalMs);
        } else {
            if (this.ctx.listeningChannels.size) {
                startAutoSync(this.ctx);
                this.ctx.dbManager?.saveAutoSync(true, this.ctx.autoSyncIntervalMs);
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
