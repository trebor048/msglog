import blessed from 'blessed';
import { Validator } from '../../utils/utils.js';

/**
 * Search Messages Screen
 */
export class SearchScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.searchInstance = ctx.search;

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
            content: ' SEARCH MESSAGES'
        });

        // Left menu list — items are always plain strings, tags:true only for label
        this.widgets.menu = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '30%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Filters ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items: [
                'Keyword',
                'Author',
                'Date Range',
                'Attachments Only',
                'Reactions Only',
                'Edited Only',
                'Text Only',
                'Media Only',
                'Statistics',
                '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
                'Back'
            ]
        });

        // Right results box — uses color tags in setContent, needs tags:true
        this.widgets.results = blessed.box({
            parent: this.widgets.main,
            top: 1, left: '30%', width: '70%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Results ',
            style: { border: { fg: 'blue' } },
            scrollable: true,
            mouse: true,
            keys: true,
            content: '\n{gray-fg}Select a filter on the left to begin{/gray-fg}'
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' UP/DOWN Navigate  ENTER Select  TAB Switch Panel  ? Help  ESC/Q Back'
        });

        this.widgets.menu.focus();

        this.widgets.menu.on('select', (item, index) => this.handleMenuSelect(index));

        // Tab switches focus between menu and results
        this.widgets.main.key(['tab'], () => {
            if (this.widgets.menu.focused) {
                this.widgets.results.focus();
            } else {
                this.widgets.menu.focus();
            }
            this.screen.render();
        });
    }

    handleMenuSelect(index) {
        switch (index) {
            case 0: this.promptAndSearch('Enter keyword:', (q) => this.searchInstance.search({ query: q, limit: 50 })); break;
            case 1: this.promptAndSearch('Enter author name or ID:', (a) => this.searchInstance.search({ authorQuery: a, limit: 50 })); break;
            case 2: this.promptDateRange(); break;
            case 3: this.showResults(this.searchInstance.search({ hasAttachments: true, limit: 50 }), 'Attachments Only'); break;
            case 4: this.showResults(this.searchInstance.search({ hasReactions: true, limit: 50 }), 'Reactions Only'); break;
            case 5: this.showResults(this.searchInstance.search({ isEdited: true, limit: 50 }), 'Edited Only'); break;
            case 6: this.showResults(this.searchInstance.search({ messageType: 'text', limit: 50 }), 'Text Only'); break;
            case 7: this.showResults(this.searchInstance.search({ messageType: 'media', limit: 50 }), 'Media Only'); break;
            case 8: this.showStatistics(); break;
            case 9: break; // separator
            case 10: this.onBack(); break;
        }
    }

    promptAndSearch(label, searchFn) {
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

        this.screen.render();

        input.focus();

        input.key('enter', () => {
            const value = input.getValue();
            input.destroy();
            this.screen.render();
            if (value && value.trim()) {
                const results = searchFn(value.trim());
                this.showResults(results, `"${value.trim()}"`);
                this.widgets.results.focus();
            } else {
                this.widgets.results.setContent('\n{yellow-fg}No search term entered{/yellow-fg}');
                this.widgets.menu.focus();
                this.screen.render();
            }
        });

        input.key('escape', () => {
            input.destroy();
            this.screen.render();
            this.widgets.menu.focus();
            this.screen.render();
        });
    }

    promptDateRange() {
        this.promptInput('Start date (YYYY-MM-DD):', (startDate) => {
            if (!startDate) {
                this.widgets.menu.focus();
                this.screen.render();
                return;
            }

            this.promptInput('End date (YYYY-MM-DD):', (endDate) => {
                if (!endDate) {
                    this.widgets.menu.focus();
                    this.screen.render();
                    return;
                }

                if (!Validator.isValidDate(startDate) || !Validator.isValidDate(endDate)) {
                    this.widgets.results.setContent('\n{red-fg}Invalid date format. Use YYYY-MM-DD{/red-fg}');
                    this.widgets.menu.focus();
                    this.screen.render();
                    return;
                }

                if (!Validator.isValidDateRange(startDate, endDate)) {
                    this.widgets.results.setContent('\n{red-fg}Start date must be before end date{/red-fg}');
                    this.widgets.menu.focus();
                    this.screen.render();
                    return;
                }

                const results = this.searchInstance.search({ startDate, endDate, limit: 50 });
                this.showResults(results, `${startDate} to ${endDate}`);
                this.widgets.results.focus();
            });
        });
    }

    promptInput(label, callback) {
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

        this.screen.render();
        input.focus();

        input.key('enter', () => {
            const value = input.getValue()?.trim();
            input.destroy();
            this.screen.render();
            callback(value || null);
        });

        input.key('escape', () => {
            input.destroy();
            this.screen.render();
            callback(null);
        });
    }

    showResults(results, title) {
        const safeTitle = Validator.sanitizeBlessedTags(String(title || 'Results'));
        if (!results || !results.length) {
            this.widgets.results.setContent(
                `\n{yellow-fg}${safeTitle}{/yellow-fg}\n\n{red-fg}No results found{/red-fg}`
            );
            this.widgets.menu.focus();
            this.screen.render();
            return;
        }

        let content = `\n{cyan-fg}{bold}${safeTitle}{/bold}{/cyan-fg} {gray-fg}(${results.length} results){/gray-fg}\n`;
        content += '{gray-fg}' + '─'.repeat(60) + '{/gray-fg}\n';

        results.slice(0, 50).forEach(msg => {
            const author = Validator.sanitizeBlessedTags(String(msg.author_tag || 'Unknown'));
            const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
            const rawText = String(msg.content || '');
            const text = Validator.sanitizeBlessedTags(rawText.substring(0, 100));
            const suffix = rawText.length > 100 ? '...' : '';
            const channel = msg.channel_id
                ? Validator.sanitizeBlessedTags(` [${msg.channel_id}]`)
                : '';

            content += `\n{green-fg}${author}{/green-fg}${channel} {gray-fg}${time}{/gray-fg}\n`;
            content += `  ${text}${suffix}\n`;
            content += '{gray-fg}' + '─'.repeat(60) + '{/gray-fg}\n';
        });

        this.widgets.results.setContent(content);
        this.widgets.results.setScrollPerc(0);
        this.screen.render();
    }

    showStatistics() {
        try {
            const stats = this.searchInstance.getStats();
            const topAuthors = this.searchInstance.getTopAuthors(5);

            let content = '\n{cyan-fg}{bold}Search Statistics{/bold}{/cyan-fg}\n';
            content += '{gray-fg}' + '─'.repeat(40) + '{/gray-fg}\n\n';
            content += ` Total Messages:   {green-fg}${stats.total.toLocaleString()}{/green-fg}\n`;
            content += ` Unique Authors:   {green-fg}${stats.unique_authors.toLocaleString()}{/green-fg}\n`;
            content += ` Unique Channels:  {green-fg}${stats.unique_channels.toLocaleString()}{/green-fg}\n`;
            content += ` With Attachments: {green-fg}${stats.with_attachments.toLocaleString()}{/green-fg}\n`;
            content += ` With Reactions:   {green-fg}${stats.with_reactions.toLocaleString()}{/green-fg}\n`;

            if (topAuthors && topAuthors.length) {
                content += '\n{cyan-fg}{bold}Top 5 Authors{/bold}{/cyan-fg}\n';
                topAuthors.forEach((a, i) => {
                    content += `  ${i + 1}. {green-fg}${Validator.sanitizeBlessedTags(a.author_tag)}{/green-fg} {gray-fg}(${a.message_count} msgs){/gray-fg}\n`;
                });
            }

            this.widgets.results.setContent(content);
            this.widgets.results.setScrollPerc(0);
            this.widgets.results.focus();
            this.screen.render();
        } catch (err) {
            const safeMsg = Validator.sanitizeErrorMessage(err);
            this.widgets.results.setContent(`\n{red-fg}Stats error: ${safeMsg}{/red-fg}`);
            this.widgets.menu.focus();
            this.screen.render();
        }
    }

    setupKeyBindings() {
        this.widgets.menu.key(['escape', 'q'], () => this.onBack());
        this.widgets.results.key(['escape', 'q'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default SearchScreen;
