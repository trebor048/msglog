import { sleepJitter } from './utils.js';

// ============ CIRCUIT BREAKER ============
export class CircuitBreaker {
    constructor(failureThreshold = 5, resetTimeout = 60000) {
        this.failureThreshold = failureThreshold;
        this.resetTimeout = resetTimeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'closed';
    }

    async call(fn) {
        if (this.state === 'open') {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = 'half-open';
            } else {
                throw new Error('Circuit breaker is open');
            }
        }

        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (err) {
            this.recordFailure();
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

    getStatus() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            lastFailureTime: this.lastFailureTime
        };
    }
}

export function createWithRetry(config, circuitBreaker) {
    return async (fn) => {
        let lastErr;
        for (let attempt = 0; attempt < config.retryAttempts; attempt++) {
            try {
                return await circuitBreaker.call(fn);
            } catch (err) {
                lastErr = err;
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
        this.perChannelDelays = new Map();
        this.lastRequestTime = 0;
        this.consecutiveFastRequests = 0;
    }

    async wait(channelId = 'global') {
        const delay = channelId === 'global'
            ? this.config.globalDelay
            : (this.perChannelDelays.get(channelId) ?? this.config.globalDelay);
        const elapsed = Date.now() - this.lastRequestTime;

        if (elapsed < delay) {
            this.consecutiveFastRequests++;
            if (this.consecutiveFastRequests >= this.config.maxFastRequests) {
                this.config.globalDelay = Math.min(this.config.globalDelay * 1.5, 2000);
                this.consecutiveFastRequests = 0;
            }
            await sleepJitter(delay - elapsed);
        } else {
            this.consecutiveFastRequests = Math.max(0, this.consecutiveFastRequests - 1);
        }
        this.lastRequestTime = Date.now();
    }

    updateFromHeaders(channelId, headers) {
        const remaining = parseInt(headers['x-ratelimit-remaining'] ?? '1');
        const resetAfter = parseFloat(headers['x-ratelimit-reset-after'] ?? '0') * 1000;
        if (remaining > 0 && resetAfter > 0) {
            const newDelay = Math.min(Math.max(resetAfter / remaining, 100), 2000);
            if (channelId === 'global') {
                this.config.globalDelay = newDelay;
            } else {
                this.perChannelDelays.set(channelId, newDelay);
            }
        }
    }
}
