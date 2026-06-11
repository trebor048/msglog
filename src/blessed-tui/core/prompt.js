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

        screen.render();
        input.setValue(defaultVal);
        input.focus();

        input.key('enter', () => {
            const val = input.getValue() || defaultVal;
            input.destroy();
            screen.render();
            resolve(val);
        });

        input.key('escape', () => {
            input.destroy();
            screen.render();
            resolve(null);
        });
    });
}

/**
 * Reusable confirmation dialog.
 * Returns true if user selected "Yes, proceed", false otherwise.
 */
export function confirmDialog(screen, parent, message) {
    return new Promise((resolve) => {
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

        dialog.on('select', (item, index) => {
            dialog.destroy();
            screen.render();
            resolve(index === 1);
        });

        dialog.key(['escape', 'q'], () => {
            dialog.destroy();
            screen.render();
            resolve(false);
        });
    });
}

export default { promptInput, confirmDialog };
