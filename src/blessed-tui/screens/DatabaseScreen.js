import blessed from 'blessed';
import { TuiSpinner, Validator } from '../../utils/utils.js';

/**
 * Database Management Screen
 */
export class DatabaseScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.dbManager = ctx.dbManager;

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
            content: ' DATABASE MANAGER'
        });

        // Left menu list — items are always plain strings, tags:true only for label
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '35%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Tools ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items: [
                'View Statistics',
                'Optimize (VACUUM)',
                'Check Integrity',
                'Cleanup Preview',
                'Cleanup Old Messages',
                'Rebuild Indexes',
                'Rebuild FTS Search Index',
                'Deduplicate',
                'Table Info',
                'Index Info',
                'WAL Checkpoint',
                '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
                'Back'
            ]
        });

        // Right output box — uses color tags in setContent, needs tags:true
        this.widgets.output = blessed.box({
            parent: this.widgets.main,
            top: 1, left: '35%', width: '65%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Output ',
            style: { border: { fg: 'blue' } },
            scrollable: true,
            mouse: true,
            keys: true,
            content: '\n{gray-fg}Select a maintenance tool to begin{/gray-fg}'
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
        const actions = [
            () => this.viewStats(),
            () => this.runAction('Optimizing database...', () => { 
                const success = this.dbManager.optimize();
                return success ? 'Database optimized successfully' : 'Database optimization failed';
            }),
            () => this.runAction('Checking integrity...', () => {
                const ok = this.dbManager.checkIntegrity();
                return ok ? 'Integrity check passed' : 'Integrity check FAILED';
            }),
            () => this.runAction('Previewing cleanup...', () => {
                const n = this.dbManager.previewCleanup();
                const retentionDays = this.ctx.config?.deletedRetentionDays ?? 30;
                return `${n} deleted message(s) would be removed (older than ${retentionDays} days)`;
            }),
            () => this.confirmAction(`Cleanup deleted messages older than ${this.ctx.config?.deletedRetentionDays ?? 30} days?`, () => {
                const n = this.dbManager.cleanup();
                return `Removed ${n} old messages`;
            }),
            () => this.runAction('Rebuilding indexes...', () => { 
                const success = this.dbManager.rebuildIndexes();
                return success ? 'Indexes rebuilt successfully' : 'Index rebuild failed';
            }),
            () => this.runAction('Rebuilding FTS search index...', () => { 
                const result = this.dbManager.rebuildFts();
                return result.success ? `FTS index rebuilt successfully (${result.count.toLocaleString()} rows)` : 'FTS rebuild failed';
            }),
            () => this.confirmAction('Deduplicate messages? (Keeps first occurrence)', () => {
                const result = this.dbManager.deduplicateMessages();
                return `Deduplication complete: ${result.countBefore} → ${result.countAfter} messages (removed ${result.removed})`;
            }),
            () => this.viewTableInfo(),
            () => this.viewIndexInfo(),
            () => this.runAction('Checkpointing WAL...', () => {
                const ok = this.dbManager.checkpoint();
                return ok ? 'WAL checkpointed successfully' : 'WAL checkpoint failed';
            }),
            () => {}, // separator
            () => this.onBack()
        ];
        if (actions[index]) actions[index]();
    }

    viewStats() {
        try {
            const stats = this.dbManager.getStats();
            let c = '\n{cyan-fg}{bold}Database Summary{/bold}{/cyan-fg}\n';
            c += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
            c += ` Total Messages:  {green-fg}${stats.totalMessages.toLocaleString()}{/green-fg}\n`;
            c += ` Total Channels:  {green-fg}${stats.totalChannels}{/green-fg}\n`;
            c += ` Total Authors:   {green-fg}${stats.totalAuthors.toLocaleString()}{/green-fg}\n`;
            c += ` Deleted:         {red-fg}${stats.deletedMessages}{/red-fg}\n`;
            c += ` Edited:          {blue-fg}${stats.editedMessages}{/blue-fg}\n`;
            c += ` Database Size:   {cyan-fg}${stats.databaseSize.toFixed(2)} MB{/cyan-fg}\n`;
            this.widgets.output.setContent(c);
        } catch (err) {
            this.widgets.output.setContent(`\n{red-fg}Error: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
        }
        this.widgets.menu.focus();
        this.screen.render();
    }

    viewTableInfo() {
        try {
            const info = this.dbManager.getTableInfo();
            let c = '\n{cyan-fg}{bold}Table Structures{/bold}{/cyan-fg}\n';
            c += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
            for (const [name, table] of Object.entries(info)) {
                c += ` {bold}${name}{/bold} {gray-fg}(${table.rowCount} rows){/gray-fg}\n`;
                table.columns.forEach(col => {
                    c += `  {gray-fg}•{/gray-fg} ${col.name} {gray-fg}(${col.type}){/gray-fg}\n`;
                });
                c += '\n';
            }
            this.widgets.output.setContent(c);
        } catch (err) {
            this.widgets.output.setContent(`\n{red-fg}Error: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
        }
        this.widgets.menu.focus();
        this.screen.render();
    }

    viewIndexInfo() {
        try {
            const indexes = this.dbManager.getIndexInfo();
            let c = '\n{cyan-fg}{bold}Database Indexes{/bold}{/cyan-fg}\n';
            c += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
            if (!indexes.length) {
                c += '{gray-fg}No custom indexes found{/gray-fg}';
            } else {
                indexes.forEach(idx => {
                    c += ` {gray-fg}•{/gray-fg} {bold}${idx.name}{/bold} {gray-fg}on ${idx.tbl_name}{/gray-fg}\n`;
                });
            }
            this.widgets.output.setContent(c);
        } catch (err) {
            this.widgets.output.setContent(`\n{red-fg}Error: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
        }
        this.widgets.menu.focus();
        this.screen.render();
    }

    async runAction(msg, fn) {
        const spinner = new TuiSpinner(this.widgets.output, msg);
        spinner.start();
        
        // Use setImmediate to allow the spinner to render before blocking operation
        await new Promise(resolve => setImmediate(resolve));
        
        try {
            const res = fn();
            spinner.stop(true);
            
            const ok = String(res).toLowerCase().includes('fail') || String(res).toLowerCase().includes('failed');
            this.widgets.output.setContent(`\n{${ok ? 'red' : 'green'}-fg}${res}{/${ok ? 'red' : 'green'}-fg}`);
        } catch (err) {
            spinner.stop(false);
            this.widgets.output.setContent(`\n{red-fg}Action failed: ${Validator.sanitizeErrorMessage(err)}{/red-fg}`);
        }
        
        this.widgets.menu.focus();
        this.screen.render();
    }

    confirmAction(msg, fn) {
        // Dialog list — items are plain strings (no tags in items array)
        const dialog = blessed.list({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 7,
            border: { type: 'line' },
            tags: true,
            label: ' Confirm Action ',
            style: {
                border: { fg: 'yellow' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            items: [msg, '  Yes, proceed', '  No, cancel']
        });

        dialog.select(1);
        dialog.focus();
        this.screen.render();

        dialog.on('select', (item, index) => {
            dialog.destroy();
            if (index === 1) {
                this.runAction('Processing...', fn);
            } else {
                this.widgets.output.setContent('\n{gray-fg}Action cancelled{/gray-fg}');
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

    setupKeyBindings() {
        this.widgets.menu.key(['escape', 'q'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default DatabaseScreen;
