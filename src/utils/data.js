import chalk from 'chalk';
import fs from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { getSetting, setSetting } from './setup.js';
import { Validator } from './utils.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ATTACHMENTS_COUNT_EXPR = `CASE WHEN json_valid(attachments) THEN json_array_length(attachments) ELSE 0 END`;
const REACTIONS_COUNT_EXPR = `CASE WHEN json_valid(reactions) THEN json_array_length(reactions) ELSE 0 END`;

function normalizeStartDateInput(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!DATE_ONLY_PATTERN.test(trimmed)) return value;
    // Parse as local midnight so users in any timezone get the day they intended
    const dt = new Date(`${trimmed}T00:00:00`);
    return Number.isNaN(dt.getTime()) ? value : dt.toISOString();
}

function normalizeEndDateInput(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!DATE_ONLY_PATTERN.test(trimmed)) return value;
    // Parse as local end-of-day so the full day is included
    const dt = new Date(`${trimmed}T23:59:59.999`);
    return Number.isNaN(dt.getTime()) ? value : dt.toISOString();
}

export function escapeCsvCell(value) {
    const text = String(value ?? '');
    const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${formulaSafe.replace(/"/g, '""')}"`;
}

// ============ MESSAGE SEARCH ============
export class MessageSearch {
    constructor(db, performance = null) {
        this.db = db;
        this.performance = performance;
        this.ftsEnabled = getSetting(db, 'ftsEnabled', true) !== false;
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
        const normalizedStartDate = normalizeStartDateInput(filters.startDate);
        const normalizedEndDate = normalizeEndDateInput(filters.endDate);

        if (filters.query) {
            conditions.push('content LIKE ?');
            params.push(`%${filters.query}%`);
        }

        if (filters.authorId) {
            conditions.push('author_id = ?');
            params.push(filters.authorId);
        }
        if (filters.authorQuery) {
            conditions.push('(author_id = ? OR author_tag LIKE ?)');
            params.push(filters.authorQuery, `%${filters.authorQuery}%`);
        }

        if (filters.channelId) {
            conditions.push('channel_id = ?');
            params.push(filters.channelId);
        }

        if (normalizedStartDate) {
            conditions.push('timestamp >= ?');
            params.push(normalizedStartDate);
        }

        if (normalizedEndDate) {
            conditions.push('timestamp <= ?');
            params.push(normalizedEndDate);
        }

        if (filters.messageType === 'text') {
            conditions.push(`${ATTACHMENTS_COUNT_EXPR} = 0`);
        } else if (filters.messageType === 'media') {
            conditions.push(`${ATTACHMENTS_COUNT_EXPR} > 0`);
        }

        if (filters.hasAttachments === true) {
            conditions.push(`${ATTACHMENTS_COUNT_EXPR} > 0`);
        } else if (filters.hasAttachments === false) {
            conditions.push(`${ATTACHMENTS_COUNT_EXPR} = 0`);
        }

        if (filters.hasReactions === true) {
            conditions.push(`${REACTIONS_COUNT_EXPR} > 0`);
        } else if (filters.hasReactions === false) {
            conditions.push(`${REACTIONS_COUNT_EXPR} = 0`);
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
            authorQuery: null,
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
            if (this.ftsEnabled && mergedFilters.query && mergedFilters.query.trim()) {
                return this._ftsSearch(mergedFilters);
            }
            const { sql, params } = this._buildQuery(mergedFilters);
            const stmt = this._getPreparedStatement(sql);
            const results = stmt.all(...params);
            if (this.performance) this.performance.stats.totalSearches++;
            return results;
        } catch (err) {
            if (mergedFilters.query && this.ftsEnabled) {
                this.ftsEnabled = false;
            }
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
        const normalizedStartDate = normalizeStartDateInput(filters.startDate);
        const normalizedEndDate = normalizeEndDateInput(filters.endDate);

        if (filters.channelId) {
            extraConditions.push('m.channel_id = ?');
            params.push(filters.channelId);
        }
        if (filters.authorId) {
            extraConditions.push('m.author_id = ?');
            params.push(filters.authorId);
        }
        if (filters.authorQuery) {
            extraConditions.push('(m.author_id = ? OR m.author_tag LIKE ?)');
            params.push(filters.authorQuery, `%${filters.authorQuery}%`);
        }
        if (normalizedStartDate) {
            extraConditions.push('m.timestamp >= ?');
            params.push(normalizedStartDate);
        }
        if (normalizedEndDate) {
            extraConditions.push('m.timestamp <= ?');
            params.push(normalizedEndDate);
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
        const baseSql = 'SELECT '
            + 'COUNT(*) as total, '
            + 'COUNT(CASE WHEN is_bot = 1 THEN 1 END) as bot_messages, '
            + 'COUNT(CASE WHEN deleted = 1 THEN 1 END) as deleted, '
            + 'COUNT(CASE WHEN edited_at IS NOT NULL THEN 1 END) as edited, '
            + `COUNT(CASE WHEN ${REACTIONS_COUNT_EXPR} > 0 THEN 1 END) as with_reactions, `
            + `COUNT(CASE WHEN ${ATTACHMENTS_COUNT_EXPR} > 0 THEN 1 END) as with_attachments, `
            + 'COUNT(DISTINCT author_id) as unique_authors, '
            + 'COUNT(DISTINCT channel_id) as unique_channels, '
            + 'MIN(timestamp) as oldest_message, '
            + 'MAX(timestamp) as newest_message '
            + 'FROM messages';

        if (channelId) {
            if (!this._statsChannelStmt) {
                this._statsChannelStmt = this.db.prepare(baseSql + ' WHERE channel_id = ?');
            }
            return this._statsChannelStmt.get(channelId);
        }

        if (!this._statsStmt) {
            this._statsStmt = this.db.prepare(baseSql);
        }
        return this._statsStmt.get();
    }

    getTopAuthors(limit = 10, channelId = null) {
        if (channelId) {
            if (!this._topAuthorsChannelStmt) {
                this._topAuthorsChannelStmt = this.db.prepare(`
                    SELECT author_tag, author_id, COUNT(*) as message_count
                    FROM messages
                    WHERE deleted = 0 AND channel_id = ?
                    GROUP BY author_id, author_tag
                    ORDER BY message_count DESC
                    LIMIT ?
                `);
            }
            return this._topAuthorsChannelStmt.all(channelId, limit);
        }

        if (!this._topAuthorsStmt) {
            this._topAuthorsStmt = this.db.prepare(`
                SELECT author_tag, author_id, COUNT(*) as message_count
                FROM messages
                WHERE deleted = 0
                GROUP BY author_id, author_tag
                ORDER BY message_count DESC
                LIMIT ?
            `);
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
                    attachments: this._safeJsonArray(m.attachments),
                    embeds: this._safeJsonArray(m.embeds),
                    reactions: this._safeJsonArray(m.reactions)
                }))
            };

            const filepath = this._resolveOutputPath('exports', filename, '.json');
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, JSON.stringify(data, null, 2));

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return { filepath, count: messages.length };
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
                escapeCsvCell(m.id),
                escapeCsvCell(m.author_tag),
                escapeCsvCell(m.content),
                escapeCsvCell(m.timestamp),
                escapeCsvCell(m.channel_id),
                escapeCsvCell(this._safeJsonArray(m.attachments).length),
                escapeCsvCell(this._safeJsonArray(m.reactions).length),
                escapeCsvCell(m.edited_at ? 'Yes' : 'No'),
                escapeCsvCell(m.deleted ? 'Yes' : 'No')
            ]);

            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

            const filepath = this._resolveOutputPath('exports', filename, '.csv');
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, csv);

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return { filepath, count: messages.length };
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
        const attachments = this._safeJsonArray(m.attachments);
        const reactions = this._safeJsonArray(m.reactions);
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

            const filepath = this._resolveOutputPath('exports', filename, '.html');
            await fs.mkdir('exports', { recursive: true });
            await fs.writeFile(filepath, html);

            if (this.performance) this.performance.stats.totalExports++;
            console.log(chalk.green(`✅ Exported ${messages.length} messages to ${filepath}`));
            return { filepath, count: messages.length };
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
            const backupName = filename || `backup_${timestamp}`;
            const backupPath = this._resolveOutputPath('backups', backupName, '.db');

            await fs.mkdir('backups', { recursive: true });

            // VACUUM INTO creates a consistent snapshot without long-lived locks
            const stmt = this.db.prepare(`VACUUM INTO ?`);
            stmt.run(backupPath);
            const info = await fs.stat(backupPath);
            if (!info.isFile() || info.size === 0) {
                throw new Error('Backup file verification failed');
            }

            console.log(chalk.green(`✅ Database backed up to ${backupPath}`));
            return { filepath: backupPath, count: 0 };
        } catch (err) {
            console.error(chalk.red('❌ Backup error:', err.message));
            throw err;
        }
    }

    _buildFilteredQuery(filters) {
        let sql = 'SELECT * FROM messages WHERE deleted = 0';

        if (filters.query) sql += ' AND content LIKE ?';
        if (filters.authorId) sql += ' AND author_id = ?';
        if (filters.authorQuery) sql += ' AND (author_id = ? OR author_tag LIKE ?)';
        if (filters.channelId) sql += ' AND channel_id = ?';
        if (filters.startDate) sql += ' AND timestamp >= ?';
        if (filters.endDate) sql += ' AND timestamp <= ?';
        if (filters.hasAttachments === true) sql += ` AND ${ATTACHMENTS_COUNT_EXPR} > 0`;
        if (filters.hasAttachments === false) sql += ` AND ${ATTACHMENTS_COUNT_EXPR} = 0`;
        if (filters.isBot === false) sql += ' AND is_bot = 0';

        sql += ' ORDER BY timestamp DESC';

        const limit = filters.limit || 10_000;
        sql += ` LIMIT ${Math.max(1, Math.min(limit, 100_000))}`;
        return sql;
    }

    _getFilterParams(filters) {
        const params = [];
        const normalizedStartDate = normalizeStartDateInput(filters.startDate);
        const normalizedEndDate = normalizeEndDateInput(filters.endDate);
        if (filters.query) params.push(`%${filters.query}%`);
        if (filters.authorId) params.push(filters.authorId);
        if (filters.authorQuery) params.push(filters.authorQuery, `%${filters.authorQuery}%`);
        if (filters.channelId) params.push(filters.channelId);
        if (normalizedStartDate && filters.startDate) params.push(normalizedStartDate);
        if (normalizedEndDate && filters.endDate) params.push(normalizedEndDate);
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

    _safeJsonArray(value) {
        try {
            const parsed = JSON.parse(value || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    _resolveOutputPath(baseDir, filename, expectedExt = '') {
        const raw = path.basename(String(filename || 'export'));
        const ext = expectedExt ? expectedExt.toLowerCase() : '';
        const parsed = path.parse(raw);
        const baseName = parsed.name || 'export';
        const normalizedName = ext
            ? `${baseName}${ext}`
            : raw;
        const safe = Validator.sanitizeFilename(normalizedName);
        return Validator.validatePathConfinement(safe, baseDir);
    }
}

// ============ DATABASE MANAGER ============
export class DatabaseManager {
    constructor(db, performance = null, config = {}) {
        this.db = db;
        this.performance = performance;
        this.config = config;
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
            const normalized = Array.isArray(value)
                ? value
                    .filter(v => typeof v === 'string')
                    .map(v => v.trim())
                    .filter(v => /^\d+$/.test(v))
                : [];
            return new Set(normalized);
        } catch {
            return new Set();
        }
    }

    saveListeningChannels(listeningChannels) {
        const normalized = [...listeningChannels]
            .filter(v => typeof v === 'string')
            .map(v => v.trim())
            .filter(v => /^\d+$/.test(v));
        return setSetting(this.db, 'listeningChannels', normalized);
    }

    loadAutoSync() {
        try {
            const raw = getSetting(this.db, 'autoSync', { enabled: false, intervalMs: 60 * 60 * 1000 });
            const enabled = Boolean(raw?.enabled);
            const intervalMsRaw = Number(raw?.intervalMs);
            const intervalMs = Number.isFinite(intervalMsRaw)
                ? Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, intervalMsRaw))
                : 60 * 60 * 1000;
            return { enabled, intervalMs };
        } catch {
            return { enabled: false, intervalMs: 60 * 60 * 1000 };
        }
    }

    saveAutoSync(enabled, intervalMs) {
        const normalized = {
            enabled: Boolean(enabled),
            intervalMs: Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(intervalMs) || 60 * 60 * 1000))
        };
        return setSetting(this.db, 'autoSync', normalized);
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
                        SUM(${ATTACHMENTS_COUNT_EXPR}) as attachments,
                        SUM(${REACTIONS_COUNT_EXPR}) as reactions
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
        const baseSql = `
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
            const sql = baseSql + ` WHERE channel_id = ?`;
            if (!this._channelStatsStmt) {
                this._channelStatsStmt = this.db.prepare(sql);
            }
            return this._channelStatsStmt.get(channelId);
        }

        const sql = baseSql + ` GROUP BY channel_id ORDER BY message_count DESC`;
        if (!this._channelStatsAllStmt) {
            this._channelStatsAllStmt = this.db.prepare(sql);
        }
        return this._channelStatsAllStmt.all();
    }

    getChannelIds() {
        try {
            const rows = this.db.prepare('SELECT DISTINCT channel_id FROM messages ORDER BY channel_id').all();
            return rows.map(r => r.channel_id).filter(Boolean);
        } catch (err) {
            console.error(chalk.red('❌ Channel list error:', err.message));
            return [];
        }
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

            const retentionDays = Math.max(1, this.config.deletedRetentionDays ?? 30);
            const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
            if (!this._cleanupStmt) {
                this._cleanupStmt = this.db.prepare('DELETE FROM messages WHERE deleted = 1 AND timestamp < ?');
            }
            const deleteResult = this._cleanupStmt.run(cutoff);

            console.log(chalk.green(`✅ Removed ${deleteResult.changes} old deleted messages`));

            this.optimize();

            return deleteResult.changes;
        } catch (err) {
            console.error(chalk.red('❌ Cleanup error:', err.message));
            return 0;
        }
    }

    previewCleanup() {
        try {
            const retentionDays = Math.max(1, this.config.deletedRetentionDays ?? 30);
            const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE deleted = 1 AND timestamp < ?');
            return stmt.get(cutoff)?.count ?? 0;
        } catch (err) {
            console.error(chalk.red('❌ Cleanup preview error:', err.message));
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
        if (getSetting(this.db, 'ftsEnabled', true) === false) {
            console.log(chalk.yellow('⚠️ FTS is disabled in this SQLite build'));
            return { success: false, count: 0 };
        }
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
