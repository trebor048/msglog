const JOB_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];

export class JobManager {
    constructor() {
        this.activeJobs = new Map();
        this.jobCounter = 0;
        this.totalJobs = 0;
        // Id of the most recently created job. Consumed by the Live Monitor so
        // it can auto-jump to a job started just before the monitor opened.
        this.lastStartedJobId = null;
    }

    createJob(channel, direction, startDate, endDate) {
        // Authoritative guard: never allow two running jobs on the same channel.
        // Concurrent syncs would corrupt channel_sync_state cursors and race on
        // attachment downloads.
        if (this.channelHasActiveJob(channel.id)) return null;
        const jobId = ++this.jobCounter;
        const job = {
            id: jobId,
            // DM channels have no `.name` (null/undefined) — fall back to a
            // readable label so the monitor/details don't render a blank name.
            channel: channel.name || '(DM)',
            channelId: channel.id,
            direction,
            startDate,
            endDate,
            status: 'running',
            color: JOB_COLORS[(jobId - 1) % JOB_COLORS.length],
            logs: [],
            recentMessages: [],
            startTime: Date.now(),
            totalMessages: 0,
            cancelRequested: false,
            // Where this job picks up from (set by the sync engine): the DB
            // entry that comes before the messages this job is adding.
            startingPoint: null
        };
        this.activeJobs.set(jobId, job);
        this.totalJobs++;
        this.lastStartedJobId = jobId;
        return job;
    }

    /**
     * Record the job's starting point — the anchor/DB entry it began from.
     * @param {number} jobId
     * @param {{label: string, id: string|null, description: string}|null} startingPoint
     */
    setJobStartingPoint(jobId, startingPoint) {
        const job = this.activeJobs.get(jobId);
        if (job) job.startingPoint = startingPoint;
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
        if (!message?.author) return;
        const content = (message.content || '').substring(0, 50);
        job.recentMessages.push({
            id: message.id,
            author: message.author.tag,
            content: content,
            timestamp: Date.now()
        });
        if (job.recentMessages.length > 10) job.recentMessages.shift();
    }

    updateJobStatus(jobId, status, totalMessages = null) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        // Terminal statuses are final: a late 'running' update (e.g. from a
        // duplicate sync invocation) must not resurrect a completed/errored
        // job — that would leave channelHasActiveJob true forever and block
        // every future sync on the channel (a 'running' job has no cleanup
        // timer to release it).
        if (status === 'running' && (job.status === 'completed' || job.status === 'error')) return;
        job.status = status;
        if (totalMessages !== null) job.totalMessages = totalMessages;
        if (status !== 'running') {
            job.endTime = Date.now();
            job.duration = job.endTime - job.startTime;
            // Clear any previously scheduled cleanup timer for this job so
            // repeated status updates don't accumulate timers.
            if (job._cleanupTimer) {
                clearTimeout(job._cleanupTimer);
                job._cleanupTimer = null;
            }
            const cleanupTimer = setTimeout(() => this.activeJobs.delete(jobId), 10 * 60 * 1000); // keep for 10 min
            if (typeof cleanupTimer.unref === 'function') {
                cleanupTimer.unref();
            }
            job._cleanupTimer = cleanupTimer;
        }
    }

    setJobError(jobId, errorMessage) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;
        job.error = errorMessage;
    }

    requestCancel(jobId, reason = 'Cancelled by user') {
        const job = this.activeJobs.get(jobId);
        if (!job || job.status !== 'running') return false;
        job.cancelRequested = true;
        this.logToJob(jobId, `🛑 ${reason}`);
        return true;
    }

    isCancelRequested(jobId) {
        const job = this.activeJobs.get(jobId);
        return Boolean(job?.cancelRequested);
    }

    getJob(jobId) {
        return this.activeJobs.get(jobId) || null;
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

    /**
     * Remove a job from the manager entirely.
     * Only non-running jobs can be removed.
     * @param {number} jobId
     * @returns {boolean} true if removed
     */
    removeJob(jobId) {
        const job = this.activeJobs.get(jobId);
        if (!job || job.status === 'running') return false;
        if (job._cleanupTimer) {
            clearTimeout(job._cleanupTimer);
            job._cleanupTimer = null;
        }
        this.activeJobs.delete(jobId);
        return true;
    }
}
