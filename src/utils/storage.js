import chalk from 'chalk';
import axios from 'axios';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getFileExtension, Validator } from './utils.js';

// ============ MESSAGE STORAGE ============
const MAX_SQLITE_PARAMS = 900;

export class MessageStore {
    constructor(db, config, performance = null) {
        this.db = db;
        this.config = config;
        this.performance = performance;
        this.referenceCache = new Map();
        this.failedReferences = new Set();
        // Pending ops for messages whose row hasn't been inserted yet (the
        // realtime insert is deferred behind attachment downloads, so an edit/
        // delete/reaction can arrive before the row exists). Applied after insert.
        this.pendingDeletes = new Set();
        this.pendingEdits = new Map();
        this.pendingReactions = new Map();
        this._storedSinceLastMemCheck = 0;
        this.insertStmt = null;
        this.updateReactionsStmt = null;
        this.deleteStmt = null;
        this.updateContentStmt = null;

    }

    _getInsertStatement() {
        if (!this.insertStmt && this.db) {
            // INSERT OR IGNORE prevents duplicate row writes for already-stored IDs.
            // The sync engine deduplicates before insert to minimize ignored writes.
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
            // The reference may point at a different channel (thread→parent,
            // crosspost, cross-channel reply). Fetch from the referenced channel
            // when one is specified, falling back to the message's own channel.
            let targetChannel = channel;
            if (message.reference.channelId && message.reference.channelId !== channel.id) {
                targetChannel = message.guild?.channels?.cache?.get(message.reference.channelId)
                    || channel.client?.channels?.cache?.get(message.reference.channelId)
                    || channel;
            }
            const fetchFn = () => targetChannel.messages.fetch(refId, { cache: true });
            const ref = await (typeof withRetry === 'function' ? withRetry(fetchFn) : fetchFn());
            const content = ref.content || '[Message content not available]';
            this.referenceCache.set(refId, content);
            return content;
        } catch (err) {
            // Only permanently cache genuine "not found" errors. Transient failures
            // (rate limits, network) should be retried on future messages instead of
            // permanently reporting the reference as deleted. Return null (not a
            // placeholder) so a transient failure doesn't poison the stored column.
            const status = err?.status ?? err?.httpStatus ?? 0;
            if (status === 403 || status === 404 || status === 405) {
                this.failedReferences.add(refId);
                return '[Reference message deleted]';
            }
            return null;
        }
    }

