import chalk from 'chalk';
import fs from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { getSetting, setSetting } from './setup.js';
import { Spinner, ProgressBar } from './utils.js';

// ============ MESSAGE SEARCH ============
export class MessageSearch {
    constructor(db, performance = null) {
        this.db = db;
        this.performance = performance;
        this.preparedStatements = new Map();
        this._statsStmt = null;
        this._statsChannelStmt = null;
        this._topAuthorsStmt = null;
        this._topAuthorsChannelStmt = null;
    }

    // Query builder with prepared statement caching
    _buildQuery(filters) {
        const conditions = ['deleted = 0'];
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
            // Use FTS5 for keyword searches — much faster than LIKE on large DBs
            if (mergedFilters.query && mergedFilters.query.trim()) {
                return this._ftsSearch(mergedFilters);
            }
            const { sql, params } = this._buildQuery(mergedFilters);
            const stmt = this._getPreparedStatement(sql);
            const results = stmt.all(...params);
            if (this.performance) this.performance.stats.totalSearches++;
            return results;
        } catch (err) {
            // FTS may not exist on older DBs — fall back to LIKE search
            try {
                const { sql, params } = this._buildQuery(mergedFilters);
                const stmt = this._getPreparedStatement(sql);
                return stmt.all(...params);
            } catch {
                return [];
            }
        }
    }

    _ftsSearch(filters) {
        // Escape FTS5 special characters so user input is treated as a literal phrase
        const term = filters.query.trim().replace(/"/g, '""');
        const params = [`"${term}"`];
        const extraConditions = ['m.deleted = 0'];

        if (filters.channelId) {
            extraConditions.push('m.channel_id = ?');
            params.push(filters.channelId);
        }
        if (filters.authorId) {
            extraConditions.push('m.author_id = ?');
            params.push(filters.authorId);
        }
        if (filters.startDate) {
            extraConditions.push('m.timestamp >= ?');
            params.push(filters.startDate);
        }
        if (filters.endDate) {
            extraConditions.push('m.timestamp <= ?');
            params.push(filters.endDate);
        }

        params.push(filters.limit || 100);

        const where = extraConditions.length
            ? `AND ${extraConditions.join(' AND ')}`
            : '';

        // Join via rowid — FTS5 content tables expose rowid which maps to messages.rowid
        const sql = `
            SELECT m.*
            FROM messages_fts
            JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ?
            ${where}
            ORDER BY m.timestamp DESC
            LIMIT ?
        `;

        const results = this.db.prepare(sql).all(...params);
        if (this.performance) this.performance.stats.totalSearches++;
        return results;
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
            if (!this._statsChannelStmt) {
                this._statsChannelStmt = this.db.prepare(sql);
            }
            return this._statsChannelStmt.get(channelId);
        }

        if (!this._statsStmt) {
            this._statsStmt = this.db.prepare(sql);
        }
        return this._statsStmt.get();
    }

    getTopAuthors(limit = 10, channelId = null) {
        let sql = `
            SELECT author_tag, author_id, COUNT(*) as message_count
            FROM messages
            WHERE deleted = 0
        `;

        if (channelId) {
            sql += ` AND channel_id = ?`;
            sql += ` GROUP BY author_id, author_tag
                     ORDER BY message_count DESC
                     LIMIT ?`;
            if (!this._topAuthorsChannelStmt) {
                this._topAuthorsChannelStmt = this.db.prepare(sql);
            }
            return this._topAuthorsChannelStmt.all(channelId, limit);
        }

        sql += ` GROUP BY author_id, author_tag
                 ORDER BY message_count DESC
                 LIMIT ?`;
        if (!this._topAuthorsStmt) {
            this._topAuthorsStmt = this.db.prepare(sql);
        }
        return this._topAuthorsStmt.all(limit);
    }

    getMessagesByDate(startDate, endDate, channelId = null) {
        // Dynamic SQL - can't cache prepared statement due to conditional WHERE clause
        // This is called infrequently so acceptable
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

        const stmt = this.db.prepare(sql);
        const result = stmt.all(...params);
        return result;
    }

    findDuplicates(channelId = null) {
        // Dynamic SQL - can't cache prepared statement due to conditional WHERE clause
        // This is called infrequently so acceptable
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

        const stmt = this.db.prepare(sql);
        const result = stmt.all(...params);

        return result;
    }
}

