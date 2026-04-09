import chalk from 'chalk';
import axios from 'axios';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getFileExtension } from './utils.js';

// ============ MESSAGE STORAGE ============
export class MessageStore {
    constructor(db, config) {
        this.db = db;
        this.config = config;
        this.referenceCache = new Map();
        this.failedReferences = new Set();
        this.insertStmt = null;
        this.updateReactionsStmt = null;
        this.deleteStmt = null;
        this.updateContentStmt = null;
        this.batchSize = 100;
        this.metrics = {
            messagesStored: 0,
            attachmentsProcessed: 0,
            errors: 0
        };
    }

    _getInsertStatement() {
        if (!this.insertStmt && this.db) {
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
                this.metrics.attachmentsProcessed++;
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
        if (!messages.length || !this.db || isShuttingDown) return;

        const insert = this._getInsertStatement();
        if (!insert) return;

        try {
            const rows = await Promise.all(messages.map(async msg => {
                const [refContent, attachmentData, processedEmbeds] = await Promise.all([
                    this.fetchReferenceContent(msg, channel, withRetry),
                    this.buildAttachmentData(msg, downloadAttachmentFn),
                    processEmbedsFn ? processEmbedsFn(msg.embeds, msg.channel.id, msg.id) : msg.embeds
                ]);
                return {
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
                };
            }));

            const txn = this.db.transaction(rows => { for (const row of rows) insert.run(row); });
            txn(rows);
            this.metrics.messagesStored += rows.length;
        } catch (err) {
            this.metrics.errors++;
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
            this.metrics.errors++;
            console.error(chalk.red('❌ DB reaction update error:', err.message));
        }
    }

    markMessageDeleted(messageId) {
        if (!this.db) return;
        try {
            const stmt = this._getDeleteStatement();
            stmt.run(messageId);
        } catch (err) {
            this.metrics.errors++;
            console.error(chalk.red('❌ DB delete-mark error:', err.message));
        }
    }

    updateMessageContent(messageId, newContent, editedAt) {
        if (!this.db) return;
        try {
            const stmt = this._getUpdateContentStatement();
            stmt.run(newContent, editedAt?.toISOString() ?? null, messageId);
        } catch (err) {
            this.metrics.errors++;
            console.error(chalk.red('❌ DB edit update error:', err.message));
        }
    }

    checkMemoryUsage() {
        const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
        if (heapUsedMB > 500 && global.gc) global.gc();
        if (this.referenceCache.size > this.config.maxReferenceCache) this.referenceCache.clear();
        if (this.failedReferences.size > this.config.maxFailedReferences) this.failedReferences.clear();
    }

    getMetrics() {
        return { ...this.metrics };
    }

    resetMetrics() {
        this.metrics = { messagesStored: 0, attachmentsProcessed: 0, errors: 0 };
    }

    getMostRecentMessage(channelId) {
        if (!this.db) return null;
        try {
            const stmt = this.db.prepare('SELECT id, timestamp FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1');
            return stmt.get(channelId);
        } catch (err) {
            console.error(chalk.red('❌ Error fetching most recent message:', err.message));
            return null;
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
            writer.on('finish', () => {
                if (size > 5 * 1024 * 1024) console.log(chalk.green(`✅ Downloaded ${filename}`));
                resolve(filePath);
            });
            writer.on('error', (err) => {
                console.log(chalk.yellow(`⚠️ Failed to write file ${filename}: ${err.message}`));
                reject(err);
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

    return Promise.all(embeds.map(async embed => {
        const out = { ...embed };
        for (const [key, prefix] of [['image', 'embed_image'], ['thumbnail', 'embed_thumb'], ['video', 'embed_video']]) {
            const url = embed[key]?.url;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${getFileExtension(url)}`;
            const localPath = await downloadAttachmentFn(url, channelId, filename, messageId);
            if (localPath) out[key] = { ...embed[key], originalUrl: url, localPath };
        }
        return out;
    }));
}
