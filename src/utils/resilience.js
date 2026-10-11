import { sleep, sleepJitter } from './utils.js';

// ============ CIRCUIT BREAKER ============
// Only trips on persistent/unexpected errors, NOT on rate limits or transient Discord errors.
export class CircuitBreaker {
    constructor(failureThreshold = 10, resetTimeout = 60000) {
        this.failureThreshold = failureThreshold;
        this.resetTimeout = resetTimeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'closed'; // 'closed' | 'open' | 'half-open'
    }

    async call(fn) {
        if (this.state === 'open') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed > this.resetTimeout) {
                // Single-flight probe: only one caller transitions to half-open.
                this.state = 'half-open';
                this.failureCount = 0;
                // Announce the probe so concurrent callers wait for it instead
                // of stampeding fn() in parallel.
                this._probePromise = this._runProbe(fn);
            } else {
                const waitSec = Math.ceil((this.resetTimeout - elapsed) / 1000);
                throw new Error(`Circuit breaker is open (resets in ${waitSec}s)`);
            }
        }

        // If a probe is in flight (state is half-open and a probe promise is
        // pending), wait for its result rather than firing another fn().
        if (this.state === 'half-open' && this._probePromise) {
            const result = await this._probePromise;
            return result;
        }

        try {
            const result = await fn();
            if (this.state === 'half-open') this.recordSuccess();
            return result;
        } catch (err) {
            // Don't count rate limits, expected client errors (deleted resources),
            // or transient errors against the breaker.
            if (!isTransientError(err) && !isExpectedError(err)) {
                this.recordFailure();
            }
            throw err;
        }
    }

    // The single probe call itself: runs fn once and settles the breaker.
    // A timeout guard prevents a hung probe from deadlocking every caller.
    async _runProbe(fn) {
        const probeTimeout = 10_000;
        let timer = null;
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Circuit breaker probe timed out')), probeTimeout);
                    if (typeof timer.unref === 'function') timer.unref();
                })
            ]);
            clearTimeout(timer);
            this.recordSuccess();
            this._probePromise = null;
            return result;
        } catch (err) {
            clearTimeout(timer);
            this._probePromise = null;
            // Any probe failure (transient or not) reopens the breaker. If the
            // probe's dependency is still unhealthy, staying half-open with a
            // null probe would let every concurrent caller stampede fn(). Only a
            // successful probe closes the breaker.
            this.state = 'open';
            this.lastFailureTime = Date.now();
            throw err;
        }
    }

    recordFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'open';
        }
        this._probePromise = null;
    }

    recordSuccess() {
        this.failureCount = 0;
        this.state = 'closed';
        this._probePromise = null;
    }

    reset() {
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'closed';
        this._probePromise = null;
    }

    getStatus() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            lastFailureTime: this.lastFailureTime
        };
    }
}

/**
 * Returns true for errors that are expected/transient and should NOT
 * count against the circuit breaker failure threshold.
 */
function isTransientError(err) {
    const msg = err?.message ?? '';
    const status = err?.status ?? err?.httpStatus ?? 0;

    // Discord rate limit (429)
    if (status === 429) return true;
    if (msg.includes('rate limit') || msg.includes('ratelimit') || msg.includes('Rate limit')) return true;

    // Discord server errors (5xx) — transient
    if (status >= 500 && status < 600) return true;

    // Network / timeout errors — transient
    if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) return true;
    if (msg.includes('network') || msg.includes('timeout') || msg.includes('socket')) return true;

    // Discord.js specific transient errors
    if (msg.includes('CloudFlare') || msg.includes('cloudflare')) return true;
    if (msg.includes('UND_ERR') || msg.includes('fetch failed')) return true;

    return false;
}

/**
 * Returns true for expected client errors (4xx other than 429). These are
 * permanent outcomes (e.g. a deleted/nonexistent message returning 403/404)
 * that should NOT trip the circuit breaker — the breaker must not block bulk
 * attachment downloads just because a few references were deleted.
 */
function isExpectedError(err) {
    const status = err?.status ?? err?.httpStatus ?? 0;
    return status >= 400 && status < 500 && status !== 429;
}

