import chalk from 'chalk';
import moment from 'moment';
import { sleep, sleepJitter } from './utils.js';

export class SyncEngine {
    constructor(jobManager, messageStore, rateLimiter, config, downloadAttachmentFn, processEmbedsFn) {
        this.jobManager = jobManager;
        this.messageStore = messageStore;
        this.rateLimiter = rateLimiter;
        this.config = config;
        this.downloadAttachmentFn = downloadAttachmentFn;
        this.processEmbedsFn = processEmbedsFn;
    }

    async syncChannelMessages(channel, direction = 'forward', startDate = null, endDate = null, jobId = null, withRetry = null, isShuttingDown = false, isPaused = false) {
        let totalMessages = 0;

        try {
            let lastMessageId = null;

            if (direction === 'backward') {
                try {
                    const newestMessages = await withRetry(() => channel.messages.fetch({ limit: 1 }));
                    lastMessageId = newestMessages.first()?.id;
                } catch (err) {
                    this.jobManager.logToJob(jobId, `⚠️ Could not fetch initial message for backward sync: ${err.message}`);
                }
            } else if (direction === 'resume') {
                const mostRecent = this.messageStore.getMostRecentMessage(channel.id);
                if (!mostRecent) {
                    this.jobManager.logToJob(jobId, '⚠️ No messages in database for this channel, switching to forward sync');
                    direction = 'forward';
                } else {
                    lastMessageId = mostRecent.id;
                    this.jobManager.logToJob(jobId, `📍 Resuming from message ${mostRecent.id} (${new Date(mostRecent.timestamp).toLocaleString()})`);
                }
            }

            const startMoment = direction === 'custom'
                ? (startDate === 'start' ? moment('2015-01-01') : moment(startDate))
                : null;
            const endMoment = direction === 'custom'
                ? (endDate === 'now' ? moment() : moment(endDate))
                : null;

            if (direction === 'custom' && (!startMoment.isValid() || !endMoment.isValid())) {
                this.jobManager.logToJob(jobId, '❌ Invalid date format');
                this.jobManager.updateJobStatus(jobId, 'error');
                return;
            }

            // Check existing messages in database
            const existingCount = this.messageStore.getMessageCount(channel.id);
            if (existingCount > 0) {
                const mostRecent = this.messageStore.getMostRecentMessage(channel.id);
                this.jobManager.logToJob(jobId, `📦 Database has ${existingCount} messages (newest: ${mostRecent ? new Date(mostRecent.timestamp).toLocaleString() : 'unknown'})`);
            }

            this.jobManager.logToJob(jobId, `Started ${direction} fetch for #${channel.name}`);

            while (true) {
                if (isShuttingDown) {
                    this.jobManager.logToJob(jobId, '🛑 Shutdown — job halted');
                    this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                    return;
                }

                if (isPaused) {
                    this.jobManager.logToJob(jobId, '⏸️ Paused...');
                    while (isPaused && !isShuttingDown) await sleep(5000);
                    if (isShuttingDown) {
                        this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
                        return;
                    }
                    this.jobManager.logToJob(jobId, '▶️ Resumed');
                }

                await this.rateLimiter.wait(channel.id);

                const fetchOptions = { limit: 100 };

                if (direction === 'backward' && lastMessageId) {
                    fetchOptions.before = lastMessageId;
                } else if ((direction === 'forward' || direction === 'resume') && lastMessageId) {
                    fetchOptions.after = lastMessageId;
                } else if (direction === 'custom' && lastMessageId) {
                    fetchOptions.before = lastMessageId;
                }

                const messages = await withRetry(() => channel.messages.fetch(fetchOptions));

                if (messages._fetchOptions?.headers)
                    this.rateLimiter.updateFromHeaders(channel.id, messages._fetchOptions.headers);

                let batch = [...messages.values()];
                if (direction === 'custom')
                    batch = batch.filter(m => moment(m.createdAt).isBetween(startMoment, endMoment, null, '[]'));

                if (!batch.length) break;

                // Filter out messages already in database
                const messageIds = batch.map(m => m.id);
                const existingIds = this.messageStore.getExistingMessageIds(channel.id, messageIds);
                const newMessages = batch.filter(m => !existingIds.has(m.id));

                if (newMessages.length === 0) {
                    this.jobManager.logToJob(jobId, `⏭️ All ${batch.length} messages already in database`);
                    lastMessageId = messages.last().id;
                    // Still need to continue fetching in case there are newer messages
                    await sleepJitter(500);
                    continue;
                }

                if (newMessages.length < batch.length) {
                    this.jobManager.logToJob(jobId, `⏭️ Skipped ${batch.length - newMessages.length} existing messages, processing ${newMessages.length} new`);
                }

                lastMessageId = messages.last().id;
                await this.messageStore.storeMessagesBatch(newMessages, channel, withRetry, this.downloadAttachmentFn, this.processEmbedsFn, isShuttingDown);
                totalMessages += newMessages.length;

                this.jobManager.updateJobStatus(jobId, 'running', totalMessages);
                if (totalMessages % 100 === 0) this.messageStore.checkMemoryUsage();
                await sleepJitter(500);
            }

            this.jobManager.logToJob(jobId, `✅ Synced ${totalMessages} messages from #${channel.name}`);
            this.jobManager.updateJobStatus(jobId, 'completed', totalMessages);
        } catch (err) {
            this.jobManager.logToJob(jobId, `❌ Error: ${err.message}`);
            this.jobManager.updateJobStatus(jobId, 'error', totalMessages);
        }
    }

    async syncAllChannelsParallel(client, listeningChannels, withRetry, isShuttingDown) {
        const channels = [...listeningChannels]
            .map(id => client.channels.cache.get(id))
            .filter(Boolean);

        if (!channels.length) {
            console.log(chalk.yellow('No channels to sync'));
            return;
        }

        const availableChannels = channels
            .filter(ch => !this.jobManager.channelHasActiveJob(ch.id))
            .slice(0, this.config.maxConcurrentJobs);

        if (!availableChannels.length) {
            console.log(chalk.yellow('All listening channels already have active jobs'));
            return;
        }

        const jobs = availableChannels.map(ch => {
            const job = this.jobManager.createJob(ch, 'forward', null, null);
            this.syncChannelMessages(ch, 'forward', null, null, job.id, withRetry, isShuttingDown, false).catch(err => {
                console.error(chalk.red(`❌ Job #${job.id} failed: ${err.message}`));
            });
            return job;
        });

        console.log(chalk.cyan(`🚀 Started ${jobs.length} concurrent job(s)`));
    }
}
