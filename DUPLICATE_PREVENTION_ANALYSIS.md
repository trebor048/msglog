# Duplicate Prevention Analysis

## Database Level Protection

### Primary Key
```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    ...
)
```
- Message ID is PRIMARY KEY
- Discord message IDs are globally unique
- Database enforces uniqueness at schema level

### Insert Statement
```sql
INSERT OR IGNORE INTO messages (id, ...)
VALUES (@id, ...)
```
- Uses `INSERT OR IGNORE`
- If message ID already exists: silently ignored
- If message ID is new: inserted
- **Result**: Impossible to have duplicate IDs in database

---

## Fetch Logic Analysis

### FULL_FORWARD (Oldest → Newest)

**Iteration 1**:
- fetchOptions = { limit: 100 }
- No `after` parameter
- Discord returns: oldest 100 messages
- lastMessageId = messages.last().id (100th message)

**Iteration 2**:
- fetchOptions = { limit: 100, after: lastMessageId }
- Discord returns: 100 messages AFTER the 100th message
- lastMessageId = messages.last().id (200th message)
- **No overlap**: `after` excludes the boundary message

**Iteration N**:
- fetchOptions = { limit: 100, after: lastMessageId }
- Discord returns: next 100 messages
- **No overlap**: Each batch starts after previous batch's last message

**Duplicate Risk**: ❌ NONE - `after` parameter excludes boundary

---

### FULL_BACKWARD (Newest → Oldest)

**Initialization**:
- Fetch newest message: `channel.messages.fetch({ limit: 1 })`
- lastMessageId = newest message ID

**Iteration 1**:
- fetchOptions = { limit: 100, before: lastMessageId }
- Discord returns: 100 messages BEFORE the newest message
- lastMessageId = messages.last().id (100th oldest message in this batch)

**Iteration 2**:
- fetchOptions = { limit: 100, before: lastMessageId }
- Discord returns: 100 messages BEFORE the 100th oldest message
- **No overlap**: `before` excludes the boundary message

**Iteration N**:
- fetchOptions = { limit: 100, before: lastMessageId }
- Discord returns: next 100 messages going backward
- **No overlap**: Each batch starts before previous batch's last message

**Duplicate Risk**: ❌ NONE - `before` parameter excludes boundary

---

### CUSTOM_DATES (Date Range)

**Iteration 1**:
- fetchOptions = { limit: 100 }
- No pagination parameters
- Discord returns: newest 100 messages
- batch = messages filtered by date range
- lastMessageId = messages.last().id (oldest message in Discord's response)

**Iteration 2**:
- fetchOptions = { limit: 100 }
- No pagination parameters
- Discord returns: newest 100 messages AGAIN
- **PROBLEM**: We're fetching the same 100 messages again!

**Root Cause**: Custom dates doesn't use pagination parameters, so Discord always returns the newest 100 messages.

**Duplicate Risk**: ⚠️ HIGH - Same messages fetched repeatedly

---

### LISTEN (Real-Time)

**Flow**:
- Discord emits `messageCreate` event
- Message ID is unique per event
- `INSERT OR IGNORE` prevents duplicates if same message somehow emitted twice

**Duplicate Risk**: ❌ NONE - Discord guarantees unique events, INSERT OR IGNORE as safety net

---

### SYNC_ALL (Parallel)

**Flow**:
- Each channel synced independently with `forward` direction
- Each job uses `after` pagination
- No overlap between channels

**Duplicate Risk**: ❌ NONE - Each channel isolated, `after` prevents overlap

---

### RESUME (Continue from Last)

**Initialization**:
- Query: `SELECT id FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`
- lastMessageId = most recent message ID in database

**Iteration 1**:
- fetchOptions = { limit: 100, after: lastMessageId }
- Discord returns: 100 messages AFTER the most recent in DB
- **No overlap**: `after` excludes the boundary message

**Duplicate Risk**: ❌ NONE - `after` parameter excludes boundary

---

## Critical Issue Found: CUSTOM_DATES

### The Problem

Custom dates doesn't use pagination parameters (`after` or `before`). This means:

```javascript
const fetchOptions = { limit: 100 };
// No after/before parameter!

const messages = await withRetry(() => channel.messages.fetch(fetchOptions));
```

Discord's default behavior when no pagination is specified:
- Returns the **newest 100 messages** in the channel
- Every call returns the same 100 messages
- Filtering by date range doesn't prevent re-fetching

### Example Scenario

**Channel has 500 messages from March 1-30**

**User requests**: Custom date range March 15-20

**Iteration 1**:
- Fetch newest 100 messages (March 21-30)
- Filter by March 15-20: 0 messages
- batch.length = 0
- **Loop breaks immediately**

**Result**: Only fetches newest 100 messages, misses March 1-14

### The Fix

Custom dates needs to use pagination to walk through all messages:

```javascript
// WRONG (current):
const fetchOptions = { limit: 100 };

// CORRECT (should be):
const fetchOptions = { limit: 100 };
if (lastMessageId) {
    fetchOptions.before = lastMessageId;  // Walk backward through all messages
}
```

This way:
1. First fetch: newest 100 messages
2. Filter by date range
3. If any messages in range: continue
4. If no messages in range: continue anyway (might be older messages in range)
5. Use `before` to walk backward through entire channel history

---

## Summary of Duplicate Risks

| Configuration | Risk | Reason |
|---------------|------|--------|
| FULL_FORWARD | ❌ NONE | `after` excludes boundary |
| FULL_BACKWARD | ❌ NONE | `before` excludes boundary |
| CUSTOM_DATES | ⚠️ HIGH | No pagination, fetches same 100 repeatedly |
| LISTEN | ❌ NONE | Unique events + INSERT OR IGNORE |
| SYNC_ALL | ❌ NONE | Per-channel isolation + `after` |
| RESUME | ❌ NONE | `after` excludes boundary |

---

## Database-Level Safety

Even if duplicates somehow get fetched:
- `INSERT OR IGNORE` silently ignores duplicate IDs
- No error thrown
- No data corruption
- Metrics might be slightly off (counts duplicates as new)

**But**: We should fix CUSTOM_DATES to prevent unnecessary re-fetching and incorrect results.

---

## Recommendation

Fix CUSTOM_DATES to use backward pagination (`before`) to walk through entire channel history, filtering by date range as it goes.
