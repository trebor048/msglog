import blessed from 'blessed';
import { formatDuration, Validator } from '../../utils/utils.js';

/**
 * Channel Management Screen
 * Manages listening channels and sync jobs
 */
export class ChannelScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this._activePrompt = null;
        this._resizeHandler = null;

        this.create();
    }

    create() {
        // Main container
        this.widgets.main = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: '100%',
            style: { bg: 'black', fg: 'white' }
        });

        // Header — plain text, no tags needed (updated dynamically)
        this.widgets.header = blessed.box({
            parent: this.widgets.main,
            top: 0, left: 0, width: '100%', height: 1,
            style: { bg: 'blue', fg: 'white', bold: true },
            content: ' CHANNEL MANAGEMENT'
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' UP/DOWN Navigate  ENTER Select  ? Help  ESC/Q Back'
        });

        this._resizeHandler = () => {
            if (this.widgets.list && !this.widgets.list.destroyed) {
                this.widgets.list.height = this.screen.height - 3;
            }
            this.screen.render();
        };
        this.screen.on('resize', this._resizeHandler);

        this.showGuildList();
    }

    showGuildList() {
        this._destroyActivePrompt();
        if (this.widgets.list) this.widgets.list.destroy();

        // Header is plain text — no tags
        this.widgets.header.setContent(' SELECT GUILD');

        const guilds = [...new Set(
            [...this.ctx.client.channels.cache.values()]
                .filter(c => c.type === 'GUILD_TEXT' && c.viewable)
                .map(c => c.guild)
        )].sort((a, b) => a.name.localeCompare(b.name));

        // Items are plain strings — no tags
        const items = guilds.map(g => {
            const count = g.channels.cache.filter(c => c.type === 'GUILD_TEXT' && c.viewable).size;
            return Validator.sanitizeBlessedTags(`${g.name} (${count} channels)`);
        });
        items.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        items.push('Back');

        // List widget — tags:true only for label
        this.widgets.list = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Guilds ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items
        });

        this.widgets.list.focus();
        this.screen.render();

        this.widgets.list.on('select', (item, index) => {
            if (index === guilds.length + 1) { this.onBack(); return; }
            if (index === guilds.length) return; // separator
            this.showChannelList(guilds[index]);
        });

        this.widgets.list.key(['escape', 'q'], () => this.onBack());
    }

    showChannelList(guild) {
        this._destroyActivePrompt();
        if (this.widgets.list) this.widgets.list.destroy();

        // Header is plain text — no tags
        this.widgets.header.setContent(` GUILD: ${Validator.sanitizeBlessedTags(guild.name).toUpperCase()}`);

        const channels = [...guild.channels.cache.values()]
            .filter(c => c.type === 'GUILD_TEXT' && c.viewable)
            .sort((a, b) => a.name.localeCompare(b.name));

        // Items are plain strings — no tags
        const items = channels.map(c => {
            const listening = this.ctx.listeningChannels.has(c.id);
            return `${listening ? '[ON]' : '[OFF]'} #${Validator.sanitizeBlessedTags(c.name)}`;
        });
        
        const separator = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
        items.push(separator);
        items.push('{bold}Listen All Channels{/bold}');
        items.push('{bold}Stop All Channels{/bold}');
        items.push(separator);
        items.push('Back to Guilds');

        // List widget — tags:true for formatting
        this.widgets.list = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Channels ',
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items
        });

        this.widgets.list.focus();
        this.screen.render();

        this.widgets.list.on('select', (item, index) => {
            if (index === channels.length + 4) { this.showGuildList(); return; }
            if (index === channels.length || index === channels.length + 3) return; // separator
            
            if (index === channels.length + 1) { // Listen All
                this.handleGuildAction(guild, channels, 'LISTEN_ALL');
                return;
            }
            if (index === channels.length + 2) { // Stop All
                this.handleGuildAction(guild, channels, 'STOP_ALL');
                return;
            }

            this.showFetchOptions(channels[index]);
        });

        this.widgets.list.key(['escape', 'q'], () => this.showGuildList());
    }

    handleGuildAction(guild, channels, action) {
        if (action === 'LISTEN_ALL') {
            this.promptPersistence((persist) => {
                const before = new Set(this.ctx.listeningChannels);
                channels.forEach(c => this.ctx.listeningChannels.add(c.id));
                const saved = !persist || !this.ctx.dbManager
                    ? true
                    : this.ctx.dbManager.saveListeningChannels(this.ctx.listeningChannels);
                if (!saved) {
                    // Persist failed — revert in place (never reassign: the
                    // live event handlers hold this exact Set by reference)
                    // so the UI doesn't claim channels are listened-to when
                    // a restart would drop them.
                    channels.forEach(c => { if (!before.has(c.id)) this.ctx.listeningChannels.delete(c.id); });
                    this.showMessage(
                        '{red-fg}Failed to save — listen state unchanged{/red-fg}',
                        () => this.showChannelList(guild)
                    );
                    return;
                }
                this.showChannelList(guild);
            });
        } else if (action === 'STOP_ALL') {
            const before = new Set(this.ctx.listeningChannels);
            channels.forEach(c => this.ctx.listeningChannels.delete(c.id));
            const saved = !this.ctx.dbManager
                ? true
                : this.ctx.dbManager.saveListeningChannels(this.ctx.listeningChannels);
            if (!saved) {
                // Persist failed — restore in place (same reference the live
                // event handlers hold) so the UI doesn't lie about the state.
                before.forEach(id => this.ctx.listeningChannels.add(id));
                this.showMessage(
                    '{red-fg}Failed to save — listen state unchanged{/red-fg}',
                    () => this.showChannelList(guild)
                );
                return;
            }
            this.showChannelList(guild);
        }
    }

    showFetchOptions(channel) {
        this._destroyActivePrompt();
        if (this.widgets.list) this.widgets.list.destroy();

        const isListening = this.ctx.listeningChannels.has(channel.id);
        const existingJob = [...this.ctx.jobManager.activeJobs.values()]
            .find(j => j.channelId === channel.id && j.status === 'running');

        // Header is plain text — no tags
        this.widgets.header.setContent(` CHANNEL: #${Validator.sanitizeBlessedTags(channel.name).toUpperCase()}`);

        // Items are plain strings — no tags
        const items = [];
        const actions = [];

        if (existingJob) {
            items.push(`Job #${existingJob.id} (${existingJob.totalMessages} msgs) - View`);
            actions.push('VIEW_JOB');
        }

        items.push(isListening ? 'Stop Listening' : 'Start Listening');
        actions.push('LISTEN');
        items.push('Fetch All (Newest → Oldest)');
        actions.push('FULL_BACKWARD');
        items.push('Fetch All (Oldest → Newest)');
        actions.push('FULL_FORWARD');
        items.push('Custom Date Range');
        actions.push('CUSTOM_DATES');
        items.push('Resume (fetch new messages since last sync)');
        actions.push('RESUME');
        items.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        actions.push('SEP');
        items.push('Back to Channels');
        actions.push('BACK');

        // List widget — tags:true only for label
        this.widgets.list = blessed.list({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ` Options [${isListening ? 'LISTENING' : 'OFF'}] `,
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true,
            items
        });

        this.widgets.list.focus();
        this.screen.render();

        this.widgets.list.on('select', (item, index) => {
            this.handleFetchAction(actions[index], channel, existingJob);
        });

        this.widgets.list.key(['escape', 'q'], () => this.showChannelList(channel.guild));
    }

    handleFetchAction(action, channel, existingJob) {
        if (action === 'SEP') return;

        switch (action) {
            case 'VIEW_JOB':
                this.showJobDetails(existingJob, channel);
                break;
            case 'LISTEN':
                if (this.ctx.listeningChannels.has(channel.id)) {
                    this.ctx.listeningChannels.delete(channel.id);
                    const saved = !this.ctx.dbManager
                        ? true
                        : this.ctx.dbManager.saveListeningChannels(this.ctx.listeningChannels);
                    if (!saved) {
                        // Persist failed — restore in place (live handlers hold
                        // this Set by reference) instead of showing LISTENING
                        // for a change a restart would drop.
                        this.ctx.listeningChannels.add(channel.id);
                        this.showMessage(
                            '{red-fg}Failed to save — still listening{/red-fg}',
                            () => this.showFetchOptions(channel)
                        );
                    } else {
                        this.showFetchOptions(channel);
                    }
                } else {
                    this.promptPersistence((persist) => {
                        this.ctx.listeningChannels.add(channel.id);
                        const saved = !persist || !this.ctx.dbManager
                            ? true
                            : this.ctx.dbManager.saveListeningChannels(this.ctx.listeningChannels);
                        if (!saved) {
                            this.ctx.listeningChannels.delete(channel.id);
                            this.showMessage(
                                '{red-fg}Failed to save — not listening{/red-fg}',
                                () => this.showFetchOptions(channel)
                            );
                        } else {
                            this.showFetchOptions(channel);
                        }
                    });
                }
                break;
            case 'FULL_FORWARD':
            case 'FULL_BACKWARD':
            case 'RESUME':
                if (this.ctx.jobManager.channelHasActiveJob(channel.id)) {
                    this.showMessage(
                        '{yellow-fg}Channel already has an active job{/yellow-fg}',
                        () => this.showFetchOptions(channel)
                    );
                    return;
                }
                this.startFetchJob(
                    channel,
                    action === 'FULL_FORWARD' ? 'forward' : action === 'FULL_BACKWARD' ? 'backward' : 'resume'
                );
                break;
            case 'CUSTOM_DATES':
                if (this.ctx.jobManager.channelHasActiveJob(channel.id)) {
                    this.showMessage(
                        '{yellow-fg}Channel already has an active job{/yellow-fg}',
                        () => this.showFetchOptions(channel)
                    );
                    return;
                }
                this.promptCustomDates(channel);
                break;
            case 'BACK':
                this.showChannelList(channel.guild);
                break;
        }
    }

    promptPersistence(callback) {
        this._destroyActivePrompt();
        const question = blessed.question({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '50%', height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ' Persistence ',
            tags: true
        });
        this._activePrompt = question;

        question.ask('Should this selection persist across restarts?', (err, value) => {
            // blessed hides the question on completion but does NOT destroy it —
            // destroy explicitly to avoid a per-prompt widget leak.
            try { question.destroy(); } catch {}
            this._activePrompt = null;
            if (value) {
                callback(true);
            } else {
                callback(false);
            }
        });
    }

    startFetchJob(channel, direction) {
        const job = this.ctx.jobManager.createJob(channel, direction, null, null);
        if (!job) {
            // createJob refuses duplicates — a job for this channel is already running
            this.showMessage(
                '{yellow-fg}Channel already has an active job{/yellow-fg}',
                () => this.showFetchOptions(channel)
            );
            return;
        }
        this.ctx.syncEngine.syncChannelMessages(
            channel, direction, null, null, job.id,
            this.ctx.withRetry, () => this.ctx.isShuttingDown, () => this.ctx.isPaused
        ).catch(err => {
            // Guard against rejections escaping the sync engine's internal try/catch
            this.ctx.jobManager.logToJob(job.id, `❌ Unhandled: ${err?.message ?? err}`);
            this.ctx.jobManager.updateJobStatus(job.id, 'error');
        });
        const desc = direction === 'forward'
            ? 'Oldest → Newest'
            : direction === 'backward'
            ? 'Newest → Oldest'
            : 'Resuming from last sync';
        this.showMessage(
            `{green-fg}Job #${job.id} started!{/green-fg}\n ${Validator.sanitizeBlessedTags(desc)} on #${Validator.sanitizeBlessedTags(channel.name)}\n\n{gray-fg}Open the Live Monitor (Ctrl+L) — it will jump straight to this job and show where it starts from.{/gray-fg}`,
            () => this.onBack()
        );
    }

    promptCustomDates(channel) {
        this._destroyActivePrompt();
        const input = blessed.textbox({
            parent: this.widgets.main,
            top: 'center', left: 'center',
            width: '60%', height: 3,
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
            label: ' Start date (YYYY-MM-DD or "start"): ',
            inputOnFocus: true,
            keys: true,
            mouse: true
        });
        this._activePrompt = input;

        input.setValue('start');
        input.focus();
        this.screen.render();

        input.key('enter', () => {
            const startDate = input.getValue();
            input.destroy();
            this._activePrompt = null;
            this.screen.render();
            if (!startDate) { this.showFetchOptions(channel); return; }

            const input2 = blessed.textbox({
                parent: this.widgets.main,
                top: 'center', left: 'center',
                width: '60%', height: 3,
                border: { type: 'line' },
                style: { border: { fg: 'yellow' }, bg: 'black', fg: 'white' },
                label: ' End date (YYYY-MM-DD or "now"): ',
                inputOnFocus: true,
                keys: true,
                mouse: true
            });
            this._activePrompt = input2;

            input2.setValue('now');
            input2.focus();
            this.screen.render();

            input2.key('enter', () => {
                const endDate = input2.getValue();
                input2.destroy();
                this._activePrompt = null;
                this.screen.render();
                if (!endDate) { this.showFetchOptions(channel); return; }
                // Re-check: autoSync may have started a job while the user typed dates
                const job = this.ctx.jobManager.createJob(channel, 'custom', startDate.trim(), endDate.trim());
                if (!job) {
                    this.showMessage(
                        '{yellow-fg}Channel already has an active job{/yellow-fg}',
                        () => this.showFetchOptions(channel)
                    );
                    return;
                }
                this.ctx.syncEngine.syncChannelMessages(
                    channel, 'custom', startDate.trim(), endDate.trim(), job.id,
                    this.ctx.withRetry, () => this.ctx.isShuttingDown, () => this.ctx.isPaused
                ).catch(err => {
                    this.ctx.jobManager.logToJob(job.id, `❌ Unhandled: ${err?.message ?? err}`);
                    this.ctx.jobManager.updateJobStatus(job.id, 'error');
                });
                this.showMessage(
                    `{green-fg}Custom job #${job.id} started!{/green-fg}\n From ${Validator.sanitizeBlessedTags(startDate.trim())} to ${Validator.sanitizeBlessedTags(endDate.trim())}\n\n{gray-fg}Open the Live Monitor (Ctrl+L) — it will jump straight to this job.{/gray-fg}`,
                    () => this.onBack()
                );
            });

            input2.key('escape', () => {
                input2.destroy();
                this._activePrompt = null;
                this.screen.render();
                this.showFetchOptions(channel);
            });
        });

        input.key('escape', () => {
            input.destroy();
            this._activePrompt = null;
            this.screen.render();
            this.showFetchOptions(channel);
        });
    }

    // showJobDetails uses a box with tags:true for colored content
    showJobDetails(job, channel) {
        if (this.widgets.list) this.widgets.list.destroy();

        let c = `\n{cyan-fg}{bold}Job #${job.id}{/bold}{/cyan-fg} — #${Validator.sanitizeBlessedTags(channel.name)}\n`;
        c += `{gray-fg}` + '─'.repeat(40) + `{/gray-fg}\n\n`;
        c += ` Status:   {bold}${job.status}{/bold}\n`;
        c += ` Progress: {green-fg}${job.totalMessages}{/green-fg} messages\n`;
        c += ` Duration: {white-fg}${formatDuration(Date.now() - job.startTime)}{/white-fg}\n`;
        if (job.startingPoint?.description) {
            c += ` Starting: {cyan-fg}${Validator.sanitizeBlessedTags(job.startingPoint.description).slice(0, 80)}{/cyan-fg}\n`;
        }

        if (job.logs && job.logs.length) {
            c += `\n{cyan-fg}Recent Logs:{/cyan-fg}\n`;
            job.logs.slice(-5).forEach(log => {
                const ts = log?.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
                const message = Validator.sanitizeBlessedTags(String(log?.message ?? ''));
                c += ` {gray-fg}${ts}{/gray-fg} ${message}\n`;
            });
        }

        // Box with tags:true for colored content
        this.widgets.list = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            style: { border: { fg: 'blue' } },
            content: c
        });

        this.widgets.list.key(['escape', 'q', 'enter'], () => this.showFetchOptions(channel));
        this.widgets.list.focus();
        this.screen.render();
    }

    // showMessage uses a box with tags:true for colored content
    showMessage(msg, callback) {
        if (this.widgets.list) this.widgets.list.destroy();

        // Box with tags:true for colored content
        this.widgets.list = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            style: { border: { fg: 'blue' } },
            content: `\n ${msg}\n\n{gray-fg}Press Enter to continue{/gray-fg}`
        });

        this.widgets.list.key(['enter', 'escape', 'q'], () => callback());
        this.widgets.list.focus();
        this.screen.render();
    }

    destroy() {
        if (this._resizeHandler) this.screen.removeListener('resize', this._resizeHandler);
        this._destroyActivePrompt();
        if (this.widgets.list) this.widgets.list.destroy();
        if (this.widgets.main) this.widgets.main.destroy();
    }

    _destroyActivePrompt() {
        if (this._activePrompt) {
            try { this._activePrompt.destroy(); } catch {}
            this._activePrompt = null;
        }
    }
}

export default ChannelScreen;
