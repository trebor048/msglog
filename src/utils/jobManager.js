const JOB_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];

export class JobManager {
    constructor() {
        this.activeJobs = new Map();
        this.jobCounter = 0;
        this.totalJobs = 0;
    }

    createJob(channel, direction, startDate, endDate) {
        const jobId = ++this.jobCounter;
        const job = {
            id: jobId,
            channel: channel.name,
            channelId: channel.id,
            direction,
            startDate,
            endDate,
            status: 'running',
            color: JOB_COLORS[jobId % JOB_COLORS.length],
            logs: [],
            startTime: Date.now(),
            totalMessages: 0
        };
        this.activeJobs.set(jobId, job);
        this.totalJobs++;
        return job;
    }

    logToJob(jobId, message) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        job.logs.push({ timestamp: Date.now(), message });
        if (job.logs.length > 50) job.logs.shift();
    }

    updateJobStatus(jobId, status, totalMessages = 0) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        job.status = status;
        job.totalMessages = totalMessages;
        if (status !== 'running') {
            job.endTime = Date.now();
            job.duration = job.endTime - job.startTime;
            setTimeout(() => this.activeJobs.delete(jobId), 5 * 60 * 1000);
        }
    }

    channelHasActiveJob(channelId) {
        return [...this.activeJobs.values()].some(j => j.channelId === channelId && j.status === 'running');
    }

    getActiveJobs() {
        return this.activeJobs;
    }

    getAllJobs() {
        return [...this.activeJobs.values()];
    }
}
