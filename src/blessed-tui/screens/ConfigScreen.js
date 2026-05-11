import blessed from 'blessed';
import { Validator } from '../../utils/utils.js';
import { saveConfig } from '../../utils/setup.js';

/**
 * Configuration Screen
 */
export class ConfigScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.config = ctx.config;

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
            content: ' CONFIGURATION'
        });

        // Left menu list — items are always plain strings, tags:true only for label
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '30%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Categories ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items: [
                'Database Settings',
                'Delay Settings',
                'Download Settings',
                '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
                'Back'
            ]
        });

        // Right output box — uses color tags in setContent, needs tags:true
        this.widgets.output = blessed.box({
            parent: this.widgets.main,
            top: 1, left: '30%', width: '70%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Current Values ',
            style: { border: { fg: 'blue' } },
            content: this.getCurrentConfigDisplay()
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

    getCurrentConfigDisplay() {
        let c = '\n{cyan-fg}{bold}Active Settings{/bold}{/cyan-fg}\n';
        c += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
        c += ` Database:       {green-fg}${this.config.databaseFile}{/green-fg}\n`;
        c += ` Global Delay:   {green-fg}${this.config.globalDelay}ms{/green-fg}\n`;
        c += ` Max Fast Req:   {green-fg}${this.config.maxFastRequests}{/green-fg}\n`;
        c += ` Jitter:         {green-fg}${this.config.randomDelayMin}-${this.config.randomDelayMax}ms{/green-fg}\n`;
        c += ` Downloads:      {${this.config.downloadAttachments ? 'green' : 'red'}-fg}${this.config.downloadAttachments ? 'ENABLED' : 'DISABLED'}{/${this.config.downloadAttachments ? 'green' : 'red'}-fg}\n`;
        c += ` DL Timeout:     {green-fg}${this.config.downloadTimeoutSeconds}s{/green-fg}\n`;
        return c;
    }

    handleMenuSelect(index) {
        if (index === 0) this.editDatabase();
        else if (index === 1) this.editDelays();
        else if (index === 2) this.editDownloads();
        else if (index === 4) this.onBack();
        // index 3 is separator
    }

    editDatabase() {
        this.promptInput('Database file path (.db):', this.config.databaseFile, (val) => {
            if (!val.endsWith('.db')) {
                this.widgets.output.setContent('\n{red-fg}Error: File must end with .db{/red-fg}');
                return;
            }
            this.config.databaseFile = val;
            saveConfig(this.config);
            this.widgets.output.setContent(
                '\n{yellow-fg}Saved! Restart required for DB path change.{/yellow-fg}\n\n' +
                this.getCurrentConfigDisplay()
            );
        });
    }

    editDelays() {
        const fields = [
            { key: 'globalDelay', label: 'Global delay (ms)', min: 0, max: 30000 },
            { key: 'maxFastRequests', label: 'Max fast requests', min: 1, max: 1000 },
            { key: 'randomDelayMin', label: 'Random delay min (ms)', min: 0, max: 30000 },
            { key: 'randomDelayMax', label: 'Random delay max (ms)', min: 0, max: 30000 }
        ];
        this.editFieldChain(fields, 0);
    }

    editFieldChain(fields, idx) {
        if (idx >= fields.length) {
            saveConfig(this.config);
            this.widgets.output.setContent(
                '\n{green-fg}Delays updated and saved.{/green-fg}\n\n' +
                this.getCurrentConfigDisplay()
            );
            this.widgets.menu.focus();
            this.screen.render();
            return;
        }

        const field = fields[idx];
        this.promptInput(`${field.label}:`, String(this.config[field.key]), (val) => {
            const num = parseInt(val, 10);
            if (isNaN(num) || num < field.min || num > field.max) {
                this.widgets.output.setContent(
                    `\n{red-fg}Invalid value (must be ${field.min}–${field.max}){/red-fg}`
                );
                return;
            }
            this.config[field.key] = num;
            this.editFieldChain(fields, idx + 1);
        });
    }

    editDownloads() {
        // Dialog list — items are plain strings (no tags in items array)
        const dialog = blessed.list({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 6,
            border: { type: 'line' },
            tags: true,
            label: ' Media Downloads ',
            style: {
                border: { fg: 'yellow' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            items: ['Enable Downloads', 'Disable Downloads']
        });

        dialog.select(this.config.downloadAttachments ? 0 : 1);
        dialog.focus();
        this.screen.render();

        dialog.on('select', (item, index) => {
            dialog.destroy();
            this.config.downloadAttachments = (index === 0);
            saveConfig(this.config);
            this.widgets.output.setContent(
                '\n{green-fg}Download setting saved.{/green-fg}\n\n' +
                this.getCurrentConfigDisplay()
            );
            this.widgets.menu.focus();
            this.screen.render();
        });

        dialog.key(['q', 'escape'], () => {
            dialog.destroy();
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    promptInput(label, defaultVal, callback) {
        const input = blessed.textbox({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 3,
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ` ${label} `,
            inputOnFocus: true
        });

        // Set value and position cursor at the end
        input.setValue(defaultVal);
        input.focus();
        
        // Move cursor to end of text
        setImmediate(() => {
            if (input.screen && input.screen.program) {
                input.screen.program.cursorPos(
                    input.top + 1,
                    input.left + 1 + defaultVal.length
                );
            }
        });
        
        this.screen.render();

        input.on('submit', (val) => {
            input.destroy();
            callback(val || defaultVal);
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

export default ConfigScreen;
