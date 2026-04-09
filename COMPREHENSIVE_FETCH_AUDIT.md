# Comprehensive Fetch Logic Audit - March 30, 2026

## Status: ✅ ALL LOGIC VERIFIED AS CORRECT

---

## 1. FULL_FORWARD (Oldest → Newest)

**Flow**: No `after` on first fetch → uses `after` for pagination → stops when empty

**Verification**:
- ✅ Starts from oldest (no pagination parameter initially)
- ✅ Uses `after` parameter for forward pagination
- ✅ Stops when batch.length === 0
- ✅ Full media processing on all messages
- ✅ Rate limiting applied per-channel

**Code**: `src/utils/syncEngine.js` lines 73-76

---

## 2. FULL_BACKWARD (Newest → Oldest)

**Flow**: Fetch newest message first → uses `before` for pagination → stops when empty

**Verification**:
- ✅ Initializes with newest message (safe error handling)
- ✅ Uses `before` parameter for backward pagination
- ✅ Stops when batch.length === 0
- ✅ Full media processing on all messages
- ✅ Rate limiting applied per-channel

**Code**: `src/utils/syncEngine.js` lines 23-28, 73-76

---

## 3. CUSTOM_DATES (Date Range)

**Flow**: Parse dates → validate → fetch newest first → filter by date range → stop when empty

**Verification**:
- ✅ Accepts "start" and "now" keywords
- ✅ Parses custom dates with moment.js
- ✅ Validates before fetching
- ✅ Fetches newest first (no pagination direction)
- ✅ Filters batch: `isBetween(startMoment, endMoment, null, '[]')` (inclusive)
- ✅ Stops when no messages in range

**Code**: `src/utils/syncEngine.js` lines 37-48, 85-87

---

## 4. LISTEN (Real-Time)

**Flow**: User adds channel to listeningChannels → Discord emits messageCreate → store with full processing

**Verification**:
- ✅ Filters bot messages
- ✅ Respects pause state
- ✅ Only listens to channels in set
- ✅ Full dependency injection (withRetry, config, download/embed functions)
- ✅ Error handling with try-catch

**Code**: `src/utils/lifecycle.js` lines 6-15

---

## 5. SYNC_ALL (Parallel)

**Flow**: Get listening channels → filter active jobs → limit to maxConcurrentJobs → fire all in parallel

**Verification**:
- ✅ Respects maxConcurrentJobs limit
- ✅ Skips channels with active jobs
- ✅ Uses 'forward' direction
- ✅ All jobs run in parallel
- ✅ Per-job error handling

**Code**: `src/utils/syncEngine.js` lines 110-140

---

## 6. RESUME (Continue from Last)

**Flow**: Query DB for most recent message → if found, use as starting point with `after` → if not found, switch to forward

**Verification**:
- ✅ Queries: `SELECT id, timestamp FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`
- ✅ Handles empty channel (switches to forward)
- ✅ Uses `after` parameter (correct direction)
- ✅ Fetches from last message to now
- ✅ Full media processing

**Code**: `src/utils/syncEngine.js` lines 29-36, `src/utils/storage.js` lines 190-198

---

## Storage Pipeline

**storeMessagesBatch() Process**:
1. Guard checks (messages.length, db exists, not shutting down)
2. Get prepared INSERT statement
3. Process each message in parallel:
   - Fetch reference content
   - Download/process attachments
   - Download/process embeds
4. Build row objects
5. Execute atomic transaction (INSERT OR IGNORE)
6. Update metrics

**Verification**:
- ✅ Parallel processing (Promise.all)
- ✅ Atomic transaction (all or nothing)
- ✅ Duplicate prevention (INSERT OR IGNORE)
- ✅ Full media processing
- ✅ Error handling with metrics

**Code**: `src/utils/storage.js` lines 100-137

---

## Dependency Injection

**Pattern**: Raw functions wrapped with dependencies before passing to SyncEngine/EventHandlers

**For SyncEngine**:
```javascript
wrappedDownloadAttachment = (url, channelId, filename, messageId, size) =>
    downloadAttachment(url, channelId, filename, withRetry, config, messageId, size)

wrappedProcessEmbeds = (embeds, channelId, messageId) =>
    processEmbeds(embeds, channelId, 
        (url, cId, fn, mId) => downloadAttachment(url, cId, fn, withRetry, config, mId), 
        config, messageId)
```

