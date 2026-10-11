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
            if (i < attempts - 1) {
                // retryAfter is a hard deadline — never jitter below it
                if (retryAfter > 0) await sleep(delay);
                else await sleepJitter(delay);
            }
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

        // All Discord message fetches bypass the circuit breaker.
        // cache:false keeps bulk syncs from ballooning discord.js's in-memory
        // message cache — a multi-day catch-up can otherwise cache hundreds of
        // thousands of Message objects (the config's maxCacheSize is not wired
        // to the discord.js cache).
        const apiFetch = (opts) => retryFetch(() => channel.messages.fetch(opts, { cache: false }), attempts, baseDelay);
        const log      = (msg) => this.jobManager.logToJob(jobId, msg);

        let totalMessages = 0;
        let lastHeartbeat = Date.now();
        const HEARTBEAT_MS = 15_000;

        // Accumulated sync state — flushed to DB every FLUSH_EVERY new messages
        // to avoid a DB write on every single batch.
        const FLUSH_EVERY = 500;
        let pendingFlush = { oldest_id: null, newest_id: null, total: 0 };
        // Run-wide cursor anchors. For forward/resume, newestAnchor tracks the
        // walk frontier (updated every page so it can be persisted even when a
        // run stores 0 new messages); oldestAnchor stays null. For
        // backward/custom, oldestAnchor tracks the walk downward and newestAnchor
        // is anchored once (the true newest of the channel).
        let oldestAnchor = null;
        let newestAnchor = null;
        // When true, the first forward fetch pages from the Discord epoch snowflake
        // so the channel's oldest message is included in the batch (after= is exclusive).
        let useEpochAfter = false;

        try {
            // Captured up-front (inside the try so a failure can't strand the
            // job in 'running'): the forward cursor decision and the completion
            // logic both need to know whether the channel has ANY stored rows.
            const existingCount = this.messageStore.getMessageCount(channel.id);

            // ── Load stored cursor ───────────────────────────────────────────
            const syncState = db ? loadSyncState(db, channel.id) : null;
            let lastMessageId = null;

            // Record the "starting point" — the DB entry (or anchor) that the
            // job will start from — so the Live Monitor can show exactly where
            // this job picks up, and log it once for the job log.
            const recordStartingPoint = (label, msgId) => {
                const row = msgId && typeof this.messageStore.getMessageById === 'function'
                    ? this.messageStore.getMessageById(channel.id, msgId)
                    : null;
                let description;
                if (row?.author_tag) {
                    const when = row.timestamp ? new Date(row.timestamp).toLocaleString() : 'unknown time';
                    const snippet = String(row.content || '').slice(0, 60);
                    description = `${label} — ${row.author_tag} on ${when}${snippet ? `: "${snippet}"` : ''} (id ${row.id})`;
                } else if (msgId) {
                    description = `${label} (id ${msgId})`;
                } else {
                    description = label;
                }
                this.jobManager.setJobStartingPoint(jobId, { label, id: msgId ?? null, description });
                log(`📍 Starting point: ${description}`);
            };

            // If channel was fully synced, backward/forward re-syncs should
            // behave as resume (fetch only new messages). This MUST happen
            // before the cursor is initialized below, otherwise the cursor
            // would be seeded from the wrong direction.
            if (syncState?.is_complete && (direction === 'backward' || direction === 'forward')) {
                log('✅ Channel previously marked complete — redirecting to resume (new messages only)');
                direction = 'resume';
            }

            if (direction === 'resume') {
                // Resume: fetch messages NEWER than our last known newest.
                // Uses after= in the fetch loop.
                if (syncState?.newest_id) {
                    lastMessageId = syncState.newest_id;
                    const when = syncState.last_synced_at
                        ? new Date(syncState.last_synced_at).toLocaleString()
                        : 'unknown';
                    recordStartingPoint(`Resume — from stored cursor (last synced: ${when})`, syncState.newest_id);
                } else {
                    const row = this.messageStore.getMostRecentMessage(channel.id);
                    if (row) {
                        lastMessageId = row.id;
                        recordStartingPoint('Resume — from newest stored message', row.id);
                    } else {
                        // No prior state and no DB rows — fetch from the channel's
                        // newest. Do NOT seed the cursor with the newest message's
                        // id: after= is exclusive, so that would skip it entirely.
                        // Leaving lastMessageId null makes the first loop page a
                        // plain newest-100 fetch, which includes the newest message.
                        recordStartingPoint('Resume — no prior sync state, starting from channel newest', null);
                        lastMessageId = null;
                    }
                }
            } else if (direction === 'backward') {
                // Backward: start from the channel's NEWEST message and page toward
                // oldest. Do NOT seed the cursor with the newest message's id:
                // before= is exclusive, so that would skip the newest message. A
                // null cursor makes the first page a newest-100 fetch.
                recordStartingPoint('Backward sync — from channel newest message', null);
                lastMessageId = null;
            } else if (direction === 'forward') {
                // Forward: start from the OLDEST message already in DB (or channel start
                // if nothing is stored yet) and page toward the newest.
                const oldestRow = this.messageStore.getOldestMessage(channel.id);
                if (oldestRow?.id) {
                    lastMessageId = oldestRow.id;
                    recordStartingPoint('Forward sync — from oldest stored message', oldestRow.id);
                } else if (syncState?.oldest_id && existingCount > 0) {
                    lastMessageId = syncState.oldest_id;
                    recordStartingPoint('Forward sync — from stored oldest cursor', syncState.oldest_id);
                } else {
                    // No data at all (an empty DB means any stored oldest_id is
                    // stale — it points at rows that no longer exist, and seeding
                    // the walk with it would skip every message older than it).
                    // Fetch the channel's oldest message instead. We must NOT use
                    // the seed as the first loop cursor, because Discord's
                    // `after=` is exclusive and would skip that seed message.
                    // Instead leave the cursor null and let the first loop
                    // iteration page from the epoch snowflake, so the oldest
                    // message is stored too.
                    recordStartingPoint('Forward sync — from channel start (no stored data)', null);
                    lastMessageId = null;
                    useEpochAfter = true;
                }
            }

            // ── Date range ───────────────────────────────────────────────────
            let startMoment = null;
            let endMoment = null;
            if (direction === 'custom') {
                if (startDate === 'start') {
                    // Use channel creation date instead of hardcoded 2015
                    if (channel.createdTimestamp) {
                        startMoment = moment(channel.createdTimestamp).startOf('day');
                        log(`📍 Using channel creation date as start: ${startMoment.format('YYYY-MM-DD')}`);
                    } else {
                        startMoment = moment('2015-05-13');
                        log('📍 Channel creation date unavailable — using Discord launch date (2015-05-13)');
                    }
                } else {
                    startMoment = moment(startDate).startOf('day');
                }
                // Date-only end dates must be end-of-day so the final day's
                // messages are included (the filter is end-inclusive).
                endMoment = endDate === 'now' ? moment() : moment(endDate).endOf('day');
            }

            if (direction === 'custom' && (!startMoment?.isValid() || !endMoment?.isValid())) {
                log('❌ Invalid date format — use YYYY-MM-DD or "start"/"now"');
                this.jobManager.setJobError(jobId, 'Invalid date format — use YYYY-MM-DD or "start"/"now"');
                this.jobManager.updateJobStatus(jobId, 'error');
                return;
            }

            if (direction === 'custom' && startMoment.isAfter(endMoment)) {
                // An inverted range would silently page through the entire channel
                // storing nothing (isBetween(start > end) matches nothing).
                log('❌ Start date is after end date');
                this.jobManager.setJobError(jobId, 'Start date is after end date');
                this.jobManager.updateJobStatus(jobId, 'error');
                return;
            }

            if (direction === 'custom') {
                recordStartingPoint(
                    `Custom date range ${startMoment.format('YYYY-MM-DD')} → ${endMoment.format('YYYY-MM-DD')}`,
                    null
                );
            }

            // ── Pre-sync info ────────────────────────────────────────────────
            if (existingCount > 0) {
                log(`📦 Channel already has ${existingCount.toLocaleString()} messages in DB`);
            }

            log(`🚀 ${direction} sync started for #${channel.name}`);

            // ── Main fetch loop ──────────────────────────────────────────────
            let pageCount = 0;
            let stoppedByPageLimit = false;
            let warnedStoredRegion = false;

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
                    const pausedAt = Date.now();
                    const MAX_PAUSE_MS = 600_000; // 10 minute max pause
                    while (isPausedFn?.() && !isShutdownRequested() && !this.jobManager.isCancelRequested(jobId)) {
                        if (Date.now() - pausedAt > MAX_PAUSE_MS) {
                            log('⏸️ Pause timeout reached — stopping job');
                            this.jobManager.setJobError(jobId, 'Paused for too long');
                            this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                            return;
                        }
                        await sleep(2000);
                    }
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

                await this.rateLimiter.wait(channel.id, { fast: true });

                // Build fetch options
                // Discord always returns messages newest-first within a batch.
                //
                // Direction semantics:
                //   'resume'   → after=  : fetch messages NEWER than cursor (catches up to present)
                //   'backward' → before= : start from newest, walk toward oldest
                //   'forward'  → after=  : start from oldest stored, walk toward newest
                //   'custom'   → before= : start from newest, walk toward oldest, filtered by date
                const fetchOpts = { limit: 100 };
                if (direction === 'resume' || direction === 'forward') {
                    if (useEpochAfter) {
                        const DISCORD_EPOCH_SNOWFLAKE = '4194304';
                        fetchOpts.after = DISCORD_EPOCH_SNOWFLAKE;
                        useEpochAfter = false;
                    } else if (lastMessageId) {
                        fetchOpts.after = lastMessageId;
                    }
                } else if (lastMessageId) {
                    fetchOpts.before = lastMessageId;
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

                // Re-check cancellation after the fetch (before the store, which
                // can be slow with attachment/embed downloads) so a cancel stops
                // promptly instead of finishing the whole batch first.
                if (this.jobManager.isCancelRequested(jobId)) {
                    log('🛑 Cancellation requested — stopping job');
                    this.jobManager.setJobError(jobId, 'Cancelled by user');
                    this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                    return;
                }

                let batch = [...messages.values()];

                // Date range filter + stop condition for custom syncs.
                // Discord returns newest-first; messages.first() = newest in batch.
                // Stop only when the NEWEST message in the batch is already before
                // startMoment — all remaining history is out of range.
                if (direction === 'custom') {
                    const batchNewest = messages.first()?.createdAt;
                    if (batchNewest && moment(batchNewest).isBefore(startMoment)) {
                        log('📍 Reached start of date range');
                        break;
                    }
                    batch = batch.filter(m => moment(m.createdAt).isBetween(startMoment, endMoment, null, '[]'));
                }

                // Advance cursor based on direction.
                //
                // Discord's REST API ALWAYS returns message batches newest-first
                // (sorted by snowflake id descending), regardless of before= or
                // after=. discord.js-selfbot-v13's fetch() builds the Collection in
                // that exact API order, so:
                //   .first() = NEWEST message of the batch
                //   .last()  = OLDEST message of the batch
                //
                //   resume/forward (after=): the next page must continue AFTER the
                //     newest message we just fetched → cursor = .first().id
                //     (using .last() here re-fetches ~99 already-seen messages per
                //     page — the old "1 new, 99 skip" crawl).
                //   backward/custom (before=): the next page must continue BEFORE
                //     the oldest message we just fetched → cursor = .last().id
                const batchNewest = messages.first()?.id ?? null;
                const batchOldest = messages.last()?.id ?? null;
                const prevCursor  = lastMessageId;
                lastMessageId = (direction === 'resume' || direction === 'forward')
                    ? batchNewest
                    : batchOldest;

                // Safety net: a batch that does not advance the cursor (the API
                // returned the same window again, or messages without usable
                // ids) would make this loop spin until maxSyncPages. Treat it
                // like an empty page and stop.
                if (!lastMessageId || lastMessageId === prevCursor) {
                    log('⚠️ Fetch cursor did not advance — stopping pagination');
                    break;
                }

                // Track the walk frontier so the cursor can be persisted even when
                // a run stores 0 new messages (already fully caught up).
                if (direction === 'resume' || direction === 'forward') {
                    if (batchNewest) newestAnchor = batchNewest;
                }

                if (!batch.length) continue;

                // Dedup against DB — only store messages we don't already have
                const ids     = batch.map(m => m.id);
                const existing = this.messageStore.getExistingMessageIds(channel.id, ids);
                const newMsgs  = batch.filter(m => !existing.has(m.id));

                if (newMsgs.length === 0) {
                    // All already stored. Do NOT stop here: a stored block right
                    // after the cursor proves nothing about newer messages, and a
                    // gap further up (listener on/off periods) would be silently
                    // missed forever. Keep paging until the channel's actual
                    // newest is reached (empty page). Pages are cheap (100 msgs).
                    if (!warnedStoredRegion) {
                        log('ℹ️ Skipping already-stored region — paging through to check for gaps');
                        warnedStoredRegion = true;
                    }
                    continue;
                }

                if (newMsgs.length < batch.length) {
                    log(`⏭️ ${batch.length - newMsgs.length} already in DB, storing ${newMsgs.length} new`);
                }

                // Store in chronological order (oldest first) for ALL directions.
                // The API always returns newest-first, so reverse every batch.
                const toStore = [...newMsgs].reverse();
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
                // toStore is always oldest-first, so toStore[0] = oldest, toStore[last] = newest
                const oldestInBatch = toStore[0];
                const newestInBatch = toStore[toStore.length - 1];
                if (direction === 'resume' || direction === 'forward') {
                    // Forward/resume walks oldest→newest. newestAnchor was already
                    // set to the batch frontier above (the newest message of the
                    // window, which is in the DB either way). Never write
                    // oldest_id: it's the backward cursor (true oldest fetched),
                    // which only backward/custom syncs should set.
                    pendingFlush.oldest_id = null;
                    pendingFlush.newest_id = newestAnchor;
                } else {
                    // Backward/custom walks newest→oldest. Anchor the newest once
                    // (the true newest of the channel) and keep updating oldest.
                    oldestAnchor = oldestInBatch?.id ?? null;
                    if (!newestAnchor) newestAnchor = newestInBatch?.id ?? null;
                    pendingFlush.oldest_id = oldestAnchor;
                    pendingFlush.newest_id = newestAnchor;
                }
                pendingFlush.total += newMsgs.length;

                // Flush cursor to DB every FLUSH_EVERY messages
                if (pendingFlush.total >= FLUSH_EVERY && db) {
                    const frontier = (direction === 'resume' || direction === 'forward')
                        ? new Date(newestInBatch.createdTimestamp).toLocaleDateString()
                        : new Date(oldestInBatch.createdTimestamp).toLocaleDateString();
                    log(`📊 ${totalMessages.toLocaleString()} stored — now at ${frontier}`);
                    flushSyncState(db, channel.id, {
                        oldest_id: oldestAnchor,
                        newest_id: newestAnchor,
                        total_fetched: pendingFlush.total
                    });
                    pendingFlush = { oldest_id: null, newest_id: null, total: 0 };
                    this.messageStore.checkMemoryUsage();
                }
            }

            // ── Final cursor flush ───────────────────────────────────────────
            // Also persist the advanced resume/forward frontier when a run stored
            // 0 new messages (already caught up) so the next resume starts from
            // the true newest instead of re-walking the same windows.
            const shouldFlushCursor = pendingFlush.total > 0 ||
                ((direction === 'resume' || direction === 'forward') && newestAnchor);
            if (db && shouldFlushCursor) {
                flushSyncState(db, channel.id, {
                    oldest_id: oldestAnchor,
                    newest_id: newestAnchor,
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

            // Mark complete only for syncs that genuinely reached the channel's
            // oldest message:
            //   - backward: seeds from newest and pages to the true oldest.
            //   - forward:  only if the DB was empty beforehand (starts from the
            //     channel's actual oldest via the epoch seed). A forward sync on a
            //     partially-populated DB starts from the oldest STORED message, so
            //     older history may still be missing — do NOT mark it complete.
            if (db && (direction === 'backward' || (direction === 'forward' && existingCount === 0))) {
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
            if (!job) return;
            this.syncChannelMessages(ch, 'resume', null, null, job.id, withRetry, isShutdownRequested, isPausedFn)
                .catch(err => {
                    this.jobManager.logToJob(job.id, `❌ Unhandled: ${err.message}`);
                    this.jobManager.updateJobStatus(job.id, 'error');
                    if (this.performance) {
                        this.performance.stats.totalErrors++;
                        this.performance.stats.lastError = { message: err.message, timestamp: new Date().toISOString() };
                    }
                });
        });
    }
}