// ============ MESSAGE EXPORTER ============
export class MessageExporter {
    constructor(db, performance = null) {
        this.db = db;
        this.performance = performance;
    }

    async exportToJSON(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const stmt = this.db.prepare(sql);
            const messages = stmt.all(...this._getFilterParams(filters));

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

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            throw err;
        }
    }

    async exportToCSV(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const stmt = this.db.prepare(sql);
            const messages = stmt.all(...this._getFilterParams(filters));


            const headers = ['ID', 'Author', 'Content', 'Timestamp', 'Channel', 'Attachments', 'Reactions', 'Edited', 'Deleted'];
            const rows = messages.map(m => [
                m.id,
                `"${(m.author_tag || '').replace(/"/g, '""')}"`,
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

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            throw err;
        }
    }

    async exportToHTML(filename, filters = {}) {
        try {
            const sql = this._buildFilteredQuery(filters);
            const stmt = this.db.prepare(sql);
            const messages = stmt.all(...this._getFilterParams(filters));


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
    ${messages.map(m => {
        const attachments = JSON.parse(m.attachments || '[]');
        const reactions = JSON.parse(m.reactions || '[]');
        return `
    <div class="message">
        <div><span class="author">${this._escapeHTML(m.author_tag)}</span> <span class="timestamp">${new Date(m.timestamp).toLocaleString()}</span></div>
        <div class="content">${this._escapeHTML(m.content)}</div>
        <div class="meta">
            ${m.edited_at ? `<span class="edited">Edited: ${new Date(m.edited_at).toLocaleString()}</span>` : ''}
            ${m.deleted ? '<span class="deleted">Deleted</span>' : ''}
            ${attachments.length > 0 ? `<span>📎 ${attachments.length} attachment(s)</span>` : ''}
            ${reactions.length > 0 ? `<span>👍 ${reactions.length} reaction(s)</span>` : ''}
        </div>
    </div>
    `;
    }).join('')}
</body>
</html>
            `;

            const filepath = path.join('exports', filename);
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, html);

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return filepath;
        } catch (err) {
            console.error(chalk.red('❌ Export error:', err.message));
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            throw err;
        }
    }

    async backupDatabase(filename = null) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupName = filename || `backup_${timestamp}.db`;
            const backupPath = path.join('backups', backupName);

            await fs.mkdir('backups', { recursive: true });

            // VACUUM INTO creates a consistent snapshot without long-lived locks
            const stmt = this.db.prepare(`VACUUM INTO ?`);
            stmt.run(backupPath);

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

        const limit = filters.limit || 10_000;
        sql += ` LIMIT ${Math.max(1, Math.min(limit, 100_000))}`;
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
    constructor(db, performance = null) {
        this.db = db;
        this.performance = performance;
        this._statsStmt = null;
        this._attachReactStmt = null;
        this._pageCountStmt = null;
        this._pageSizeStmt = null;
        this._channelStatsStmt = null;
        this._channelStatsAllStmt = null;
        this._integrityStmt = null;
        this._cleanupStmt = null;
        this._tablesStmt = null;
        this._indexesStmt = null;
    }

    loadListeningChannels() {
        try {
            const value = getSetting(this.db, 'listeningChannels', []);
            return new Set(Array.isArray(value) ? value : []);
        } catch {
            return new Set();
        }
    }

    saveListeningChannels(listeningChannels) {
        return setSetting(this.db, 'listeningChannels', [...listeningChannels]);
    }

    loadAutoSync() {
        try {
            return getSetting(this.db, 'autoSync', { enabled: false, intervalMs: 60 * 60 * 1000 });
        } catch {
            return { enabled: false, intervalMs: 60 * 60 * 1000 };
        }
    }

    saveAutoSync(enabled, intervalMs) {
        return setSetting(this.db, 'autoSync', { enabled, intervalMs });
    }

    checkpoint() {
        try {
            this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
            return true;
        } catch (err) {
            console.error(chalk.red('❌ Checkpoint error:', err.message));
            return false;
        }
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
            if (!this._statsStmt) {
                this._statsStmt = this.db.prepare(`
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
                `);
            }
            const counts = this._statsStmt.get();

            stats.totalMessages = counts.total;
            stats.totalChannels = counts.channels;
            stats.totalAuthors = counts.authors;
            stats.deletedMessages = counts.deleted;
            stats.editedMessages = counts.edited;
            stats.botMessages = counts.bots;
            stats.averageMessageLength = Math.round(counts.avg_length || 0);
            stats.oldestMessage = counts.oldest;
            stats.newestMessage = counts.newest;

            if (!this._attachReactStmt) {
                this._attachReactStmt = this.db.prepare(`
                    SELECT
                        SUM(json_array_length(attachments)) as attachments,
                        SUM(json_array_length(reactions)) as reactions
                    FROM messages
                `);
            }
            const attachReact = this._attachReactStmt.get();

            stats.totalAttachments = attachReact.attachments || 0;
            stats.totalReactions = attachReact.reactions || 0;

            if (!this._pageCountStmt) this._pageCountStmt = this.db.prepare('PRAGMA page_count');
            if (!this._pageSizeStmt) this._pageSizeStmt = this.db.prepare('PRAGMA page_size');
            
            const pageCount = this._pageCountStmt.get();
            const pageSize = this._pageSizeStmt.get();
            let walSize = 0;
            try {
                walSize = statSync(this.db.name + '-wal').size;
            } catch {}
            stats.databaseSize = ((pageCount.page_count * pageSize.page_size) + walSize) / (1024 * 1024);

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
            if (!this._channelStatsStmt) {
                this._channelStatsStmt = this.db.prepare(sql);
            }
            return this._channelStatsStmt.get(channelId);
        }

        sql += ` GROUP BY channel_id ORDER BY message_count DESC`;
        if (!this._channelStatsAllStmt) {
            this._channelStatsAllStmt = this.db.prepare(sql);
        }
        return this._channelStatsAllStmt.all();
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
            console.log(chalk.blue('🔍 Checking database integrity...'));
            if (!this._integrityStmt) {
                this._integrityStmt = this.db.prepare('PRAGMA integrity_check');
            }
            const result = this._integrityStmt.get();
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
            if (!this._cleanupStmt) {
                this._cleanupStmt = this.db.prepare('DELETE FROM messages WHERE deleted = 1 AND timestamp < ?');
            }
            const deleteResult = this._cleanupStmt.run(thirtyDaysAgo);

            console.log(chalk.green(`✅ Removed ${deleteResult.changes} old deleted messages`));

            this.optimize();

            return deleteResult.changes;
        } catch (err) {
            console.error(chalk.red('❌ Cleanup error:', err.message));
            return 0;
        }
    }

    getTableInfo() {
        try {
            if (!this._tablesStmt) {
                this._tablesStmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
            }
            const tables = this._tablesStmt.all();
            const info = {};

            for (const table of tables) {
                // Dynamic SQL for table-specific queries - can't cache
                const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM "${table.name}"`);
                const count = countStmt.get();
                
                const columnsStmt = this.db.prepare(`PRAGMA table_info("${table.name}")`);
                const columns = columnsStmt.all();
                
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
            if (!this._indexesStmt) {
                this._indexesStmt = this.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
            }
            return this._indexesStmt.all();
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

    rebuildFts() {
        try {
            console.log(chalk.blue('🔍 Rebuilding FTS index...'));
            this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
            const count = this.db.prepare('SELECT COUNT(*) as n FROM messages_fts').get().n;
            console.log(chalk.green(`✅ FTS index rebuilt (${count.toLocaleString()} rows)`));
            return { success: true, count };
        } catch (err) {
            console.error(chalk.red('❌ FTS rebuild error:', err.message));
            return { success: false, count: 0 };
        }
    }

    deduplicateMessages() {
        try {
            console.log(chalk.blue('🧹 Deduplicating messages...'));

            const countBeforeStmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
            const countBefore = countBeforeStmt.get().count;

            const txn = this.db.transaction(() => {
                this.db.exec(`
                    DELETE FROM messages
                    WHERE rowid NOT IN (
                        SELECT MIN(rowid) FROM messages GROUP BY id
                    )
                `);
            });
            txn();

            const countAfterStmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
            const countAfter = countAfterStmt.get().count;

            const removed = countBefore - countAfter;

            console.log(chalk.green(`✅ Deduplication complete: ${countBefore} → ${countAfter} messages (removed ${removed})`));

            this.optimize();

            return { removed, countBefore, countAfter };
        } catch (err) {
            console.error(chalk.red('❌ Deduplication error:', err.message));
            return { removed: 0, countBefore: 0, countAfter: 0 };
        }
    }
}
