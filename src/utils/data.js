import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

// ============ MESSAGE SEARCH ============
export class MessageSearch {
    constructor(db) {
        this.db = db;
        this.preparedStatements = new Map();
    }

    // Query builder with prepared statement caching
    _buildQuery(filters) {
        const conditions = [];
        const params = [];

        if (filters.query) {
            conditions.push('content LIKE ?');
            params.push(`%${filters.query}%`);
        }

        if (filters.authorId) {
            conditions.push('author_id = ?');
            params.push(filters.authorId);
        }

        if (filters.channelId) {
            conditions.push('channel_id = ?');
            params.push(filters.channelId);
        }

        if (filters.startDate) {
            conditions.push('timestamp >= ?');
            params.push(filters.startDate);
        }

        if (filters.endDate) {
            conditions.push('timestamp <= ?');
            params.push(filters.endDate);
        }

        if (filters.messageType === 'text') {
            conditions.push('json_array_length(attachments) = 0');
        } else if (filters.messageType === 'media') {
            conditions.push('json_array_length(attachments) > 0');
        }

        if (filters.hasAttachments === true) {
            conditions.push('json_array_length(attachments) > 0');
        } else if (filters.hasAttachments === false) {
            conditions.push('json_array_length(attachments) = 0');
        }

        if (filters.hasReactions === true) {
            conditions.push('json_array_length(reactions) > 0');
        } else if (filters.hasReactions === false) {
            conditions.push('json_array_length(reactions) = 0');
        }

        if (filters.isEdited === true) {
            conditions.push('edited_at IS NOT NULL');
        } else if (filters.isEdited === false) {
            conditions.push('edited_at IS NULL');
        }

        if (filters.isBot === false) {
            conditions.push('is_bot = 0');
        } else if (filters.isBot === true) {
            conditions.push('is_bot = 1');
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT * FROM messages ${whereClause} ORDER BY timestamp DESC LIMIT ?`;
        params.push(filters.limit || 100);

        return { sql, params };
    }

    _getPreparedStatement(sql) {
        if (!this.preparedStatements.has(sql)) {
            this.preparedStatements.set(sql, this.db.prepare(sql));
        }
        return this.preparedStatements.get(sql);
    }

    search(filters = {}) {
        const defaults = {
            query: '',
            authorId: null,
            channelId: null,
            startDate: null,
            endDate: null,
            hasAttachments: null,
            hasReactions: null,
            isEdited: null,
            isBot: null,
            messageType: 'both',
            limit: 100
        };

        const mergedFilters = { ...defaults, ...filters };

        try {
            const { sql, params } = this._buildQuery(mergedFilters);
            const stmt = this._getPreparedStatement(sql);
            return stmt.all(...params);
        } catch (err) {
            console.error(chalk.red('❌ Search error:', err.message));
            return [];
        }
    }

    getStats(channelId = null) {
        let sql = 'SELECT ';
        sql += 'COUNT(*) as total, ';
        sql += 'COUNT(CASE WHEN is_bot = 1 THEN 1 END) as bot_messages, ';
        sql += 'COUNT(CASE WHEN deleted = 1 THEN 1 END) as deleted, ';
        sql += 'COUNT(CASE WHEN edited_at IS NOT NULL THEN 1 END) as edited, ';
        sql += 'COUNT(CASE WHEN json_array_length(reactions) > 0 THEN 1 END) as with_reactions, ';
        sql += 'COUNT(CASE WHEN json_array_length(attachments) > 0 THEN 1 END) as with_attachments, ';
        sql += 'COUNT(DISTINCT author_id) as unique_authors, ';
        sql += 'COUNT(DISTINCT channel_id) as unique_channels, ';
        sql += 'MIN(timestamp) as oldest_message, ';
        sql += 'MAX(timestamp) as newest_message ';
        sql += 'FROM messages';

        if (channelId) {
            sql += ' WHERE channel_id = ?';
            return this.db.prepare(sql).get(channelId);
        }

        return this.db.prepare(sql).get();
    }

    getTopAuthors(limit = 10, channelId = null) {
        let sql = `
            SELECT author_tag, author_id, COUNT(*) as message_count
            FROM messages
            WHERE deleted = 0
        `;

        if (channelId) {
            sql += ` AND channel_id = ?`;
        }

        sql += ` GROUP BY author_id
                 ORDER BY message_count DESC
                 LIMIT ?`;

        const params = channelId ? [channelId, limit] : [limit];
        return this.db.prepare(sql).all(...params);
    }

    getMessagesByDate(startDate, endDate, channelId = null) {
        let sql = `
            SELECT 
                DATE(timestamp) as date,
                COUNT(*) as count,
                COUNT(DISTINCT author_id) as unique_authors
            FROM messages
            WHERE timestamp >= ? AND timestamp <= ?
        `;

        const params = [startDate, endDate];

        if (channelId) {
            sql += ` AND channel_id = ?`;
            params.push(channelId);
        }

        sql += ` GROUP BY DATE(timestamp)
                 ORDER BY date ASC`;

        return this.db.prepare(sql).all(...params);
    }

    findDuplicates(channelId = null) {
        let sql = `
            SELECT 
                m1.id, m1.author_tag, m1.content, m1.timestamp,
                COUNT(*) as duplicate_count
            FROM messages m1
            WHERE m1.deleted = 0
        `;

        const params = [];

        if (channelId) {
            sql += ` AND m1.channel_id = ?`;
            params.push(channelId);
        }

        sql += `
            GROUP BY m1.content, m1.author_id
            HAVING COUNT(*) > 1
            ORDER BY duplicate_count DESC
        `;

        return this.db.prepare(sql).all(...params);
    }
}

// ============ MESSAGE EXPORTER ============
export class MessageExporter {
    constructor(db) {
        this.db = db;
    }

    async exportToJSON(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const messages = this.db.prepare(sql).all(...this._getFilterParams(filters));

            const data = {
                exportDate: new Date().toISOString(),
                messageCount: messages.length,
                filters,
                messages: messages.map(m => ({
                    ...m,
                    attachments: JSON.parse(m.attachments || '[]'),
                    embeds: JSON.parse(m.embeds || '[]'),
                    reactions: JSON.parse(m.reactions || '[]')
                }))
            };

            const filepath = path.join('exports', filename);
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, JSON.stringify(data, null, 2));

            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            throw err;
        }
    }

    async exportToCSV(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const messages = this.db.prepare(sql).all(...this._getFilterParams(filters));

            const headers = ['ID', 'Author', 'Content', 'Timestamp', 'Channel', 'Attachments', 'Reactions', 'Edited', 'Deleted'];
            const rows = messages.map(m => [
                m.id,
                m.author_tag,
                `"${(m.content || '').replace(/"/g, '""')}"`,
                m.timestamp,
                m.channel_id,
                JSON.parse(m.attachments || '[]').length,
                JSON.parse(m.reactions || '[]').length,
                m.edited_at ? 'Yes' : 'No',
                m.deleted ? 'Yes' : 'No'
            ]);

            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

            const filepath = path.join('exports', filename);
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, csv);

            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            throw err;
        }
    }

    async exportToHTML(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const messages = this.db.prepare(sql).all(...this._getFilterParams(filters));

            const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Discord Messages Export</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .header { background: #2c3e50; color: white; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .message { background: white; padding: 15px; margin: 10px 0; border-left: 4px solid #7289da; border-radius: 3px; }
        .author { font-weight: bold; color: #7289da; }
        .timestamp { color: #999; font-size: 0.9em; }
        .content { margin: 10px 0; white-space: pre-wrap; word-wrap: break-word; }
        .meta { color: #666; font-size: 0.9em; margin-top: 10px; }
        .edited { background: #fff3cd; padding: 2px 6px; border-radius: 3px; }
        .deleted { background: #f8d7da; padding: 2px 6px; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Discord Messages Export</h1>
        <p>Exported: ${new Date().toLocaleString()}</p>
        <p>Total Messages: ${messages.length}</p>
    </div>
    ${messages.map(m => `
    <div class="message">
        <div><span class="author">${m.author_tag}</span> <span class="timestamp">${new Date(m.timestamp).toLocaleString()}</span></div>
        <div class="content">${this._escapeHTML(m.content)}</div>
        <div class="meta">
            ${m.edited_at ? `<span class="edited">Edited: ${new Date(m.edited_at).toLocaleString()}</span>` : ''}
            ${m.deleted ? '<span class="deleted">Deleted</span>' : ''}
            ${JSON.parse(m.attachments || '[]').length > 0 ? `<span>📎 ${JSON.parse(m.attachments).length} attachment(s)</span>` : ''}
            ${JSON.parse(m.reactions || '[]').length > 0 ? `<span>👍 ${JSON.parse(m.reactions).length} reaction(s)</span>` : ''}
        </div>
    </div>
    `).join('')}
</body>
</html>
            `;

            const filepath = path.join('exports', filename);
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, html);

            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            throw err;
        }
    }

    async backupDatabase(filename = null) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupName = filename || `backup_${timestamp}.db`;
            const backupPath = path.join('backups', backupName);

            await fs.mkdir('backups', { recursive: true });

            const dbPath = this.db.name;
            const data = await fs.readFile(dbPath);
            await fs.writeFile(backupPath, data);

            console.log(chalk.green(`✅ Database backed up to ${backupPath}`));
            return backupPath;
        } catch (err) {
            console.error(chalk.red('❌ Backup error:', err.message));
            throw err;
        }
    }

    _buildFilteredQuery(filters) {
        let sql = 'SELECT * FROM messages WHERE 1=1';

        if (filters.query) sql += ' AND content LIKE ?';
        if (filters.authorId) sql += ' AND author_id = ?';
        if (filters.channelId) sql += ' AND channel_id = ?';
        if (filters.startDate) sql += ' AND timestamp >= ?';
        if (filters.endDate) sql += ' AND timestamp <= ?';
        if (filters.hasAttachments === true) sql += ' AND json_array_length(attachments) > 0';
        if (filters.hasAttachments === false) sql += ' AND json_array_length(attachments) = 0';
        if (filters.isBot === false) sql += ' AND is_bot = 0';

        sql += ' ORDER BY timestamp DESC';
        return sql;
    }

    _getFilterParams(filters) {
        const params = [];
        if (filters.query) params.push(`%${filters.query}%`);
        if (filters.authorId) params.push(filters.authorId);
        if (filters.channelId) params.push(filters.channelId);
        if (filters.startDate) params.push(filters.startDate);
        if (filters.endDate) params.push(filters.endDate);
        return params;
    }

    _escapeHTML(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return (text || '').replace(/[&<>"']/g, m => map[m]);
    }
}

// ============ DATABASE MANAGER ============
export class DatabaseManager {
    constructor(db) {
        this.db = db;
    }

    getStats() {
        const stats = {
            totalMessages: 0,
            totalChannels: 0,
            totalAuthors: 0,
            totalAttachments: 0,
            totalReactions: 0,
            deletedMessages: 0,
            editedMessages: 0,
            botMessages: 0,
            oldestMessage: null,
            newestMessage: null,
            averageMessageLength: 0,
            databaseSize: 0
        };

        try {
            const counts = this.db.prepare(`
                SELECT
                    COUNT(*) as total,
                    COUNT(DISTINCT channel_id) as channels,
                    COUNT(DISTINCT author_id) as authors,
                    COUNT(CASE WHEN deleted = 1 THEN 1 END) as deleted,
                    COUNT(CASE WHEN edited_at IS NOT NULL THEN 1 END) as edited,
                    COUNT(CASE WHEN is_bot = 1 THEN 1 END) as bots,
                    AVG(LENGTH(content)) as avg_length,
                    MIN(timestamp) as oldest,
                    MAX(timestamp) as newest
                FROM messages
            `).get();

            stats.totalMessages = counts.total;
            stats.totalChannels = counts.channels;
            stats.totalAuthors = counts.authors;
            stats.deletedMessages = counts.deleted;
            stats.editedMessages = counts.edited;
            stats.botMessages = counts.bots;
            stats.averageMessageLength = Math.round(counts.avg_length || 0);
            stats.oldestMessage = counts.oldest;
            stats.newestMessage = counts.newest;

            const attachReact = this.db.prepare(`
                SELECT
                    SUM(json_array_length(attachments)) as attachments,
                    SUM(json_array_length(reactions)) as reactions
                FROM messages
            `).get();

            stats.totalAttachments = attachReact.attachments || 0;
            stats.totalReactions = attachReact.reactions || 0;

            const pageCount = this.db.prepare('PRAGMA page_count').get();
            const pageSize = this.db.prepare('PRAGMA page_size').get();
            stats.databaseSize = (pageCount.page_count * pageSize.page_size) / (1024 * 1024);

            return stats;
        } catch (err) {
            console.error(chalk.red('❌ Stats error:', err.message));
            return stats;
        }
    }

    getChannelStats(channelId = null) {
        let sql = `
            SELECT
                channel_id,
                COUNT(*) as message_count,
                COUNT(DISTINCT author_id) as unique_authors,
                COUNT(CASE WHEN is_bot = 1 THEN 1 END) as bot_messages,
                COUNT(CASE WHEN deleted = 1 THEN 1 END) as deleted_messages,
                COUNT(CASE WHEN edited_at IS NOT NULL THEN 1 END) as edited_messages,
                MIN(timestamp) as oldest_message,
                MAX(timestamp) as newest_message
            FROM messages
        `;

        if (channelId) {
            sql += ` WHERE channel_id = ?`;
            return this.db.prepare(sql).get(channelId);
        }

        sql += ` GROUP BY channel_id ORDER BY message_count DESC`;
        return this.db.prepare(sql).all();
    }

    optimize() {
        try {
            console.log(chalk.blue('🔧 Optimizing database...'));
            this.db.exec('VACUUM');
            this.db.exec('ANALYZE');
            console.log(chalk.green('✅ Database optimized'));
            return true;
        } catch (err) {
            console.error(chalk.red('❌ Optimization error:', err.message));
            return false;
        }
    }

    checkIntegrity() {
        try {
            const result = this.db.prepare('PRAGMA integrity_check').get();
            if (result.integrity_check === 'ok') {
                console.log(chalk.green('✅ Database integrity check passed'));
                return true;
            } else {
                console.error(chalk.red('❌ Database integrity issue:', result.integrity_check));
                return false;
            }
        } catch (err) {
            console.error(chalk.red('❌ Integrity check error:', err.message));
            return false;
        }
    }

    cleanup() {
        try {
            console.log(chalk.blue('🧹 Cleaning up database...'));

            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            const deleteResult = this.db.prepare(
                'DELETE FROM messages WHERE deleted = 1 AND timestamp < ?'
            ).run(thirtyDaysAgo);

            console.log(chalk.green(`✅ Removed ${deleteResult.changes} old deleted messages`));

            this.optimize();

            return deleteResult.changes;
        } catch (err) {
            console.error(chalk.red('❌ Cleanup error:', err.message));
            return 0;
        }
    }

    getFileSize() {
        try {
            const pageCount = this.db.prepare('PRAGMA page_count').get();
            const pageSize = this.db.prepare('PRAGMA page_size').get();
            const bytes = pageCount.page_count * pageSize.page_size;
            return {
                bytes,
                kb: (bytes / 1024).toFixed(2),
                mb: (bytes / 1024 / 1024).toFixed(2),
                gb: (bytes / 1024 / 1024 / 1024).toFixed(3)
            };
        } catch (err) {
            console.error(chalk.red('❌ File size error:', err.message));
            return null;
        }
    }

    getTableInfo() {
        try {
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
            const info = {};

            for (const table of tables) {
                const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
                const columns = this.db.prepare(`PRAGMA table_info(${table.name})`).all();
                info[table.name] = {
                    rowCount: count.count,
                    columns: columns.map(c => ({ name: c.name, type: c.type }))
                };
            }

            return info;
        } catch (err) {
            console.error(chalk.red('❌ Table info error:', err.message));
            return {};
        }
    }

    getIndexInfo() {
        try {
            const indexes = this.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'").all();
            return indexes;
        } catch (err) {
            console.error(chalk.red('❌ Index info error:', err.message));
            return [];
        }
    }

    rebuildIndexes() {
        try {
            console.log(chalk.blue('🔨 Rebuilding indexes...'));
            this.db.exec('REINDEX');
            console.log(chalk.green('✅ Indexes rebuilt'));
            return true;
        } catch (err) {
            console.error(chalk.red('❌ Rebuild error:', err.message));
            return false;
        }
    }
}
