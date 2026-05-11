import chalk from 'chalk';
import axios from 'axios';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getFileExtension } from './utils.js';

// ============ MESSAGE STORAGE ============
const MAX_SQLITE_PARAMS = 900;

export class MessageStore {
    constructor(db, config, performance = null) {
        this.db = db;
        this.config = config;
        this.performance = performance;
        this.referenceCache = new Map();
        this.failedReferences = new Set();
        this.insertStmt = null;
        this.updateReactionsStmt = null;
        this.deleteStmt = null;
        this.updateContentStmt = null;

    }

    _getInsertStatement() {
        if (!this.insertStmt && this.db) {
            // INSERT OR REPLACE so the after-insert trigger always fires for FTS.
            // OR REPLACE on a duplicate id = delete old row + insert new row,
            // which is fine because message content doesn't change (edits go through updateMessageContent).
            // We guard against unnecessary re-inserts by deduping in the sync engine first.
            this.insertStmt = this.db.prepare(`
                INSERT OR IGNORE INTO messages
                (id, author_id, author_tag, content, timestamp, channel_id,
                 attachments, embeds, reference_message_id, reference_message_content, reactions, is_bot)
                VALUES (@id, @author_id, @author_tag, @content, @timestamp, @channel_id,
                        @attachments, @embeds, @reference_message_id, @reference_message_content, @reactions, @is_bot)
            `);
        }
        return this.insertStmt;
    }

    _getUpdateReactionsStatement() {
        if (!this.updateReactionsStmt && this.db) {
            this.updateReactionsStmt = this.db.prepare('UPDATE messages SET reactions = ? WHERE id = ?');
        }
        return this.updateReactionsStmt;
    }

    _getDeleteStatement() {
        if (!this.deleteStmt && this.db) {
            this.deleteStmt = this.db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?');
        }
        return this.deleteStmt;
    }

    _getUpdateContentStatement() {
        if (!this.updateContentStmt && this.db) {
            this.updateContentStmt = this.db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?');
        }
        return this.updateContentStmt;
    }

    async fetchReferenceContent(message, channel, withRetry) {
        if (!message.reference?.messageId) return null;
        const refId = message.reference.messageId;

        if (this.failedReferences.has(refId)) return '[Reference message deleted]';
        if (this.referenceCache.has(refId)) return this.referenceCache.get(refId);

        try {
            const ref = await withRetry(() => channel.messages.fetch(refId, { cache: true }));
            const content = ref.content || '[Message content not available]';
            this.referenceCache.set(refId, content);
            return content;
        } catch {
            this.failedReferences.add(refId);
            return '[Reference message error]';
        }
    }

    async buildAttachmentData(message, downloadAttachmentFn) {
        if (!this.config.downloadAttachments || message.attachments.size === 0)
            return [...message.attachments.values()].map(a => ({ url: a.url, filename: a.name, size: a.size }));

        const results = [];
        for (const a of message.attachments.values()) {
            try {
                const localPath = await downloadAttachmentFn(a.url, message.channel.id, a.name, message.id, a.size);
                if (this.performance) this.performance.stats.totalAttachmentsDownloaded++;
                results.push(localPath
                    ? { originalUrl: a.url, localPath, filename: a.name, size: a.size }
                    : { url: a.url, filename: a.name, size: a.size }
                );
            } catch (err) {
                console.error(`Failed to process attachment: ${err.message}`);
                results.push({ url: a.url, filename: a.name, size: a.size });
            }
        }
        return results;
    }

