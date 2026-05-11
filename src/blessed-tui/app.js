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
                ' {yellow-fg}Q / ESC{/yellow-fg}      Back / Close Overlay\n\n' +
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
            screen.removeKey(['escape', 'q', 'enter', 'space'], close);
            // Re-focus current screen's main widget if possible
            if (this.currentScreen && this.currentScreen.widgets && this.currentScreen.widgets.menu) {
                this.currentScreen.widgets.menu.focus();
            } else if (this.currentScreen && this.currentScreen.widgets && this.currentScreen.widgets.main) {
                this.currentScreen.widgets.main.focus();
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
            switch (action) {
                case 'view-channels':
                    this.showScreen(ViewChannelsScreen);
                    break;

                case 'manage-channels':
                    this.showScreen(ChannelScreen);
                    break;

                case 'toggle-pause':
                    this.handleTogglePause();
                    break;

                case 'sync-all':
                    await this.handleSyncAll();
                    break;

                case 'toggle-autosync':
                    await this.handleToggleAutosync();
                    break;

                case 'stats':
                    this.showScreen(StatsScreen);
                    break;

                case 'live-monitor':
                    this.showLiveMonitor();
                    break;

                case 'search':
                    this.showScreen(SearchScreen);
                    break;

                case 'export':
                    this.showScreen(ExportScreen);
                    break;

                case 'database':
                    this.showScreen(DatabaseScreen);
                    break;

                case 'system-info':
                    this.showScreen(SystemInfoScreen);
                    break;

                case 'config':
                    this.showScreen(ConfigScreen);
                    break;

                case 'health-check':
                    this.showScreen(HealthScreen);
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
                this.ctx.isShuttingDown,
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
            this.ctx.isShuttingDown,
            () => this.ctx.isPaused
        ).catch(err => console.error('Sync error:', err));

        this.showLiveMonitor();
    }

    async handleToggleAutosync() {
        const { startAutoSync, stopAutoSync } = await import('../utils/index.js');

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
        process.exit(0);
    }

    cleanup() {
        if (this.currentScreen) this.currentScreen.destroy();
        if (this.screenManager) this.screenManager.destroy();
    }
}

export default BlessedTUIApp;
