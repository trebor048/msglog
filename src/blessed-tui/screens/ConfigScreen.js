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
        this._destroyed = false;
        this._resizeHandler = null;

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
            content: ' UP/DOWN Navigate  ENTER Select  ? Help  ESC/Q Back'
        });

        this.widgets.menu.focus();
        this.widgets.menu.on('select', (item, index) => this.handleMenuSelect(index));

        this._resizeHandler = () => {
            this.widgets.menu.height = this.screen.height - 3;
            this.widgets.output.height = this.screen.height - 3;
            this.screen.render();
        };
        this.screen.on('resize', this._resizeHandler);
    }

    getCurrentConfigDisplay() {
        let c = '\n{cyan-fg}{bold}Active Settings{/bold}{/cyan-fg}\n';
        c += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
        c += ` Database:       {green-fg}${Validator.sanitizeBlessedTags(this.config.databaseFile)}{/green-fg}\n`;
        c += ` Global Delay:   {green-fg}${this.config.globalDelay}ms{/green-fg}\n`;
        c += ` Sync Delay:     {green-fg}${this.config.syncRequestDelayMs}ms{/green-fg} {gray-fg}(bulk fetch pacing){/gray-fg}\n`;
        c += ` Max Fast Req:   {green-fg}${this.config.maxFastRequests}{/green-fg}\n`;
        c += ` RL Channels:    {green-fg}${this.config.maxRateLimitChannels}{/green-fg}\n`;
        c += ` Max Sync Pages: {green-fg}${this.config.maxSyncPages}{/green-fg}\n`;
        c += ` Jitter:         {green-fg}${this.config.randomDelayMin}-${this.config.randomDelayMax}ms{/green-fg}\n`;
        c += ` Event Queue:    {green-fg}${this.config.maxEventQueueSize}{/green-fg}\n`;
        c += ` Retention Days: {green-fg}${this.config.deletedRetentionDays}{/green-fg}\n`;
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
        this.promptInput('Database file path (.db):', this.config.databaseFile, async (val) => {
            // Escape cancels — restore focus without touching config
            if (val === null) {
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }
            if (!val.toLowerCase().endsWith('.db')) {
                this.widgets.output.setContent('\n{red-fg}Error: File must end with .db{/red-fg}');
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }
            // Validate path stays within project directory
            try {
                Validator.validateDatabasePath(val, process.cwd());
            } catch (err) {
                this.widgets.output.setContent(
                    `\n{red-fg}Invalid path: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`
                );
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }

            const previous = this.config.databaseFile;
            this.config.databaseFile = val;
            try {
                await saveConfig(this.config);
                this.widgets.output.setContent(
                    '\n{green-fg}Saved! Restart required for DB path change.{/green-fg}\n\n' +
                    this.getCurrentConfigDisplay()
                );
            } catch (err) {
                // Save failed — revert the in-memory path so a later unrelated
                // saveConfig never persists a change the user was told failed.
                this.config.databaseFile = previous;
                this.widgets.output.setContent(
                    `\n{red-fg}Save failed — database path unchanged: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`
                );
            }
            // A global shortcut may have navigated away during the save await.
            if (this._destroyed) return;
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    editDelays() {
        const fields = [
            { key: 'globalDelay', label: 'Global delay (ms)', min: 50, max: 30000 },
            { key: 'syncRequestDelayMs', label: 'Sync fetch delay (ms) — lower = faster catch-up', min: 50, max: 5000 },
            { key: 'maxFastRequests', label: 'Max fast requests', min: 1, max: 1000 },
            { key: 'maxRateLimitChannels', label: 'Max rate-limit channels', min: 100, max: 500000 },
            { key: 'maxSyncPages', label: 'Max sync pages', min: 1, max: 1000000 },
            { key: 'randomDelayMin', label: 'Random delay min (ms)', min: 0, max: 30000 },
            { key: 'randomDelayMax', label: 'Random delay max (ms)', min: 0, max: 30000 },
            { key: 'maxEventQueueSize', label: 'Max event queue size', min: 100, max: 100000 },
            { key: 'deletedRetentionDays', label: 'Deleted retention days', min: 1, max: 3650 }
        ];
        // Snapshot the live values so escaping mid-chain restores them and a
        // later unrelated saveConfig never persists abandoned partial edits.
        const snapshot = Object.fromEntries(fields.map(f => [f.key, this.config[f.key]]));
        this.editFieldChain(fields, 0, snapshot);
    }

    async editFieldChain(fields, idx, snapshot = null) {
        if (idx >= fields.length) {
            if (this.config.randomDelayMin > this.config.randomDelayMax) {
                this.widgets.output.setContent('\n{red-fg}Invalid jitter: min must be less than or equal to max{/red-fg}');
                // Restore the snapshot so the invalid combination isn't persisted
                // by a later unrelated saveConfig.
                if (snapshot) {
                    for (const [k, v] of Object.entries(snapshot)) {
                        this.config[k] = v;
                    }
                }
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }

            try {
                await saveConfig(this.config);
                this.widgets.output.setContent(
                    '\n{green-fg}Delays updated and saved.{/green-fg}\n\n' +
                    this.getCurrentConfigDisplay()
                );
            } catch (err) {
                // Persist failed — revert the in-memory values so a later
                // unrelated saveConfig doesn't silently persist this abandoned edit.
                if (snapshot) {
                    for (const [k, v] of Object.entries(snapshot)) {
                        this.config[k] = v;
                    }
                }
                this.widgets.output.setContent(
                    `\n{red-fg}Save failed — changes reverted: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`
                );
            }
            // A global shortcut may have navigated away during the save await.
            if (this._destroyed) return;
            this.widgets.menu.focus();
            this.screen.render();
            return;
        }

        const field = fields[idx];
        this.promptInput(`${field.label}:`, String(this.config[field.key]), async (val) => {
            // Restore the snapshot on any abort so the live config isn't left
            // half-mutated (a later unrelated saveConfig would persist it).
            const restore = () => {
                if (snapshot) {
                    for (const [k, v] of Object.entries(snapshot)) {
                        this.config[k] = v;
                    }
                }
                this.widgets.menu.focus();
                this.screen.render();
            };
            // Escape cancels the whole chain
            if (val === null) {
                restore();
                return;
            }
            // Strict numeric check: reject partially-numeric input like "12abc"
            if (!/^\d+$/.test(String(val).trim())) {
                this.widgets.output.setContent(
                    `\n{red-fg}Invalid value (must be ${field.min}–${field.max}){/red-fg}`
                );
                restore();
                return;
            }
            const num = parseInt(val, 10);
            if (isNaN(num) || num < field.min || num > field.max) {
                this.widgets.output.setContent(
                    `\n{red-fg}Invalid value (must be ${field.min}–${field.max}){/red-fg}`
                );
                restore();
                return;
            }
            this.config[field.key] = num;
            await this.editFieldChain(fields, idx + 1, snapshot);
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

        dialog.on('select', async (item, index) => {
            dialog.destroy();
            this.config.downloadAttachments = (index === 0);
            try {
                await saveConfig(this.config);
                // A global shortcut may have navigated away during the await.
                if (this._destroyed) return;
                this.widgets.output.setContent(
                    '\n{green-fg}Download setting saved.{/green-fg}\n\n' +
                    this.getCurrentConfigDisplay()
                );
            } catch (err) {
                if (this._destroyed) return;
                this.widgets.output.setContent(`\n{red-fg}Save failed: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
            }
            this.widgets.menu.focus();
            this.screen.render();
        });

        dialog.key(['escape', 'q'], () => {
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
            inputOnFocus: true,
            keys: true,
            mouse: true
        });

        // Set value & focus FIRST, then render — otherwise the default value
        // stays invisible until the next paint (focus() alone does not paint).
        input.setValue(defaultVal);
        input.focus();
        this.screen.render();

        // Handle submit (Enter) explicitly via key binding to ensure
        // it is consumed and does not propagate to screen-level handlers
        input.key('enter', () => {
            const val = input.getValue() || defaultVal;
            input.destroy();
            this.screen.render();
            Promise.resolve(callback(val)).catch(err => {
                this.widgets.output.setContent(`\n{red-fg}Save failed: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
                this.widgets.menu.focus();
                this.screen.render();
            });
        });

        // Handle cancel (Escape): invoke callback(null) so field chains
        // abort cleanly instead of silently leaving partially-edited values
        input.key('escape', () => {
            input.destroy();
            this.screen.render();
            Promise.resolve(callback(null)).catch(() => {});
        });
    }

    setupKeyBindings() {
        this.widgets.menu.key(['escape', 'q'], () => this.onBack());
    }

    destroy() {
        this._destroyed = true;
        if (this._resizeHandler) this.screen.removeListener('resize', this._resizeHandler);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default ConfigScreen;