export function createWithRetry(config, circuitBreaker) {
    return async (fn) => {
        let lastErr;

        for (let attempt = 0; attempt < config.retryAttempts; attempt++) {
            try {
                return await circuitBreaker.call(fn);
            } catch (err) {
                lastErr = err;
                const errMessage = typeof err?.message === 'string' ? err.message : '';

                // Never retry if circuit breaker is open
                if (errMessage.startsWith('Circuit breaker is open')) {
                    throw err;
                }

                // Never retry permanent client errors (403/404/etc.) — they will
                // always fail.
                if (isExpectedError(err)) {
                    throw err;
                }

                // On rate limit, wait the full retry-after before retrying
                if (isTransientError(err) && attempt < config.retryAttempts - 1) {
                    const retryAfter = err?.retryAfter ?? err?.timeout ?? 0;
                    const delay = retryAfter > 0
                        ? retryAfter + 200                                    // respect Discord's retry-after
                        : config.retryBaseDelayMs * Math.pow(2, attempt);    // exponential backoff
                    if (retryAfter > 0) await sleep(delay);
                    else await sleepJitter(delay);
                    continue;
                }

                // Non-transient error: backoff and retry
                if (attempt < config.retryAttempts - 1) {
                    const delay = config.retryBaseDelayMs * Math.pow(2, attempt);
                    await sleepJitter(delay);
                }
            }
        }

        throw lastErr;
    };
}