    async storeMessagesBatch(messages, channel, withRetry, downloadAttachmentFn, processEmbedsFn, isShuttingDown) {
        const shouldShutdown = typeof isShuttingDown === 'function' ? isShuttingDown() : isShuttingDown;
        if (!messages.length || !this.db || shouldShutdown) return;

        const insert = this._getInsertStatement();
        if (!insert) return;

        try {
            const rows = [];
            for (const msg of messages) {
                const refContent = await this.fetchReferenceContent(msg, channel, withRetry);
                const attachmentData = await this.buildAttachmentData(msg, downloadAttachmentFn);
                const processedEmbeds = processEmbedsFn
                    ? await processEmbedsFn(msg.embeds, msg.channel.id, msg.id)
                    : msg.embeds;

                rows.push({
                    id: msg.id,
                    author_id: msg.author.id,
                    author_tag: msg.author.tag,
                    content: msg.content,
                    timestamp: msg.createdAt.toISOString(),
                    channel_id: msg.channel.id,
                    attachments: JSON.stringify(attachmentData),
                    embeds: JSON.stringify(processedEmbeds),
                    reference_message_id: msg.reference?.messageId ?? null,
                    reference_message_content: refContent,
                    reactions: JSON.stringify([]),
                    is_bot: msg.author.bot ? 1 : 0
                });
            }

            const txn = this.db.transaction(rows => { for (const row of rows) insert.run(row); });
            txn(rows);
            if (this.performance) {
                this.performance.stats.totalMessagesStored += rows.length;
                this.performance.stats.lastSync = {
                    channelId: channel.id,
                    messageCount: rows.length,
                    timestamp: new Date().toISOString()
                };
            }
        } catch (err) {
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            console.error(chalk.red('❌ DB batch insert error:', err.message));
        }
    }

    updateMessageReactions(messageId, reactions) {
        if (!this.db) return;
        try {
            const stmt = this._getUpdateReactionsStatement();
            stmt.run(
                JSON.stringify([...reactions.entries()]
                    .map(([emoji, r]) => ({ emoji: emoji.toString(), count: r.count }))),
                messageId
            );
        } catch (err) {
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            console.error(chalk.red('❌ DB reaction update error:', err.message));
        }
    }

    markMessageDeleted(messageId) {
        if (!this.db) return;
        try {
            const stmt = this._getDeleteStatement();
            stmt.run(messageId);
        } catch (err) {
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            console.error(chalk.red('❌ DB delete-mark error:', err.message));
        }
    }

    updateMessageContent(messageId, newContent, editedAt) {
        if (!this.db) return;
        try {
            const stmt = this._getUpdateContentStatement();
            stmt.run(newContent, editedAt?.toISOString() ?? null, messageId);
        } catch (err) {
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            console.error(chalk.red('❌ DB edit update error:', err.message));
        }
    }

    checkMemoryUsage() {
        const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
        if (heapUsedMB > 500 && global.gc) global.gc();
        if (this.referenceCache.size > this.config.maxReferenceCache) this.referenceCache.clear();
        if (this.failedReferences.size > this.config.maxFailedReferences) this.failedReferences.clear();
    }

    _getMostRecentStmt = null;
    _getOldestStmt = null;
    _getCountStmt = null;

    checkpoint() {
        try {
            if (this.db) this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
            return true;
        } catch (err) {
            console.error(chalk.red('❌ WAL checkpoint error:', err.message));
            return false;
        }
    }

    getMostRecentMessage(channelId) {
        if (!this.db) return null;
        try {
            if (!this._getMostRecentStmt) {
                this._getMostRecentStmt = this.db.prepare('SELECT id, timestamp FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1');
            }
            return this._getMostRecentStmt.get(channelId);
        } catch (err) {
            console.error(chalk.red('❌ Error fetching most recent message:', err.message));
            return null;
        }
    }

    getOldestMessage(channelId) {
        if (!this.db) return null;
        try {
            if (!this._getOldestStmt) {
                this._getOldestStmt = this.db.prepare('SELECT id, timestamp FROM messages WHERE channel_id = ? ORDER BY id ASC LIMIT 1');
            }
            return this._getOldestStmt.get(channelId);
        } catch (err) {
            console.error(chalk.red('❌ Error fetching oldest message:', err.message));
            return null;
        }
    }

    getMessageCount(channelId) {
        if (!this.db) return 0;
        try {
            if (!this._getCountStmt) {
                this._getCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ?');
            }
            return this._getCountStmt.get(channelId)?.count || 0;
        } catch (err) {
            console.error(chalk.red('❌ Error counting messages:', err.message));
            return 0;
        }
    }

