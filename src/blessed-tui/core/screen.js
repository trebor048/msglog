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
            // 'C-c' stays routable even while a textbox/question is reading
            // (blessed sets grabKeys and swallows screen-level keys during
            // input); without this the advertised "Ctrl+C Quit" is dead
            // whenever a prompt is open.
            ignoreLocked: ['C-c'],
            style: {
                border: { fg: 'cyan' },
                focus: { bg: 'blue', fg: 'white' },
                hover: { bg: 'green', fg: 'black' }
            }
        });

        // Route Ctrl+C through the registered signal handler so graceful
        // shutdown runs. On Windows process.kill(pid,'SIGINT') hard-kills,
        // so emit the signal directly to trigger the handler cross-platform.
        this.screen.key(['C-c'], () => {
            process.emit('SIGINT');
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
            this.screen = null;
        }
    }
}

export default ScreenManager;
