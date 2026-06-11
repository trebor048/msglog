import moment from 'moment';
import { sleep, sleepJitter } from './utils.js';

// ─── Retry wrapper ────────────────────────────────────────────────────────────
// Discord rate limits are expected and transient. The circuit breaker adds no
// value for message fetches and only causes jobs to fail unnecessarily.
async function retryFetch(fn, attempts = 3, baseDelayMs = 800) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const status = err?.status ?? err?.httpStatus ?? 0;
            const retryable =
                status === 429 ||
                (status >= 500 && status < 600) ||
                err?.message?.includes('rate limit') ||
                err?.message?.includes('ECONNRESET') ||
                err?.message?.includes('ETIMEDOUT') ||
                err?.message?.includes('UND_ERR') ||
                err?.message?.includes('fetch failed');

            if (!retryable) throw err;

            const retryAfter = err?.retryAfter ?? err?.timeout ?? 0;
            const delay = retryAfter > 0 ? retryAfter + 200 : baseDelayMs * Math.pow(2, i);
            if (i < attempts - 1) await sleepJitter(delay);
        }
    }
    throw lastErr;
}

// ─── Sync state (per-channel cursor) ─────────────────────────────────────────
// Inspired by discrawl: store oldest/newest fetched message IDs per channel
// so every sync is resumable without re-scanning the whole DB.

const UPSERT_SYNC_STATE = `
    INSERT INTO channel_sync_state (channel_id, oldest_id, newest_id, total_fetched, last_synced_at, is_complete)
    VALUES (?, ?, ?, ?, datetime('now'), 0)
    ON CONFLICT(channel_id) DO UPDATE SET
        oldest_id      = COALESCE(excluded.oldest_id, oldest_id),
        newest_id      = COALESCE(excluded.newest_id, newest_id),
        total_fetched  = total_fetched + excluded.total_fetched,
        last_synced_at = datetime('now')
`;

const MARK_COMPLETE = `
    UPDATE channel_sync_state
    SET is_complete = 1, last_synced_at = datetime('now')
    WHERE channel_id = ?
`;

function loadSyncState(db, channelId) {
    try {
        return db.prepare('SELECT * FROM channel_sync_state WHERE channel_id = ?').get(channelId) ?? null;
    } catch {
        return null;
    }
}

function flushSyncState(db, channelId, patch) {
    // patch: { oldest_id?, newest_id?, total_fetched }
    try {
        db.prepare(UPSERT_SYNC_STATE).run(
            channelId,
            patch.oldest_id ?? null,
            patch.newest_id ?? null,
            patch.total_fetched ?? 0
        );
    } catch {
        // Non-fatal — sync state is an optimisation, not required for correctness
    }
}

