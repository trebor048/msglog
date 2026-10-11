import blessed from 'blessed';

/**
 * Reusable text input prompt for Blessed TUI screens.
 * Returns a Promise that resolves with the entered value (or null if cancelled).
 *
 * @param {object} screen  Blessed screen instance
 * @param {object} parent  Parent widget to attach the input to
 * @param {string} label   Prompt label
 * @param {string} [defaultVal='']  Default value
 * @returns {Promise<string|null>}
 */
export function promptInput(screen, parent, label, defaultVal = '') {
    return new Promise((resolve) => {
        // Remember what had focus so we can hand it back after the prompt
        // closes — otherwise widget-level key bindings silently stop working.
        const prevFocused = screen.focused;

        const input = blessed.textbox({
            parent,
            top: 'center',
            left: 'center',
            width: '60%',
            height: 3,
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ` ${label} `,
            inputOnFocus: true,
            keys: true,
            mouse: true,
        });

        // Set the default BEFORE the first render so it is visible immediately.
        input.setValue(defaultVal);
        screen.render();
        input.focus();

        const finish = (value) => {
            input.destroy();
            if (prevFocused && !prevFocused.destroyed) prevFocused.focus();
            screen.render();
            resolve(value);
        };

        input.key('enter', () => {
            finish(input.getValue() || defaultVal);
        });

        input.key('escape', () => {
            finish(null);
        });
    });
}

/**
 * Reusable confirmation dialog.
 * Returns true if user selected "Yes, proceed", false otherwise.
 */
export function confirmDialog(screen, parent, message) {
    return new Promise((resolve) => {
        // Remember what had focus so we can hand it back after the dialog closes.
        const prevFocused = screen.focused;

        const dialog = blessed.list({
            parent,
            top: 'center',
            left: 'center',
            width: '65%',
            height: 6,
            border: { type: 'line' },
            tags: true,
            label: ' Confirm ',
            style: {
                border: { fg: 'yellow' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' },
            },
            items: [
                message,
                '  Yes, proceed',
                '  No, cancel',
            ],
        });

        dialog.select(1);
        dialog.focus();
        screen.render();

        const finish = (value) => {
            dialog.destroy();
            if (prevFocused && !prevFocused.destroyed) prevFocused.focus();
            screen.render();
            resolve(value);
        };

        dialog.on('select', (item, index) => {
            finish(index === 1);
        });

        dialog.key(['escape', 'q'], () => {
            finish(false);
        });
    });
}

export default { promptInput, confirmDialog };
