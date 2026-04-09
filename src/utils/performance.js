import { formatDuration } from './utils.js';

export class PerformanceManager {
    constructor(maxCacheSize = 10000) {
        this.cache = new Map();
        this.accessOrder = [];
        this.maxCacheSize = maxCacheSize;
        this.startTime = Date.now();

        this.stats = {
            totalMessagesFetched: 0,
            totalMessagesStored: 0,
            totalAttachmentsDownloaded: 0,
            totalErrors: 0,
            totalSyncs: 0,
            totalSearches: 0,
            totalExports: 0,
            startTime: Date.now(),
            lastSync: null,
            lastError: null,
            channelStats: new Map(),
            authorStats: new Map()
        };
    }

    // Cache methods
    cacheSet(key, value, ttl = null) {
        if (this.cache.size >= this.maxCacheSize) {
            const oldestKey = this.accessOrder.shift();
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            value,
            ttl: ttl ? Date.now() + ttl : null,
            createdAt: Date.now()
        });

        this.accessOrder.push(key);
    }

    cacheGet(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        if (item.ttl && Date.now() > item.ttl) {
            this.cache.delete(key);
            this.accessOrder = this.accessOrder.filter(k => k !== key);
            return null;
        }

        this.accessOrder = this.accessOrder.filter(k => k !== key);
        this.accessOrder.push(key);
        return item.value;
    }

    cacheHas(key) {
        return this.cacheGet(key) !== null;
    }

    cacheDelete(key) {
        this.cache.delete(key);
        this.accessOrder = this.accessOrder.filter(k => k !== key);
    }

    cacheClear() {
        this.cache.clear();
        this.accessOrder = [];
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            utilization: ((this.cache.size / this.maxCacheSize) * 100).toFixed(2) + '%'
        };
    }

    // Health check
    getHealthStatus(jobManager, circuitBreaker, listeningChannels) {
        return {
            uptime: Date.now() - this.startTime,
            totalMessages: this.stats.totalMessagesFetched,
            totalJobs: this.stats.totalSyncs,
            totalErrors: this.stats.totalErrors,
            activeJobs: jobManager.activeJobs.size,
            circuitBreaker: circuitBreaker.getStatus(),
            memoryUsage: process.memoryUsage(),
            activeChannels: listeningChannels.size
        };
    }

    getStats() {
        return {
            ...this.stats,
            uptime: Date.now() - this.stats.startTime,
            channelStats: Object.fromEntries(this.stats.channelStats),
            authorStats: Object.fromEntries(this.stats.authorStats)
        };
    }

    resetStats() {
        this.stats = {
            totalMessagesFetched: 0,
            totalMessagesStored: 0,
            totalAttachmentsDownloaded: 0,
            totalErrors: 0,
            totalSyncs: 0,
            totalSearches: 0,
            totalExports: 0,
            startTime: Date.now(),
            lastSync: null,
            lastError: null,
            channelStats: new Map(),
            authorStats: new Map()
        };
    }
}
