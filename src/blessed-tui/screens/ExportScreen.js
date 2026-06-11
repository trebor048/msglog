import blessed from 'blessed';
import { Validator } from '../../utils/utils.js';

const FORMAT_CONFIG = {
    json:   { label: 'JSON Export',     ext: '.json', exportFn: 'exportToJSON' },
    csv:    { label: 'CSV Export',      ext: '.csv',  exportFn: 'exportToCSV' },
    html:   { label: 'HTML Export',     ext: '.html', exportFn: 'exportToHTML' },
    backup: { label: 'DB Backup',       ext: '.db',   exportFn: 'backupDatabase' },
};

/** Strip known file extensions from user input to avoid double-extension */
const STRIP_EXTENSIONS = ['.json', '.csv', '.html', '.db', '.sqlite', '.sqlite3'];

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
            content: ' UP/DOWN Navigate  ENTER Select  ? Help  ESC/Q Back'
        });

        this.widgets.menu.focus();
        this.widgets.menu.on('select', (item, index) => this.handleMenuSelect(index));
    }

    handleMenuSelect(index) {
        if (index === 5) { this.onBack(); return; }
        if (index === 4) return; // separator
        const formatKeys = Object.keys(FORMAT_CONFIG);
        const format = formatKeys[index];
        if (format) this.promptFilename(format);
    }

    promptFilename(format) {
        const cfg = FORMAT_CONFIG[format];
        const defaultName = `export_${new Date().toISOString().split('T')[0]}`;

        const input = blessed.textbox({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 3,
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ` Filename for ${cfg.label} `,
            inputOnFocus: true,
            keys: true,
            mouse: true
        });

        this.screen.render();

        input.setValue(defaultName);
        input.focus();

        input.key('enter', async () => {
            const value = input.getValue() || defaultName;
            input.destroy();
            this.screen.render();

            // Strip known extensions to prevent double-extension
            let clean = Validator.sanitizeFilename(value);
            for (const ext of STRIP_EXTENSIONS) {
                if (clean.toLowerCase().endsWith(ext.toLowerCase())) {
                    clean = clean.slice(0, -ext.length);
                    break;
                }
            }
            const filename = clean + cfg.ext;

            // Path confinement: ensure output stays within exports/ or backups/
            const outDir = format === 'backup' ? 'backups' : 'exports';
            try {
                Validator.validatePathConfinement(filename, outDir);
            } catch (err) {
                this.widgets.status.setContent(`\n{red-fg}Invalid filename — path traversal blocked{/red-fg}`);
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }

            // Confirmation prompt
            this.confirmExport(format, filename, outDir);
        });

        input.key('escape', () => {
            input.destroy();
            this.screen.render();
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    confirmExport(format, filename, outDir) {
        const cfg = FORMAT_CONFIG[format];
        const safeTarget = Validator.sanitizeBlessedTags(`${outDir}/${filename}`);
        const dialog = blessed.list({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '65%', height: 6,
            border: { type: 'line' },
            tags: true,
            label: ' Confirm Export ',
            style: {
                border: { fg: 'yellow' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            items: [
                `Export as ${cfg.label} to ${safeTarget}`,
                '  Yes, proceed',
                '  No, cancel'
            ]
        });

        dialog.select(1);
        dialog.focus();
        this.screen.render();

        dialog.on('select', (item, index) => {
            dialog.destroy();
            if (index === 1) {
                this.doExport(format, filename);
            } else {
                this.widgets.status.setContent('\n{gray-fg}Export cancelled{/gray-fg}');
                this.widgets.menu.focus();
                this.screen.render();
            }
        });

        dialog.key(['escape', 'q'], () => {
            dialog.destroy();
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    async doExport(format, filename) {
        const cfg = FORMAT_CONFIG[format];
        this.widgets.status.setContent(`\n{yellow-fg}Exporting ${cfg.label}...{/yellow-fg}`);
        this.screen.render();

        try {
            const exportFn = this.exporter[cfg.exportFn].bind(this.exporter);
            const result = await exportFn(filename);

            const filepath = result.filepath || result;
            const count = result.count || 'N/A';
            const safeFilepath = Validator.sanitizeBlessedTags(String(filepath));

            this.widgets.status.setContent(
                `\n{green-fg}Export successful!{/green-fg}\n\n` +
                ` File saved to:\n {gray-fg}${safeFilepath}{/gray-fg}\n` +
                (format !== 'backup' ? ` Messages exported: {green-fg}${typeof count === 'number' ? count.toLocaleString() : count}{/green-fg}` : '')
            );
        } catch (err) {
            const msg = Validator.sanitizeErrorMessage(err);
            this.widgets.status.setContent(`\n{red-fg}Export failed: ${msg}{/red-fg}`);
        }

        this.widgets.menu.focus();
        this.screen.render();
    }

    setupKeyBindings() {
        this.widgets.menu.key(['escape', 'q'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default ExportScreen;