    async buildAttachmentData(message, downloadAttachmentFn) {
        if (!this.config.downloadAttachments || message.attachments.size === 0)
            return [...message.attachments.values()].map(a => ({ url: a.url, filename: a.name, size: a.size }));

        const results = [];
        for (const a of message.attachments.values()) {
            try {
                const localPath = await downloadAttachmentFn(a.url, message.channel.id, a.name, message.id, a.size);
                if (localPath && this.performance) this.performance.stats.totalAttachmentsDownloaded++;
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
        const isShutdownRequested = typeof isShuttingDown === 'function'
            ? isShuttingDown
            : () => Boolean(isShuttingDown);
        if (!messages.length || !this.db || isShutdownRequested()) return;

        const insert = this._getInsertStatement();
        if (!insert) return;

        try {
            const rows = [];
            for (const msg of messages) {
                if (isShutdownRequested()) break;
                // Discord messages always have an author, but be defensive
                // against edge-case API responses where author may be missing.
                if (!msg.author) continue;
                try {
                    const refContent = await this.fetchReferenceContent(msg, channel, withRetry);
                    const attachmentData = await this.buildAttachmentData(msg, downloadAttachmentFn);
                    const processedEmbeds = processEmbedsFn
                        ? await processEmbedsFn(msg.embeds, msg.channel.id, msg.id)
                        : msg.embeds;

                    rows.push({
                        id: msg.id,
                        author_id: msg.author?.id ?? 'unknown',
                        author_tag: msg.author?.tag ?? 'Unknown#0000',
                        content: msg.content ?? '',
                        timestamp: msg.createdAt.toISOString(),
                        channel_id: msg.channel.id,
                        attachments: JSON.stringify(attachmentData),
                        embeds: JSON.stringify(processedEmbeds),
                        reference_message_id: msg.reference?.messageId ?? null,
                        reference_message_content: refContent,
                        reactions: JSON.stringify(
                            msg.reactions?.cache
                                ? [...msg.reactions.cache.entries()].map(([emoji, reaction]) => ({
                                    emoji: emoji.toString(),
                                    count: reaction.count
                                }))
                                : []
                        ),
                        is_bot: msg.author?.bot ?? false ? 1 : 0
                    });
                } catch (err) {
                    // A single malformed message (missing createdAt/channel, bad
                    // embed payload) must not discard the whole batch — previously
                    // the batch threw and the sync job died, losing every other
                    // message in it. Log and skip just this one.
                    console.error(chalk.yellow(`⚠️ Skipping malformed message ${msg.id}: ${err.message}`));
                    if (this.performance) this.performance.stats.totalErrors++;
                }
            }
            if (!rows.length) return;

            // Insert the batch AND apply any pending edit/delete/reaction ops in
            // a single transaction so a crash can't commit rows without their
            // queued updates.
            const ids = rows.map(r => r.id);
            const txn = this.db.transaction(() => {
                for (const row of rows) insert.run(row);
                for (const id of ids) {
                    if (this.pendingDeletes.has(id)) {
                        this._getDeleteStatement().run(id);
                        this.pendingDeletes.delete(id);
                    }
                    if (this.pendingEdits.has(id)) {
                        const e = this.pendingEdits.get(id);
                        this._getUpdateContentStatement().run(e.newContent, e.editedAt, id);
                        this.pendingEdits.delete(id);
                    }
                    if (this.pendingReactions.has(id)) {
                        const reactions = this.pendingReactions.get(id);
                        this._getUpdateReactionsStatement().run(
                            JSON.stringify([...reactions.entries()]
                                .map(([emoji, r]) => ({ emoji: emoji.toString(), count: r.count }))),
                            id
                        );
                        this.pendingReactions.delete(id);
                    }
                }
            });
            txn();

            this._storedSinceLastMemCheck += rows.length;
            if (this._storedSinceLastMemCheck >= 200) {
                this.checkMemoryUsage();
                this._storedSinceLastMemCheck = 0;
            }
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
            throw err;
        }
    }

    updateMessageReactions(messageId, reactions) {
        if (!this.db) return;
        try {
            const stmt = this._getUpdateReactionsStatement();
            const result = stmt.run(
                JSON.stringify([...reactions.entries()]
                    .map(([emoji, r]) => ({ emoji: emoji.toString(), count: r.count }))),
                messageId
            );
            if (result.changes === 0) {
                // Row not inserted yet (realtime insert is deferred behind
                // downloads) — queue the reaction update to apply after insert.
                this.pendingReactions.set(messageId, reactions);
                this._boundedPending(this.pendingReactions);
            }
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
            const result = stmt.run(messageId);
            if (result.changes === 0) {
                // Row not inserted yet — remember the delete so it applies after insert.
                this.pendingDeletes.add(messageId);
                this._boundedPending(this.pendingDeletes);
            }
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
            const result = stmt.run(newContent, editedAt?.toISOString() ?? null, messageId);
            if (result.changes === 0) {
                // Row not inserted yet — queue the edit to apply after insert.
                this.pendingEdits.set(messageId, { newContent, editedAt: editedAt?.toISOString() ?? null });
                this._boundedPending(this.pendingEdits);
            }
        } catch (err) {
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            console.error(chalk.red('❌ DB edit update error:', err.message));
        }
    }

    // Bound the pending-op structures so a delete/edit/reaction for a message
    // that never gets stored (e.g. already gone from Discord) can't grow memory
    // without limit.
    _boundedPending(coll) {
        const MAX_PENDING = 5000;
        if (coll instanceof Set) {
            if (coll.size > MAX_PENDING) {
                const drop = [...coll].slice(0, coll.size - MAX_PENDING);
                drop.forEach(id => coll.delete(id));
            }
        } else if (coll instanceof Map) {
            if (coll.size > MAX_PENDING) {
                const keys = [...coll.keys()];
                const drop = keys.slice(0, keys.length - MAX_PENDING);
                drop.forEach(k => coll.delete(k));
            }
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
    _getByIdStmt = null;
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

    finalizeAllStatements() {
        if (!this.db) return;
        const stmts = [
            this.insertStmt, this.updateReactionsStmt, this.deleteStmt,
            this.updateContentStmt, this._getMostRecentStmt, this._getOldestStmt,
            this._getByIdStmt, this._getCountStmt
        ];
        // better-sqlite3 Statements have no finalize() — they are released on
        // GC and by db.close(). Guard anyway so this stays correct if a future
        // version adds the API.
        stmts.forEach(s => { try { if (typeof s?.finalize === 'function') s.finalize(); } catch {} });
        this.insertStmt = null;
        this.updateReactionsStmt = null;
        this.deleteStmt = null;
        this.updateContentStmt = null;
        this._getMostRecentStmt = null;
        this._getOldestStmt = null;
        this._getByIdStmt = null;
        this._getCountStmt = null;

        if (this._existingStmtCache) {
            for (const stmt of this._existingStmtCache.values()) {
                try { if (typeof stmt.finalize === 'function') stmt.finalize(); } catch {}
            }
            this._existingStmtCache.clear();
        }
    }

    getMostRecentMessage(channelId) {
        if (!this.db) return null;
        try {
            if (!this._getMostRecentStmt) {
                // Order by timestamp, NOT by id: snowflake ids are variable
                // length (17 digits in 2015 → 19 today), so lexicographic
                // ORDER BY id would rank an ancient short id as "newest".
                // timestamp is stored as a UTC ISO string, which sorts
                // chronologically; id breaks same-millisecond ties.
                this._getMostRecentStmt = this.db.prepare(
                    'SELECT id, timestamp FROM messages WHERE channel_id = ? AND timestamp IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1'
                );
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
                // See getMostRecentMessage: id is TEXT, so order by timestamp.
                this._getOldestStmt = this.db.prepare(
                    'SELECT id, timestamp FROM messages WHERE channel_id = ? AND timestamp IS NOT NULL ORDER BY timestamp ASC, id ASC LIMIT 1'
                );
            }
            return this._getOldestStmt.get(channelId);
        } catch (err) {
            console.error(chalk.red('❌ Error fetching oldest message:', err.message));
            return null;
        }
    }

    getMessageById(channelId, messageId) {
        if (!this.db || !messageId) return null;
        try {
            if (!this._getByIdStmt) {
                this._getByIdStmt = this.db.prepare(
                    'SELECT id, author_tag, content, timestamp FROM messages WHERE channel_id = ? AND id = ?'
                );
            }
            return this._getByIdStmt.get(channelId, messageId) ?? null;
        } catch (err) {
            console.error(chalk.red('❌ Error fetching message by id:', err.message));
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

        // SSRF guard: only allow Discord media hosts. Embed URLs and attachment
        // URLs are attacker-influenced; fetching arbitrary hosts (localhost,
        // cloud metadata, internal networks) must be blocked.
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch {
            console.log(chalk.yellow(`⚠️ Malformed URL for download: ${url}`));
            return null;
        }
        const allowedHostRe = /^(?:cdn|media|images|images-ext-\d+)\.discordapp\.(?:com|net)$/;
        if (!allowedHostRe.test(host)) {
            console.log(chalk.yellow(`⚠️ Blocked download from non-Discord host: ${host}`));
            return null;
        }

        const MAX_FILE_SIZE = 100 * 1024 * 1024;
        if (size > MAX_FILE_SIZE) {
            console.log(chalk.yellow(`⚠️ File too large: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`));
            return null;
        }

        // Extensions that can execute code or carry scripted content. A malicious
        // attachment with one of these is never written to disk.
        const unsafeExtensions = [
            '.exe', '.bat', '.cmd', '.ps1', '.sh', '.js', '.vbs', '.scr', '.hta',
            '.pif', '.com', '.msi', '.jar', '.lnk', '.url', '.svg', '.html', '.htm',
            '.mhtml', '.vbe', '.jse', '.wsf', '.cpl', '.dll', '.apk', '.app', '.gadget'
        ];
        const safeOriginalFilename = Validator.sanitizeFilename(path.basename(String(filename || 'attachment')));
        const sanitizedFilename = safeOriginalFilename || 'attachment';
        if (unsafeExtensions.some(ext => sanitizedFilename.toLowerCase().endsWith(ext))) {
            console.log(chalk.yellow(`⚠️ Skipping potentially unsafe file: ${filename}`));
            return null;
        }

        if (size > 10 * 1024 * 1024)
            console.log(chalk.blue(`📁 Large file: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`));

        const safeChannelId = Validator.sanitizeFilename(String(channelId));
        const contentDir = Validator.validatePathConfinement(safeChannelId, 'content');
        await fs.mkdir(contentDir, { recursive: true });

        let finalFilename = sanitizedFilename;
        if (messageId) {
            const fileExt = path.extname(sanitizedFilename);
            const base = path.basename(sanitizedFilename, fileExt);
            const safeMessageId = Validator.sanitizeFilename(String(messageId));
            finalFilename = `${base}_${safeMessageId}${fileExt}`;
        }

        const filePath = Validator.validatePathConfinement(finalFilename, contentDir);

        try {
            await fs.access(filePath);
            // Verify an existing file isn't a partial/corrupt artifact from a
            // crashed download before reusing it.
            if (size > 0) {
                const existing = await fs.stat(filePath);
                if (existing.size < size) {
                    console.log(chalk.yellow(`⚠️ Existing file is truncated (${existing.size}/${size} bytes) — re-downloading ${filename}`));
                    await fs.unlink(filePath).catch(() => {});
                } else {
                    console.log(chalk.blue(`📁 File already exists: ${filename}`));
                    return filePath;
                }
            } else {
                console.log(chalk.blue(`📁 File already exists: ${filename}`));
                return filePath;
            }
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

        // Write to a temp file and rename atomically on success so concurrent
        // downloads of the same message never truncate each other's output.
        const tmpPath = `${filePath}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const writer = createWriteStream(tmpPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            let settled = false;
            let downloadedBytes = 0;

            const cleanup = (err) => {
                if (settled) return;
                settled = true;
                // Allow the OS to release the file handle before unlinking,
                // otherwise partial files persist on Windows.
                try { response.data.destroy(); } catch {}
                try { writer.destroy(); } catch {}
                setTimeout(() => {
                    fs.unlink(tmpPath).catch(() => {});
                }, 100);
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
                fs.rename(tmpPath, filePath).then(() => {
                    if (size > 5 * 1024 * 1024) console.log(chalk.green(`✅ Downloaded ${filename}`));
                    resolve(filePath);
                }).catch(err => {
                    console.log(chalk.yellow(`⚠️ Failed to finalize ${filename}: ${err.message}`));
                    fs.unlink(tmpPath).catch(() => {});
                    reject(err);
                });
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
        if (!embed || typeof embed !== 'object') {
            results.push(embed);
            continue;
        }
        const out = { ...embed };
        for (const [key, prefix] of [['image', 'embed_image'], ['thumbnail', 'embed_thumb'], ['video', 'embed_video']]) {
            const url = embed[key]?.url;
            if (!url || seenUrls.has(url)) continue;
            const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${getFileExtension(url)}`;
            try {
                const localPath = await downloadAttachmentFn(url, channelId, filename, messageId);
                // Only dedup on success: a failed download shouldn't block a later
                // embed (or later key) from retrying the same URL, and a successful
                // download should be reusable by later embeds with the same URL.
                if (localPath) {
                    seenUrls.add(url);
                    out[key] = { ...embed[key], originalUrl: url, localPath };
                }
            } catch (err) {
                // A failed embed-media download must not abort the whole message batch
                console.log(chalk.yellow(`⚠️ Failed to download embed media ${url}: ${err.message}`));
            }
        }
        results.push(out);
    }

    return results;
}
