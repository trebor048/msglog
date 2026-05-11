import blessed from 'blessed';
import { Validator, TuiSpinner } from '../../utils/utils.js';

/**
 * Export Data Screen
 */
export class ExportScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.exporter = ctx.exporter;

        this.create();
        this.setupKeyBindings();
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
            content: ' EXPORT DATA'
        });

        // Left menu list — items are always plain strings, tags:true only for label
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '30%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Formats ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items: [
                'JSON Export',
                'CSV Export',
                'HTML Export',
                'DB Backup',
                '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
                'Back'
            ]
        });

        // Right status box — uses color tags in setContent, needs tags:true
        this.widgets.status = blessed.box({
            parent: this.widgets.main,
            top: 1, left: '30%', width: '70%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Export Status ',
            style: { border: { fg: 'blue' } },
            content: '\n{gray-fg}Select a format to export the database{/gray-fg}'
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' UP/DOWN Navigate  ENTER Select  ? Help  Q Back'
        });

        this.widgets.menu.focus();
        this.widgets.menu.on('select', (item, index) => this.handleMenuSelect(index));
    }

    handleMenuSelect(index) {
        const formats = ['json', 'csv', 'html', 'backup'];
        if (index === 5) { this.onBack(); return; }
        if (index === 4) return; // separator
        this.promptFilename(formats[index]);
    }

    promptFilename(format) {
        const defaultName = `export_${new Date().toISOString().split('T')[0]}`;
        const ext = { json: '.json', csv: '.csv', html: '.html', backup: '.db' }[format];

        const input = blessed.textbox({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 3,
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ` Filename for ${format.toUpperCase()} `,
            inputOnFocus: true
        });

        // Set value and position cursor at the end
        input.setValue(defaultName);
        input.focus();
        
        // Move cursor to end of text
        setImmediate(() => {
            if (input.screen && input.screen.program) {
                input.screen.program.cursorPos(
                    input.top + 1,
                    input.left + 1 + defaultName.length
                );
            }
        });
        
        this.screen.render();

        input.on('submit', async (value) => {
            input.destroy();
            const filename = Validator.sanitizeFilename(value || defaultName);
            this.widgets.status.setContent(`\n{yellow-fg}Exporting ${filename}${ext}...{/yellow-fg}`);
            this.screen.render();

            try {
                let result;
                if (format === 'json') result = await this.exporter.exportToJSON(`${filename}.json`);
                else if (format === 'csv') result = await this.exporter.exportToCSV(`${filename}.csv`);
                else if (format === 'html') result = await this.exporter.exportToHTML(`${filename}.html`);
                else if (format === 'backup') result = await this.exporter.backupDatabase(`${filename}.db`);

                const filepath = result.filepath || result;
                const count = result.count || 'N/A';
                
                this.widgets.status.setContent(
                    `\n{green-fg}Export successful!{/green-fg}\n\n` +
                    ` File saved to:\n {gray-fg}${filepath}{/gray-fg}\n` +
                    (format !== 'backup' ? ` Messages exported: {green-fg}${count.toLocaleString()}{/green-fg}` : '')
                );
            } catch (err) {
                this.widgets.status.setContent(`\n{red-fg}Export failed: ${err.message}{/red-fg}`);
            }

            this.widgets.menu.focus();
            this.screen.render();
        });

        input.on('cancel', () => {
            input.destroy();
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    setupKeyBindings() {
        this.widgets.menu.key(['q', 'escape'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default ExportScreen;