// ============ ADAPTIVE RATE LIMITER ============
export class AdaptiveRateLimiter {
    constructor(config) {
        // Numeric config is user-editable (config.json) — guard every value
        // against NaN/Infinity (a NaN delay poisons the _nextAllowed slot math
        // and silently disables pacing; a NaN LRU cap disables pruning).
        const finite = (v, dflt) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : dflt;
        };
        this.config = config;
        this.globalDelay = Math.max(0, finite(config.globalDelay, 1500));
        // Sanitized baseline used to recover globalDelay after escalations —
        // never read the raw config there (it may be NaN).
        this.globalDelayBaseline = this.globalDelay;
        this.randomDelayMin = Math.max(0, finite(config.randomDelayMin, 0));
        this.randomDelayMax = Math.max(this.randomDelayMin, finite(config.randomDelayMax, this.randomDelayMin));
        this.maxRateLimitChannels = Math.max(100, finite(config.maxRateLimitChannels, 10000));
        this.maxFastRequests = Math.max(1, finite(config.maxFastRequests, 10));
        // Fast (bulk historical sync) pacing baseline, sanitized to >= 50ms.
        this.syncRequestDelayMs = Math.max(50, finite(config.syncRequestDelayMs, 300));
        this.perChannelDelays = new Map();
        this.perChannelLastRequestTime = new Map();
        this.channelLru = new Map();
        this.lastRequestTime = 0;
        this.consecutiveFastRequests = 0;
    }

    _touchChannel(channelId) {
        if (!channelId || channelId === 'global') return;
        if (this.channelLru.has(channelId)) {
            this.channelLru.delete(channelId);
        }
        this.channelLru.set(channelId, Date.now());
        this._pruneChannelState();
    }

    _pruneChannelState() {
        while (this.channelLru.size > this.maxRateLimitChannels) {
            const oldest = this.channelLru.keys().next().value;
            if (oldest === undefined) break;
            this.channelLru.delete(oldest);
            this.perChannelDelays.delete(oldest);
            this.perChannelLastRequestTime.delete(oldest);
            this.perChannelFastRequests?.delete(oldest);
            this._nextAllowed?.delete(oldest);
        }
    }

    _randomDelayMs() {
        if (this.randomDelayMax <= this.randomDelayMin) return this.randomDelayMin;
        return Math.floor(Math.random() * (this.randomDelayMax - this.randomDelayMin + 1)) + this.randomDelayMin;
    }

    _computeWaitDuration(delay, elapsed, fast) {
        const baseWait = Math.max(0, delay - elapsed);
        if (baseWait <= 0) return 0;
        // Fast (bulk historical sync) pacing uses a small jitter instead of the
        // configured random-delay band, which would otherwise floor every request
        // at randomDelayMin and cripple catch-up speed.
        return fast ? baseWait + Math.floor(Math.random() * 81) : baseWait + this._randomDelayMs();
    }

    async wait(channelId = 'global', opts = {}) {
        // `fast` = bulk historical sync pacing: base the per-channel delay on
        // syncRequestDelayMs instead of the conservative global delay, skip the
        // heuristic escalation (real 429s drive backoff via updateFromRateLimit),
        // and recover toward the fast baseline after a 429.
        const fast = Boolean(opts?.fast);
        const baseDelay = fast ? this.syncRequestDelayMs : this.globalDelay;
        const delay = channelId === 'global'
            ? this.globalDelay
            : (this.perChannelDelays.get(channelId) ?? baseDelay);
        const lastTime = channelId === 'global'
            ? this.lastRequestTime
            : (this.perChannelLastRequestTime.get(channelId) ?? 0);
        const elapsed = Date.now() - lastTime;

        // Per-channel fast-request tracking so a burst on one channel doesn't
        // inflate the shared global delay (which punishes every channel).
        if (channelId !== 'global' && !this.perChannelFastRequests) this.perChannelFastRequests = new Map();
        const fastKey = channelId === 'global' ? 'global' : channelId;

        let waitMs;
        if (elapsed < delay) {
            const fastCount = channelId === 'global'
                ? ++this.consecutiveFastRequests
                : ((this.perChannelFastRequests.get(fastKey) ?? 0) + 1);
            if (channelId !== 'global') this.perChannelFastRequests.set(fastKey, fastCount);
            if (fastCount >= this.maxFastRequests) {
                if (channelId === 'global') {
                    this.globalDelay = Math.min(this.globalDelay * 1.5, 2000);
                    this.consecutiveFastRequests = 0;
                } else {
                    // In fast mode, don't heuristically escalate — real Discord
                    // 429s are the correct brake (updateFromRateLimit raises the
                    // per-channel delay and recovery brings it back down).
                    if (!fast) {
                        // Escalate this channel's delay, not the global one
                        this.perChannelDelays.set(
                            channelId,
                            Math.min((this.perChannelDelays.get(channelId) ?? this.globalDelay) * 1.5, 2000)
                        );
                        this._touchChannel(channelId);
                    }
                    this.perChannelFastRequests.set(fastKey, 0);
                }
            }
            waitMs = this._computeWaitDuration(delay, elapsed, fast);
        } else {
            if (channelId === 'global') {
                this.consecutiveFastRequests = Math.max(0, this.consecutiveFastRequests - 1);
                // Slowly recover globalDelay toward the configured baseline when idle
                const recoveryTarget = this.globalDelayBaseline;
                if (this.globalDelay > recoveryTarget) {
                    this.globalDelay = Math.max(recoveryTarget, this.globalDelay * 0.98);
                }
            } else {
                this.perChannelFastRequests.set(fastKey, Math.max(0, (this.perChannelFastRequests.get(fastKey) ?? 0) - 1));
                // Recover this channel's delay toward the active baseline
                const target = baseDelay;
                const cur = this.perChannelDelays.get(channelId);
                if (cur !== undefined && cur > target) {
                    this.perChannelDelays.set(channelId, Math.max(target, cur * 0.98));
                }
            }
            waitMs = 0;
        }

        // Reserve the slot BEFORE sleeping so concurrent waiters on the same
        // channel serialize: this caller fires at fireTime and reserves the next
        // slot exactly one `delay` later, so a concurrent caller waits its turn
        // instead of firing back-to-back. When idle (waitMs===0) the first call
        // still fires immediately but reserves the slot for the next caller.
        const reserveKey = channelId === 'global' ? 'global' : channelId;
        if (!this._nextAllowed) this._nextAllowed = new Map();
        const now = Date.now();
        const prev = this._nextAllowed.get(reserveKey) ?? 0;
        const fireTime = Math.max(now + waitMs, prev);
        this._nextAllowed.set(reserveKey, fireTime + Math.max(delay, waitMs));
        const effectiveWait = Math.max(0, fireTime - now);
        if (effectiveWait > 0) await sleep(effectiveWait);

        const doneAt = Date.now();
        if (channelId === 'global') {
            this.lastRequestTime = doneAt;
        } else {
            this.perChannelLastRequestTime.set(channelId, doneAt);
            this._touchChannel(channelId);
        }
    }

    updateFromRateLimit(channelId, timeoutMs, global = false) {
        const t = Number(timeoutMs);
        if (!Number.isFinite(t) || t <= 0) return;
        const delay = Math.min(t + 100, 10_000);
        if (global) {
            this.globalDelay = Math.max(this.globalDelay, delay);
        } else {
            // Discord's retry-after is authoritative — don't floor the delay at
            // globalDelay, or a single 429 during a fast catch-up would over-brake
            // the channel to the conservative global pace (e.g. 1500ms) for
            // minutes until recovery. Recovery in wait() decays it back toward
            // the active (possibly fast) baseline.
            this.perChannelDelays.set(
                channelId,
                Math.max(this.perChannelDelays.get(channelId) ?? 0, delay)
            );
            this._touchChannel(channelId);
        }
    }
}
