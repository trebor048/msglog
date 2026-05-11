import { sleepJitter } from './utils.js';

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
                this.state = 'half-open';
                this.failureCount = 0;
            } else {
                const waitSec = Math.ceil((this.resetTimeout - elapsed) / 1000);
                throw new Error(`Circuit breaker is open (resets in ${waitSec}s)`);
            }
        }

        try {
            const result = await fn();
            if (this.state === 'half-open') this.recordSuccess();
            return result;
        } catch (err) {
            // Don't count rate limits or expected Discord errors as circuit breaker failures.
            // Only count truly unexpected errors (not 429, not network timeouts, not 5xx).
            if (!isTransientError(err)) {
                this.recordFailure();
            }
            throw err;
        }
    }

    recordFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'open';
        }
    }

    recordSuccess() {
        this.failureCount = 0;
        this.state = 'closed';
    }

    reset() {
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'closed';
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

export function createWithRetry(config, circuitBreaker) {
    return async (fn) => {
        let lastErr;

        for (let attempt = 0; attempt < config.retryAttempts; attempt++) {
            try {
                return await circuitBreaker.call(fn);
            } catch (err) {
                lastErr = err;

                // Never retry if circuit breaker is open
                if (err.message.startsWith('Circuit breaker is open')) {
                    throw err;
                }

                // On rate limit, wait the full retry-after before retrying
                if (isTransientError(err) && attempt < config.retryAttempts - 1) {
                    const retryAfter = err?.retryAfter ?? err?.timeout ?? 0;
                    const delay = retryAfter > 0
                        ? retryAfter + 200                                    // respect Discord's retry-after
                        : config.retryBaseDelayMs * Math.pow(2, attempt);    // exponential backoff
                    await sleepJitter(delay);
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
        this.config = config;
        this.globalDelay = config.globalDelay;
        this.perChannelDelays = new Map();
        this.perChannelLastRequestTime = new Map();
        this.lastRequestTime = 0;
        this.consecutiveFastRequests = 0;
    }

    async wait(channelId = 'global') {
        const delay = channelId === 'global'
            ? this.globalDelay
            : (this.perChannelDelays.get(channelId) ?? this.globalDelay);
        const lastTime = channelId === 'global'
            ? this.lastRequestTime
            : (this.perChannelLastRequestTime.get(channelId) ?? 0);
        const elapsed = Date.now() - lastTime;

        if (elapsed < delay) {
            this.consecutiveFastRequests++;
            if (this.consecutiveFastRequests >= this.config.maxFastRequests) {
                this.globalDelay = Math.min(this.globalDelay * 1.5, 2000);
                this.consecutiveFastRequests = 0;
            }
            await sleepJitter(delay - elapsed);
        } else {
            this.consecutiveFastRequests = Math.max(0, this.consecutiveFastRequests - 1);
        }

        const now = Date.now();
        if (channelId === 'global') {
            this.lastRequestTime = now;
        } else {
            this.perChannelLastRequestTime.set(channelId, now);
        }
    }

    updateFromRateLimit(channelId, timeoutMs, global = false) {
        if (!timeoutMs || timeoutMs <= 0) return;
        const delay = Math.min(timeoutMs + 100, 10_000);
        if (global) {
            this.globalDelay = Math.max(this.globalDelay, delay);
        } else {
            this.perChannelDelays.set(
                channelId,
                Math.max(this.perChannelDelays.get(channelId) ?? this.globalDelay, delay)
            );
        }
    }
}
