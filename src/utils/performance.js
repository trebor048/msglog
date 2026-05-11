export class PerformanceManager {
    constructor() {
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
            lastError: null
        };
    }

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
            uptime: Date.now() - this.stats.startTime
        };
    }
}
