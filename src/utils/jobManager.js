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
            recentMessages: [],
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
        if (job.logs.length > 200) job.logs.shift();
    }

    addMessageToJob(jobId, message) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        const content = (message.content || '').substring(0, 50);
        job.recentMessages.push({
            id: message.id,
            author: message.author.tag,
            content: content,
            timestamp: Date.now()
        });
        if (job.recentMessages.length > 10) job.recentMessages.shift();
    }

    updateJobStatus(jobId, status, totalMessages = 0) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        job.status = status;
        job.totalMessages = totalMessages;
        if (status !== 'running') {
            job.endTime = Date.now();
            job.duration = job.endTime - job.startTime;
            setTimeout(() => this.activeJobs.delete(jobId), 10 * 60 * 1000); // keep for 10 min
        }
    }

    setJobError(jobId, errorMessage) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        job.error = errorMessage;
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
