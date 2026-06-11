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
            title: 'Discord Logger - msg-log',
            smartCSR: true,
            style: {
                border: { fg: 'cyan' },
                focus: { bg: 'blue', fg: 'white' },
                hover: { bg: 'green', fg: 'black' }
            }
        });

        // Route Ctrl+C through normal signal handling so graceful shutdown runs.
        this.screen.key(['C-c'], () => {
            process.kill(process.pid, 'SIGINT');
            return;
        });
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
