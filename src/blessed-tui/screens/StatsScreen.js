import blessed from 'blessed';
import moment from 'moment';
import { Validator } from '../../utils/utils.js';

/**
 * Enhanced Channel Statistics Screen
 */
export class StatsScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};

        this.create();
        this.setupKeyBindings();
        this.loadStats();
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
            content: ' CHANNEL STATISTICS'
        });

        // Table box — uses color tags in setContent, needs tags:true
        this.widgets.table = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Per-Channel Stats ',
            style: { border: { fg: 'cyan' } },
            scrollable: true,
            mouse: true,
            keys: true
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' ESC/Q/ENTER Back  ? Help  UP/DOWN Scroll'
        });

        this.widgets.table.focus();
    }

    loadStats() {
        try {
            // Use dbManager abstraction instead of raw SQL
            const channelIds = this.ctx.dbManager?.getChannelIds
                ? this.ctx.dbManager.getChannelIds()
                : this.ctx.db.prepare('SELECT DISTINCT channel_id FROM messages ORDER BY channel_id').all();

            const rows = Array.isArray(channelIds) && channelIds.length && typeof channelIds[0] === 'object'
                ? channelIds  // raw query result (array of {channel_id})
                : channelIds.map(id => ({ channel_id: id })); // getChannelIds returned string array

            if (!rows.length) {
                this.widgets.table.setContent('\n{yellow-fg}No channel data found in database{/yellow-fg}');
                this.screen.render();
                return;
            }

            const statsStmt = this.ctx.db.prepare(`
                SELECT
                    COUNT(*) AS total,
                    COUNT(CASE WHEN is_bot = 1 THEN 1 END) AS bots,
                    COUNT(CASE WHEN deleted = 1 THEN 1 END) AS deleted,
                    COUNT(CASE WHEN edited_at IS NOT NULL THEN 1 END) AS edited,
                    COUNT(CASE WHEN reference_message_id IS NOT NULL THEN 1 END) AS replies,
                    COUNT(CASE WHEN CASE WHEN json_valid(reactions) THEN json_array_length(reactions) ELSE 0 END > 0 THEN 1 END) AS reactions,
                    COUNT(CASE WHEN CASE WHEN json_valid(attachments) THEN json_array_length(attachments) ELSE 0 END > 0 THEN 1 END) AS attachments
                FROM messages WHERE channel_id = ?
            `);

            const lastStmt = this.ctx.db.prepare(
                'SELECT timestamp FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 1'
            );

            let content = '{cyan-fg}{bold}CHANNEL STATISTICS{/bold}{/cyan-fg}\n';
            content += '{gray-fg}' + '─'.repeat(80) + '{/gray-fg}\n\n';

            rows.forEach(({ channel_id: id }) => {
                const ch = this.ctx.client.channels.cache.get(id);
                const guild = ch?.guild?.name ? ` [${ch.guild.name}]` : '';
                const rawName = ch ? `#${ch.name}${guild}` : `Unknown (${id})`;
                const name = Validator.sanitizeBlessedTags(rawName);
                const listening = this.ctx.listeningChannels.has(id);

                const stat = statsStmt.get(id);
                const last = lastStmt.get(id);
                const lastTime = last?.timestamp ? moment(last.timestamp).fromNow() : 'Never';

                // Sync state cursor info
                let syncInfo = '';
                try {
                    const ss = this.ctx.db.prepare('SELECT * FROM channel_sync_state WHERE channel_id = ?').get(id);
                    if (ss) {
                        const complete = ss.is_complete ? ' {green-fg}[COMPLETE]{/green-fg}' : '';
                        const synced = ss.last_synced_at ? ` synced ${moment(ss.last_synced_at).fromNow()}` : '';
                        syncInfo = `${complete}${synced}`;
                    }
                } catch {}

                content += `{${listening ? 'green' : 'white'}-fg}{bold}${name}{/bold}{/${listening ? 'green' : 'white'}-fg}`;
                content += listening ? '  {green-fg}[LISTENING]{/green-fg}' : '';
                content += syncInfo + '\n';
                content += '{gray-fg}' + '─'.repeat(60) + '{/gray-fg}\n';
                content += `  Total: {yellow-fg}${stat.total}{/yellow-fg}  `;
                content += `Bots: {yellow-fg}${stat.bots}{/yellow-fg}  `;
                content += `Replies: {yellow-fg}${stat.replies}{/yellow-fg}  `;
                content += `Reactions: {yellow-fg}${stat.reactions}{/yellow-fg}\n`;
                content += `  Attachments: {yellow-fg}${stat.attachments}{/yellow-fg}  `;
                content += `Edited: {yellow-fg}${stat.edited}{/yellow-fg}  `;
                content += `Deleted: {red-fg}${stat.deleted}{/red-fg}  `;
                content += `Last msg: {blue-fg}${lastTime}{/blue-fg}\n\n`;
            });

            content += '{gray-fg}' + '─'.repeat(80) + '{/gray-fg}\n';
            content += `{cyan-fg}Total channels: {yellow-fg}${rows.length}{/yellow-fg}{/cyan-fg}`;

            this.widgets.table.setContent(content);
        } catch (err) {
            const safeMsg = Validator.sanitizeErrorMessage(err);
            this.widgets.table.setContent(`\n{red-fg}Error loading stats: ${safeMsg}{/red-fg}`);
        }
        this.screen.render();
    }

    setupKeyBindings() {
        this.widgets.table.key(['escape', 'q', 'enter'], () => this.onBack());
    }

    destroy() {
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default StatsScreen;