function markChannelComplete(db, channelId) {
    try {
        db.prepare(MARK_COMPLETE).run(channelId);
    } catch {}
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────
export class SyncEngine {
    constructor(jobManager, messageStore, rateLimiter, config, downloadAttachmentFn, processEmbedsFn, performance = null) {
        this.jobManager           = jobManager;
        this.messageStore         = messageStore;
        this.rateLimiter          = rateLimiter;
        this.config               = config;
        this.downloadAttachmentFn = downloadAttachmentFn;
        this.processEmbedsFn      = processEmbedsFn;
        this.performance          = performance;
    }

    async syncChannelMessages(
        channel,
        direction   = 'forward',
        startDate   = null,
        endDate     = null,
        jobId       = null,
        withRetry   = null,   // kept for API compat (used by storeMessagesBatch)
        isShuttingDown = false,
        isPausedFn  = null
    ) {
        const isShutdownRequested = typeof isShuttingDown === 'function'
            ? isShuttingDown
            : () => Boolean(isShuttingDown);
        const attempts  = this.config.retryAttempts   ?? 3;
        const baseDelay = this.config.retryBaseDelayMs ?? 800;
        const maxPages = Math.max(1, Number(this.config.maxSyncPages ?? 100_000));
        const db        = this.messageStore.db;

        // All Discord message fetches bypass the circuit breaker
        const apiFetch = (opts) => retryFetch(() => channel.messages.fetch(opts), attempts, baseDelay);
        const log      = (msg) => this.jobManager.logToJob(jobId, msg);

        let totalMessages = 0;
        let lastHeartbeat = Date.now();
        const HEARTBEAT_MS = 15_000;

        // Accumulated sync state — flushed to DB every FLUSH_EVERY new messages
        // to avoid a DB write on every single batch.
        const FLUSH_EVERY = 500;
        let pendingFlush = { oldest_id: null, newest_id: null, total: 0 };

        try {
            // ── Load stored cursor ───────────────────────────────────────────
            const syncState = db ? loadSyncState(db, channel.id) : null;
            let lastMessageId = null;

            if (direction === 'resume') {
                if (syncState?.newest_id) {
                    lastMessageId = syncState.newest_id;
                    const when = syncState.last_synced_at
                        ? new Date(syncState.last_synced_at).toLocaleString()
                        : 'unknown';
                    log(`📍 Resuming from stored cursor (last synced: ${when})`);
                } else {
                    // Fall back to newest message in DB
                    const row = this.messageStore.getMostRecentMessage(channel.id);
                    if (row) {
                        lastMessageId = row.id;
                        log(`📍 Resuming from DB newest message (${new Date(row.timestamp).toLocaleString()})`);
                    } else {
                        direction = 'forward';
                        log('⚠️ No prior sync state — switching to forward sync');
                    }
                }
            }

            if (direction === 'forward' || direction === 'backward') {
                try {
                    const seed = await apiFetch({ limit: 1 });
                    lastMessageId = seed.first()?.id ?? null;
                    if (lastMessageId) log(`📍 Starting ${direction} sync from newest message`);
                } catch (err) {
                    log(`⚠️ Could not fetch seed message: ${err.message}`);
                }
            }

            // ── Date range ───────────────────────────────────────────────────
            const startMoment = direction === 'custom'
                ? (startDate === 'start' ? moment('2015-01-01') : moment(startDate))
                : null;
            const endMoment = direction === 'custom'
                ? (endDate === 'now' ? moment() : moment(endDate))
                : null;

            if (direction === 'custom' && (!startMoment?.isValid() || !endMoment?.isValid())) {
                log('❌ Invalid date format — use YYYY-MM-DD or "start"/"now"');
                this.jobManager.updateJobStatus(jobId, 'error');
                return;
            }

            // ── Pre-sync info ────────────────────────────────────────────────
            const existingCount = this.messageStore.getMessageCount(channel.id);
            if (existingCount > 0) {
                log(`📦 Channel already has ${existingCount.toLocaleString()} messages in DB`);
            }
            if (syncState?.is_complete) {
                log('✅ Channel previously marked complete — fetching new messages only');
            }

            log(`🚀 ${direction} sync started for #${channel.name}`);

            // ── Main fetch loop ──────────────────────────────────────────────
            let pageCount = 0;
            let stoppedByPageLimit = false;

            while (true) {
                if (++pageCount > maxPages) {
                    log(`⚠️ Reached page limit (${maxPages}) — stopping`);
                    stoppedByPageLimit = true;
                    break;
                }
                if (this.jobManager.isCancelRequested(jobId)) {
                    log('🛑 Cancellation requested — stopping job');
                    this.jobManager.setJobError(jobId, 'Cancelled by user');
                    this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                    return;
                }

                // Shutdown / pause
                if (isShutdownRequested()) {
                    log('🛑 Shutdown signal — halting job');
                    this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                    return;
                }
                if (isPausedFn?.()) {
                    log('⏸️ Paused — waiting...');
                    while (isPausedFn?.() && !isShutdownRequested() && !this.jobManager.isCancelRequested(jobId)) await sleep(2000);
                    if (this.jobManager.isCancelRequested(jobId)) {
                        log('🛑 Cancellation requested — stopping job');
                        this.jobManager.setJobError(jobId, 'Cancelled by user');
                        this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                        return;
                    }
                    if (isShutdownRequested()) { this.jobManager.updateJobStatus(jobId, 'error', totalMessages); return; }
                    log('▶️ Resumed');
                }

                // Heartbeat so the monitor doesn't look hung on slow channels
                if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
                    log(`💓 Still running — ${totalMessages.toLocaleString()} stored so far`);
                    lastHeartbeat = Date.now();
                }

                await this.rateLimiter.wait(channel.id);

                // Build fetch options
                const fetchOpts = { limit: 100 };
                if (direction === 'resume' && lastMessageId) {
                    fetchOpts.after = lastMessageId;   // page forward from newest stored
                } else if (lastMessageId) {
                    fetchOpts.before = lastMessageId;  // page backward from cursor
                }

                // Fetch with retry (no circuit breaker)
                let messages;
                try {
                    messages = await apiFetch(fetchOpts);
                } catch (err) {
                    log(`❌ Fetch failed after ${attempts} retries: ${err.message}`);
                    this.jobManager.setJobError(jobId, err.message);
                    this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                    return;
                }

                if (!messages.size) break; // no more messages — done

                let batch = [...messages.values()];

                // Date range filter + stop condition
                if (direction === 'custom') {
                    batch = batch.filter(m => moment(m.createdAt).isBetween(startMoment, endMoment, null, '[]'));
                    const oldest = messages.last()?.createdAt;
                    if (oldest && moment(oldest).isBefore(startMoment)) {
                        log('📍 Reached start of date range');
                        break;
                    }
                }

                // Advance cursor BEFORE dedup so we always make progress
                lastMessageId = direction === 'resume'
                    ? messages.first().id   // after= returns newest-first
                    : messages.last().id;   // before= returns newest-first, last = oldest

                if (!batch.length) continue;

                // Dedup against DB — only store messages we don't already have
                const ids     = batch.map(m => m.id);
                const existing = this.messageStore.getExistingMessageIds(channel.id, ids);
                const newMsgs  = batch.filter(m => !existing.has(m.id));

                if (newMsgs.length === 0) {
                    // All already stored — on resume this means we've caught up
                    if (direction === 'resume') {
                        log('✅ Caught up — all messages already in DB');
                        break;
                    }
                    continue;
                }

                if (newMsgs.length < batch.length) {
                    log(`⏭️ ${batch.length - newMsgs.length} already in DB, storing ${newMsgs.length} new`);
                }

                // Store — forward sync reverses so oldest-first insert order
                const toStore = direction === 'forward' ? [...newMsgs].reverse() : newMsgs;
                await this.messageStore.storeMessagesBatch(
                    toStore, channel, withRetry,
                    this.downloadAttachmentFn, this.processEmbedsFn, isShutdownRequested
                );

                // Update job preview
                toStore.forEach(msg => { try { this.jobManager.addMessageToJob(jobId, msg); } catch {} });

                totalMessages += newMsgs.length;
                this.jobManager.updateJobStatus(jobId, 'running', totalMessages);
                lastHeartbeat = Date.now();

                // Accumulate cursor state in memory
                const oldestInBatch = toStore[toStore.length - 1];
                if (direction !== 'resume') {
                    pendingFlush.oldest_id = oldestInBatch.id;
                } else {
                    pendingFlush.newest_id = lastMessageId;
                }
                pendingFlush.total += newMsgs.length;

                // Flush cursor to DB every FLUSH_EVERY messages
                if (pendingFlush.total >= FLUSH_EVERY && db) {
                    const oldest = new Date(oldestInBatch.createdTimestamp).toLocaleDateString();
                    log(`📊 ${totalMessages.toLocaleString()} stored — reached ${oldest}`);
                    flushSyncState(db, channel.id, {
                        oldest_id: pendingFlush.oldest_id,
                        newest_id: pendingFlush.newest_id,
                        total_fetched: pendingFlush.total
                    });
                    pendingFlush = { oldest_id: null, newest_id: null, total: 0 };
                    this.messageStore.checkMemoryUsage();
                }
            }

            // ── Final cursor flush ───────────────────────────────────────────
            if (db && pendingFlush.total > 0) {
                flushSyncState(db, channel.id, {
                    oldest_id: pendingFlush.oldest_id,
                    newest_id: pendingFlush.newest_id,
                    total_fetched: pendingFlush.total
                });
            }

            if (stoppedByPageLimit) {
                const reason = `Stopped at safety page limit (${maxPages}); channel not marked fully synced`;
                log(`⚠️ ${reason}`);
                this.jobManager.setJobError(jobId, reason);
                this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                return;
            }

            // ── Completion ───────────────────────────────────────────────────
            log(`✅ Done — ${totalMessages.toLocaleString()} new messages from #${channel.name}`);
            this.jobManager.updateJobStatus(jobId, 'completed', totalMessages);

            // Mark complete only for full backward/forward syncs (not resume or custom)
            if (db && (direction === 'backward' || direction === 'forward')) {
                markChannelComplete(db, channel.id);
                log('📌 Channel marked as fully synced');
            }

            if (this.performance) {
                this.performance.stats.totalSyncs++;
                this.performance.stats.totalMessagesFetched += totalMessages;
            }

            this.messageStore.checkpoint();

        } catch (err) {
            log(`❌ Unexpected error: ${err.message}`);
            if (this.performance) {
                this.performance.stats.totalErrors++;
                this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
            }
            this.jobManager.setJobError(jobId, err.message);
            this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
        }
    }

    async syncAllChannelsParallel(client, listeningChannels, withRetry, isShuttingDown, isPausedFn = null) {
        const isShutdownRequested = typeof isShuttingDown === 'function'
            ? isShuttingDown
            : () => Boolean(isShuttingDown);
        if (isShutdownRequested()) return;

        const channels = [...listeningChannels]
            .map(id => client.channels.cache.get(id))
            .filter(Boolean);

        if (!channels.length) return;

        const runningJobs = this.jobManager.getAllJobs().filter(j => j.status === 'running').length;
        const capacity = Math.max(0, this.config.maxConcurrentJobs - runningJobs);
        if (capacity === 0) return;

        const available = channels
            .filter(ch => !this.jobManager.channelHasActiveJob(ch.id))
            .slice(0, capacity);

        if (!available.length) return;

        available.forEach(ch => {
            const job = this.jobManager.createJob(ch, 'resume', null, null);
            this.syncChannelMessages(ch, 'resume', null, null, job.id, withRetry, isShutdownRequested, isPausedFn)
                .catch(err => {
                    this.jobManager.logToJob(job.id, `❌ Unhandled: ${err.message}`);
                    this.jobManager.updateJobStatus(job.id, 'error');
                });
        });
    }
}