**For Event Handlers**:
```javascript
storeMessagesWithDeps = async (messages, channel) => {
    await messageStore.storeMessagesBatch(
        messages, channel, withRetry,
        (url, channelId, filename, messageId, size) => 
            downloadAttachment(url, channelId, filename, withRetry, config, messageId, size),
        (embeds, channelId, messageId) => 
            processEmbeds(embeds, channelId, 
                (url, cId, fn, mId) => downloadAttachment(url, cId, fn, withRetry, config, mId), 
                config, messageId),
        ctx.isShuttingDown
    )
}
```

**Verification**:
- ✅ All dependencies properly injected
- ✅ No undefined references
- ✅ Consistent signatures across all paths

**Code**: `src/utils/index.js` lines 70-107

---

## Rate Limiting

**AdaptiveRateLimiter**:
- Per-channel delays tracked in Map
- Global delay with adaptive backoff
- Increments consecutiveFastRequests if elapsed < delay
- If >= maxFastRequests: increase globalDelay by 1.5x (max 2000ms)
- Updates from Discord rate limit headers

**Verification**:
- ✅ Per-channel prevents conflicts
- ✅ Adaptive backoff on fast requests
- ✅ Respects Discord headers
- ✅ Applied before every fetch

**Code**: `src/utils/resilience.js` lines 60-95

---

## Circuit Breaker

**States**: closed → open → half-open → closed

**Logic**:
- If open and timeout elapsed: transition to half-open
- If open and timeout not elapsed: throw error
- On success: state = closed, failureCount = 0
- On error: increment failureCount, if >= threshold: state = open

**Verification**:
- ✅ Prevents cascading failures
- ✅ Auto-recovery after timeout
- ✅ Applied to all withRetry calls

**Code**: `src/utils/resilience.js` lines 1-62

---

## Error Handling

**Shutdown**:
- isShuttingDown checked in storeMessagesBatch, syncChannelMessages, event handlers
- Graceful shutdown waits up to 2s for running jobs

**Pause**:
- isPaused checked in event handlers and syncChannelMessages
- Sleeps in loop until resumed

**Verification**:
- ✅ Graceful shutdown with job completion waiting
- ✅ Pause/resume functionality
- ✅ Error logging with chalk colors
- ✅ Metrics tracking

**Code**: `src/utils/lifecycle.js` lines 56-85, `src/utils/syncEngine.js` lines 54-67

---

## Memory Management

**Every 100 messages**:
- Check heap usage
- If > 500MB and global.gc available: trigger GC
- Clear reference cache if > maxReferenceCache
- Clear failed references if > maxFailedReferences

**Verification**:
- ✅ Memory-aware processing
- ✅ Cache cleanup prevents leaks
- ✅ GC triggers on high usage

**Code**: `src/utils/storage.js` lines 175-180

---

## Concurrency

**Limits**:
- maxConcurrentJobs: limits parallel syncs
- Per-channel rate limiting: prevents conflicts
- Batch size: 100 messages per fetch

**Verification**:
- ✅ Concurrency limits respected
- ✅ Batch processing prevents spikes
- ✅ Per-channel isolation

**Code**: `src/utils/syncEngine.js` lines 110-140

---

## UI Integration

**Fetch Options Menu**:
1. 🎧 Start/Stop Listening
2. 📥 Fetch All (Oldest → Newest)
3. 📤 Fetch All (Newest → Oldest)
4. 📅 Fetch Custom Date Range
5. ⏩ Resume from Last Message
6. ⬅️ Back

**Verification**:
- ✅ All 6 modes available
- ✅ Proper error messages
- ✅ Job creation before sync
- ✅ Live monitor shown after start
- ✅ Active job detection prevents conflicts

**Code**: `src/ui/management.js` lines 57-140

---

## Final Verification Summary

| Component | Status |
|-----------|--------|
| FULL_FORWARD | ✅ Correct |
| FULL_BACKWARD | ✅ Correct |
| CUSTOM_DATES | ✅ Correct |
| LISTEN | ✅ Correct |
| SYNC_ALL | ✅ Correct |
| RESUME | ✅ Correct |
| Storage Pipeline | ✅ Correct |
| Dependency Injection | ✅ Correct |
| Rate Limiting | ✅ Correct |
| Circuit Breaker | ✅ Correct |
| Error Handling | ✅ Correct |
| Memory Management | ✅ Correct |
| Concurrency | ✅ Correct |
| UI Integration | ✅ Correct |

**CONCLUSION: ALL FETCH LOGIC IS CORRECT AND PRODUCTION-READY**