    getExistingMessageIds(channelId, messageIds) {
        if (!this.db || !messageIds.length) return new Set();
        try {
            const existingIds = new Set();
            // Chunk to stay under SQLite's variable limit.
            // Cache one prepared statement per chunk size to avoid re-preparing on every call.
            for (let i = 0; i < messageIds.length; i += MAX_SQLITE_PARAMS) {
                const chunk = messageIds.slice(i, i + MAX_SQLITE_PARAMS);
                const cacheKey = `existingIds_${chunk.length}`;
                if (!this._existingStmtCache) this._existingStmtCache = new Map();
                if (!this._existingStmtCache.has(cacheKey)) {
                    const placeholders = chunk.map(() => '?').join(',');
                    this._existingStmtCache.set(
                        cacheKey,
                        this.db.prepare(`SELECT id FROM messages WHERE channel_id = ? AND id IN (${placeholders})`)
                    );
                }
                const rows = this._existingStmtCache.get(cacheKey).all(channelId, ...chunk);
                rows.forEach(r => existingIds.add(r.id));
            }
            return existingIds;
        } catch (err) {
            console.error(chalk.red('❌ Error checking existing messages:', err.message));
            return new Set();
        }
    }
}

// ============ MEDIA HANDLER ============
export async function downloadAttachment(url, channelId, filename, withRetry, config, messageId = '', size = 0) {
    try {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) {
            console.log(chalk.yellow(`⚠️ Invalid URL for download: ${url}`));
            return null;
        }

        const MAX_FILE_SIZE = 100 * 1024 * 1024;
        if (size > MAX_FILE_SIZE) {
            console.log(chalk.yellow(`⚠️ File too large: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`));
            return null;
        }

        const unsafeExtensions = ['.exe', '.bat', '.cmd', '.ps1', '.sh', '.js', '.vbs'];
        const ext = path.extname(filename).toLowerCase();
        if (unsafeExtensions.some(ext => filename.toLowerCase().endsWith(ext))) {
            console.log(chalk.yellow(`⚠️ Skipping potentially unsafe file: ${filename}`));
            return null;
        }

        if (size > 10 * 1024 * 1024)
            console.log(chalk.blue(`📁 Large file: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`));

        const contentDir = path.join('content', channelId);
        await fs.mkdir(contentDir, { recursive: true });

        let finalFilename = filename;
        if (messageId) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            finalFilename = `${base}_${messageId}${ext}`;
        }

        const filePath = path.join(contentDir, finalFilename);

        try {
            await fs.access(filePath);
            console.log(chalk.blue(`📁 File already exists: ${filename}`));
            return filePath;
        } catch {
            // File doesn't exist, proceed
        }

        const response = await withRetry(() => axios({
            method: 'GET',
            url,
            responseType: 'stream',
            timeout: config.downloadTimeoutSeconds * 1000
        }));

        if (size > 5 * 1024 * 1024)
            console.log(chalk.blue(`📥 Downloading ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)...`));

        const writer = createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            let settled = false;
            let downloadedBytes = 0;

            const cleanup = (err) => {
                if (settled) return;
                settled = true;
                response.data.destroy();
                writer.destroy();
                fs.unlink(filePath).catch(() => {});
                reject(err);
            };

            response.data.on('data', chunk => {
                downloadedBytes += chunk.length;
                if (downloadedBytes > MAX_FILE_SIZE) {
                    cleanup(new Error(`Download exceeded max size: ${filename}`));
                }
            });

            response.data.on('error', (err) => {
                console.log(chalk.yellow(`⚠️ Download stream error for ${filename}: ${err.message}`));
                cleanup(err);
            });

            writer.on('finish', () => {
                if (settled) return;
                settled = true;
                if (size > 5 * 1024 * 1024) console.log(chalk.green(`✅ Downloaded ${filename}`));
                resolve(filePath);
            });

            writer.on('error', (err) => {
                console.log(chalk.yellow(`⚠️ Failed to write file ${filename}: ${err.message}`));
                cleanup(err);
            });
        });
    } catch (err) {
        console.log(chalk.yellow(`⚠️ Failed to download ${filename}: ${err.message}`));
        return null;
    }
}

export async function processEmbeds(embeds, channelId, downloadAttachmentFn, config, messageId = '') {
    if (!config.downloadAttachments || !embeds?.length) return embeds;

    const seenUrls = new Set();
    const results = [];

    for (const embed of embeds) {
        const out = { ...embed };
        for (const [key, prefix] of [['image', 'embed_image'], ['thumbnail', 'embed_thumb'], ['video', 'embed_video']]) {
            const url = embed[key]?.url;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${getFileExtension(url)}`;
            const localPath = await downloadAttachmentFn(url, channelId, filename, messageId);
            if (localPath) out[key] = { ...embed[key], originalUrl: url, localPath };
        }
        results.push(out);
    }

    return results;
}
