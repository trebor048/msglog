import blessed from 'blessed';

/**
 * Enhanced Screen Manager
 * Handles all screen creation and management
 */
export class ScreenManager {
    constructor() {
        this.screen = blessed.screen({
            mouse: true,
            keyboard: true,
            title: '🤖 Discord Logger - msg-log',
            smartCSR: true,
            style: {
                border: { fg: 'cyan' },
                focus: { bg: 'blue', fg: 'white' },
                hover: { bg: 'green', fg: 'black' }
            }
        });

        // Handle exit
        this.screen.key(['escape', 'C-c'], () => {
            return process.exit(0);
        });

        this.currentScreen = null;
    }

    /**
     * Switch to a new screen
     */
    switchScreen(screenComponent) {
        // Clear previous screen
        if (this.currentScreen) {
            this.currentScreen.destroy();
        }

        // Render new screen
        this.currentScreen = screenComponent;
        this.screen.render();
    }

    /**
     * Get the blessed screen instance
     */
    getScreen() {
        return this.screen;
    }

    /**
     * Render the screen
     */
    render() {
        this.screen.render();
    }

    /**
     * Destroy the screen
     */
    destroy() {
        if (this.screen) {
            this.screen.destroy();
        }
    }
}

export default ScreenManager;
