import blessed from 'blessed';
import { Validator } from '../../utils/utils.js';
import { COLORS, border, spinnerFrames } from '../themes/theme.js';

/**
 * Live Job Monitor Screen
 * Shows real-time job logs, progress, and error details
 */
export class LiveMonitor {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.updateInterval = null;
        this.selectedJobId = null;

        // Initialize notifiedJobs with all currently non-running jobs 
        // to avoid spamming notifications when the screen opens
        const currentJobs = this.ctx.jobManager.getAllJobs();
        this.notifiedJobs = new Set(
            currentJobs.filter(j => j.status !== 'running').map(j => j.id)
        );

        // Auto-jump: a job started just before the monitor opened (e.g. from
        // the channel screen) is consumed here so the monitor selects it and
        // announces the jump. Job ids seen at construction are baseline — only
        // jobs appearing after this point (e.g. autosync) count as brand-new.
        this._jumpJobId = null;
        const pendingJump = this.ctx.jobManager.lastStartedJobId ?? null;
        this.ctx.jobManager.lastStartedJobId = null;
        if (pendingJump !== null && pendingJump !== undefined) this._jumpJobId = pendingJump;
        this._seenJobIds = new Set(currentJobs.map(j => j.id));

        this.spinnerFrames = spinnerFrames; // braille on Unicode terminals, ASCII elsewhere
        this.spinnerFrame = 0;

        // Scroll tracking: when true (default), auto-scroll log to bottom for running jobs.
        // Set to false when user scrolls up manually; re-enabled when they scroll to bottom.
        this._logAutoScroll = true;

        // Fingerprinting: track last items array to avoid no-op setItems()
        this._lastJobItems = '';
        this._suppressSelectItem = false;
        this._resizeHandler = null;

        // Selection race guard: the newest-running-job auto-pick (and the
        // brand-new job jump below) must never steal the cursor from a job the
        // user has explicitly selected. _userSelectedJobId is the last job the
        // user chose themselves; _autoSelecting marks programmatic select()
        // calls in renderJobList so they don't count as user choices.
        this._userSelectedJobId = null;
        this._autoSelecting = false;

        // Strip the rotating spinner glyph (braille OR ASCII fallback frames)
        // from the job-list fingerprint, otherwise on ASCII terminals the
        // glyph changes every tick and setItems() re-runs constantly, fighting
        // the user's scroll/selection. Build once from the theme frames.
        this._spinnerFramesRe = new RegExp(
            '\\[(' + this.spinnerFrames
                .map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|') + ')\\]',
            'g'
        );

        this.create();
        this.setupKeyBindings();
        this.startUpdates();
    }

    create() {
        this.widgets.main = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: '100%',
            style: { bg: 'black', fg: 'white' }
        });

        // Header
        this.widgets.header = blessed.box({
            parent: this.widgets.main,
            top: 0, left: 0, width: '100%', height: 1,
            style: { bg: 'blue', fg: 'white', bold: true },
            content: ' LIVE JOB MONITOR'
        });

        // Summary bar
        this.widgets.summary = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%', height: 1,
            tags: true,
            style: { bg: 'black', fg: 'cyan' }
        });

        // Left panel: job list
        this.widgets.jobList = blessed.list({
            parent: this.widgets.main,
            top: 2, left: 0,
            width: '35%',
            height: this.screen.height - 4,
            border: border(COLORS.BORDER),
            label: ' Jobs ',
            tags: true,
            style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue', fg: 'white', bold: true },
                item: { fg: 'white' }
            },
            mouse: true,
            keys: true,
            vi: true
        });

        // Right panel: job log
        this.widgets.logBox = blessed.box({
            parent: this.widgets.main,
            top: 2, left: '35%',
            width: '65%',
            height: this.screen.height - 4,
            border: border(COLORS.BORDER),
            label: ' Job Log ',
            tags: true,
            style: { border: { fg: 'yellow' } },
            scrollable: true,
            alwaysScroll: true,
            mouse: true,
            keys: true,
            scrollbar: {
                ch: '|',
                style: { fg: 'cyan' }
            }
        });

        // Message/Pop-up widget
        this.widgets.message = blessed.message({
            parent: this.widgets.main,
            top: 'center',
            left: 'center',
            width: '50%',
            height: 'shrink',
            border: border(COLORS.BORDER),
            label: ' Notification ',
            tags: true,
            hidden: true,
            style: {
                border: { fg: 'magenta' },
                bg: 'black',
                fg: 'white'
            }
        });

        // Footer
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' UP/DOWN Select/Scroll  TAB Switch Panel  C Cancel  D Delete(completed/failed)  ESC/Q Back  ENTER Select  PGUP/PGDN Scroll'
        });

        this.widgets.jobList.focus();

        // When a job is selected in the list, show its log
        this.widgets.jobList.on('select item', (item, index) => {
            // setItems() re-selects index 0 internally, firing this handler
            // spuriously; suppress those during programmatic list updates.
            if (this._suppressSelectItem) return;
            const jobs = this.ctx.jobManager.getAllJobs();
            if (jobs[index]) {
                // A selection CHANGE that wasn't made by renderJobList's own
                // re-select is a user choice (arrow keys / mouse) — remember it
                // so the newest-job auto-jump can't steal the cursor later.
                if (!this._autoSelecting && jobs[index].id !== this.selectedJobId) {
                    this._userSelectedJobId = jobs[index].id;
                }
                this.selectedJobId = jobs[index].id;
                // Reset auto-scroll for a freshly-selected running job
                if (jobs[index].status === 'running') this._logAutoScroll = true;
                this.renderLog(jobs[index]);
                this.screen.render();
            }
        });

        this._resizeHandler = () => {
            this.widgets.jobList.height = this.screen.height - 4;
            this.widgets.logBox.height = this.screen.height - 4;
            this.screen.render();
        };
        this.screen.on('resize', this._resizeHandler);
    }

    formatElapsed(ms) {
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rs = s % 60;
        return `${m}m ${rs}s`;
    }

    renderJobList(jobs) {
        const spinner = this.spinnerFrames[this.spinnerFrame];
        const items = jobs.map(j => {
            const isRunning = j.status === 'running';
            const isPaused = this.ctx.isPaused;
            
            let icon;
            if (isRunning) {
                if (isPaused) {
                    icon = '{yellow-fg}‖{/yellow-fg}'; // Pause icon
                } else {
                    icon = `{cyan-fg}${spinner}{/cyan-fg}`;
                }
            } else if (j.status === 'completed') {
                icon = '{green-fg}✔{/green-fg}';
            } else if (j.status === 'error') {
                icon = '{red-fg}✘{/red-fg}';
            } else {
                icon = '?';
            }

            const elapsed = j.endTime
                ? this.formatElapsed(j.endTime - j.startTime)
                : this.formatElapsed(Date.now() - j.startTime);
            const msgs = j.totalMessages.toLocaleString();
            return ` [${icon}] #${j.id} ${Validator.sanitizeBlessedTags(j.channel)}  ${msgs} msgs  ${elapsed}`;
        });

        if (!items.length) items.push(' No jobs yet');

        // Fingerprinting: skip setItems unless something STABLE changed.
        // The spinner glyph rotates and elapsed changes every tick, so they're
        // excluded from the fingerprint; the full items are still re-rendered on
        // the rare tick where setItems runs. This prevents the 200ms setItems
        // (which resets scroll/selection) from fighting manual scrolling.
        const fpItems = items.map(it =>
            it.replace(/\{[^}]*\}/g, '')               // strip blessed tags
              .replace(this._spinnerFramesRe, '[X]')   // normalize spinner glyph (braille OR ASCII)
              .replace(/\d+ms|\d+s|\d+m \d+s/g, 'T')   // normalize elapsed
        );
        const newItemsFp = JSON.stringify(fpItems);
        if (newItemsFp === this._lastJobItems) {
            // Still need to sync selection (which may have shifted)
            const idx = jobs.findIndex(j => j.id === this.selectedJobId);
            if (idx >= 0) this._autoSelecting = true;
            try {
                if (idx >= 0) this.widgets.jobList.select(idx);
            } finally {
                this._autoSelecting = false;
            }
            return;
        }
        this._lastJobItems = newItemsFp;

        // Temporarily suppress the 'select item' side-effect that setItems()
        // fires for index 0, so it doesn't clobber selectedJobId.
        this._suppressSelectItem = true;
        try {
            this.widgets.jobList.setItems(items);
        } finally {
            this._suppressSelectItem = false;
        }

        // Auto-select first running job, or keep current selection.
        // Prefer the NEWEST running job so a fresh job is what you see.
        // If selectedJobId points at a job that no longer exists (10-min cleanup
        // timer), reset to the newest running job.
        if (jobs.length) {
            const stillExists = jobs.find(j => j.id === this.selectedJobId);
            if (!this.selectedJobId || !stillExists) {
                const running = jobs.filter(j => j.status === 'running');
                const pick = running.length
                    ? running.reduce((a, b) => (b.id > a.id ? b : a))
                    : jobs[jobs.length - 1];
                this.selectedJobId = pick.id;
            }
        } else {
            this.selectedJobId = null;
        }

        // Sync list selection to selectedJobId
        const idx = jobs.findIndex(j => j.id === this.selectedJobId);
        if (idx >= 0) this._autoSelecting = true;
        try {
            if (idx >= 0) this.widgets.jobList.select(idx);
        } finally {
            this._autoSelecting = false;
        }
    }

    renderLog(job) {
        if (!job) {
            this.widgets.logBox.setLabel(' Job Log ');
            this.widgets.logBox.setContent('{gray-fg}Select a job to view its log{/gray-fg}');
            return;
        }

        const statusColor = job.status === 'running'   ? 'cyan'  :
                            job.status === 'completed' ? 'green' : 'red';

        this.widgets.logBox.setLabel(` Job #${job.id} — ${Validator.sanitizeBlessedTags(job.channel)} `);

        let content = '';

        // Job header info
        content += `{${statusColor}-fg}{bold}Status: ${job.status.toUpperCase()}{/bold}{/${statusColor}-fg}\n`;
        content += `{white-fg}Channel:   ${Validator.sanitizeBlessedTags(job.channel)} (${Validator.sanitizeBlessedTags(String(job.channelId))}){/white-fg}\n`;
        content += `{white-fg}Direction: ${job.direction}{/white-fg}\n`;
        if (job.startingPoint?.description) {
            content += `{cyan-fg}Starting:  ${Validator.sanitizeBlessedTags(job.startingPoint.description).slice(0, 100)}{/cyan-fg}\n`;
        }
        content += `{white-fg}Messages:  ${job.totalMessages.toLocaleString()}{/white-fg}\n`;

        const elapsed = job.endTime
            ? this.formatElapsed(job.endTime - job.startTime)
            : this.formatElapsed(Date.now() - job.startTime);
        content += `{white-fg}Elapsed:   ${elapsed}{/white-fg}\n`;

        if (job.status === 'error') {
            const rate = job.endTime
                ? Math.round(job.totalMessages / ((job.endTime - job.startTime) / 1000))
                : 0;
            content += `{white-fg}Rate:      ${rate} msg/s{/white-fg}\n`;
        } else if (job.status === 'running') {
            const rate = Math.round(job.totalMessages / Math.max(1, (Date.now() - job.startTime) / 1000));
            content += `{white-fg}Rate:      ~${rate} msg/s{/white-fg}\n`;
        }

        content += '\n{cyan-fg}' + '─'.repeat(50) + '{/cyan-fg}\n';
        content += '{cyan-fg}{bold}LOG{/bold}{/cyan-fg}\n';
        content += '{cyan-fg}' + '─'.repeat(50) + '{/cyan-fg}\n\n';

        if (!job.logs || job.logs.length === 0) {
            content += '{gray-fg}No log entries yet{/gray-fg}\n';
        } else {
            // Limit display to last 40 log entries to prevent content overload
            const displayLogs = job.logs.slice(-40);
            let lastHeartbeat = false;
            displayLogs.forEach(entry => {
                const time = new Date(entry.timestamp).toLocaleTimeString();
                let msg = Validator.sanitizeBlessedTags(String(entry.message));
                msg = Validator.emojiToAscii(msg);

                // Deduplicate consecutive heartbeat messages
                const isHeartbeat = msg.includes('* Still running');
                if (isHeartbeat && lastHeartbeat) return; // skip duplicate heartbeat
                lastHeartbeat = isHeartbeat;

                // Color-code log lines by content
                let lineColor = 'white';
                if (msg.includes('[ERR]') || msg.includes('Error') || msg.includes('error') || msg.includes('failed')) {
                    lineColor = 'red';
                } else if (msg.includes('!') || msg.includes('Warning') || msg.includes('rate limit')) {
                    lineColor = 'yellow';
                } else if (msg.includes('[OK]') || msg.includes('Synced') || msg.includes('completed')) {
                    lineColor = 'green';
                } else if (msg.includes('#') || msg.includes('Fetched') || msg.includes('messages')) {
                    lineColor = 'cyan';
                } else if (msg.includes('>') || msg.includes('Starting') || msg.includes('Resuming')) {
                    lineColor = 'blue';
                }

                content += `{gray-fg}${time}{/gray-fg} {${lineColor}-fg}${msg}{/${lineColor}-fg}\n`;
            });
        }

        // Recent messages preview
        if (job.recentMessages && job.recentMessages.length > 0) {
            content += '\n{cyan-fg}' + '─'.repeat(50) + '{/cyan-fg}\n';
            content += '{cyan-fg}{bold}RECENT MESSAGES{/bold}{/cyan-fg}\n';
            content += '{cyan-fg}' + '─'.repeat(50) + '{/cyan-fg}\n\n';
            job.recentMessages.slice(-5).forEach(m => {
                const author = Validator.sanitizeBlessedTags(String(m.author || '').substring(0, 20));
                const text = Validator.sanitizeBlessedTags(String(m.content || '').substring(0, 60));
                content += `{green-fg}${author}{/green-fg}: {white-fg}${text}{/white-fg}\n`;
            });
        }

        this.widgets.logBox.setContent(content);
        // Auto-scroll to bottom for running jobs (only if user hasn't scrolled up manually)
        if (job.status === 'running' && this._logAutoScroll) {
            this.widgets.logBox.setScrollPerc(100);
        }
    }

    updateDisplay() {
        try {
            const allJobs = this.ctx.jobManager.getAllJobs();
            const running  = allJobs.filter(j => j.status === 'running').length;
            const completed = allJobs.filter(j => j.status === 'completed').length;
            const failed   = allJobs.filter(j => j.status === 'error').length;
            const isPaused = this.ctx.isPaused;

            // Prune notifiedJobs: drop ids that no longer exist in activeJobs,
            // keeping the set bounded WITHOUT re-notifying stale-but-present jobs.
            if (this.notifiedJobs.size > 500) {
                const jobIds = new Set(allJobs.map(j => j.id));
                const stale = [...this.notifiedJobs].filter(id => !jobIds.has(id));
                if (stale.length) {
                    stale.forEach(id => this.notifiedJobs.delete(id));
                }
                // If still over the cap (jobs still present), drop oldest excess
                while (this.notifiedJobs.size > 500) {
                    const first = this.notifiedJobs.values().next().value;
                    if (first === undefined) break;
                    this.notifiedJobs.delete(first);
                }
            }

            // Check for newly completed jobs
            allJobs.forEach(job => {
                if (job.status !== 'running' && !this.notifiedJobs.has(job.id)) {
                    this.notifiedJobs.add(job.id);
                    const color = job.status === 'completed' ? 'green' : 'red';
                    const statusStr = job.status === 'completed' ? 'COMPLETED' : 'FAILED';
                    this.widgets.message.display(
                        `{${color}-fg}{bold}Job #${job.id} ${statusStr}{/bold}{/${color}-fg}\n\n` +
                        `Channel: #${Validator.sanitizeBlessedTags(job.channel)}\n` +
                        `Messages: ${job.totalMessages.toLocaleString()}\n` +
                        `Time: ${this.formatElapsed(job.duration || 0)}`,
                        3
                    );
                }
            });

            // Auto-jump: when a new job starts (or one was started just before
            // the monitor opened), jump the selection to it and say so.
            let jumpTarget = null;
            if (this._jumpJobId !== null) {
                const target = allJobs.find(j => j.id === this._jumpJobId);
                if (target) jumpTarget = target;
                this._jumpJobId = null;
            }
            if (!jumpTarget && !this._userSelectedJobId) {
                // Only auto-jump to jobs that appeared while the monitor was
                // open if the user hasn't picked a job themselves — never steal
                // the cursor from a job they are actively viewing.
                const brandNew = allJobs.filter(j => !this._seenJobIds.has(j.id));
                if (brandNew.length) {
                    const running = brandNew.filter(j => j.status === 'running');
                    jumpTarget = running.length
                        ? running.reduce((a, b) => (b.id > a.id ? b : a))
                        : brandNew.reduce((a, b) => (b.id > a.id ? b : a));
                }
            }
            if (jumpTarget) {
                this.selectedJobId = jumpTarget.id;
                this._logAutoScroll = jumpTarget.status === 'running';
                this.widgets.message.display(
                    `{cyan-fg}{bold}Jumping to job #${jumpTarget.id}{/bold}{/cyan-fg}\n\n` +
                    `Channel: #${Validator.sanitizeBlessedTags(jumpTarget.channel)}\n` +
                    `Direction: ${jumpTarget.direction}\n` +
                    `Status: {${jumpTarget.status === 'running' ? 'green' : 'white'}-fg}${jumpTarget.status}{/${jumpTarget.status === 'running' ? 'green' : 'white'}-fg}`,
                    3
                );
            }
            allJobs.forEach(j => this._seenJobIds.add(j.id));

            const statusLabel = isPaused ? '{yellow-fg}PAUSED{/yellow-fg}' : '{green-fg}ACTIVE{/green-fg}';
            this.widgets.summary.setContent(
                ` Status: ${statusLabel}   Running: ${running}   Completed: ${completed}   Failed: ${failed}` +
                (failed > 0 ? '   [!] Check failed jobs for errors' : '')
            );

            if (!isPaused) {
                this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
            }
            this.renderJobList(allJobs);

            // Re-render the selected job's log
            const selectedJob = allJobs.find(j => j.id === this.selectedJobId) || allJobs[0];
            this.renderLog(selectedJob || null);
        } catch (err) {
            // Silently ignore update errors to keep the monitor alive
        }
    }

    cancelSelectedJob() {
        const jobs = this.ctx.jobManager.getAllJobs();
        const selected = jobs.find(j => j.id === this.selectedJobId);
        if (!selected || selected.status !== 'running') return;
        const ok = this.ctx.jobManager.requestCancel(selected.id);
        if (ok) {
            // User acted on this job — don't let a brand-new job steal the cursor
            this._userSelectedJobId = selected.id;
            this.widgets.message.display(
                `{yellow-fg}{bold}Cancellation requested{/bold}{/yellow-fg}\n\n` +
                `Job #${selected.id} on #${Validator.sanitizeBlessedTags(selected.channel)}`,
                2
            );
        }
    }

    deleteSelectedJob() {
        const jobs = this.ctx.jobManager.getAllJobs();
        const selected = jobs.find(j => j.id === this.selectedJobId);
        if (!selected) return;
        if (selected.status === 'running') {
            this.widgets.message.display(
                `{yellow-fg}{bold}Cannot delete running job{/bold}{/yellow-fg}\n\n` +
                `Cancel job #${selected.id} first with {bold}C{/bold}`,
                2
            );
            return;
        }
        const ok = this.ctx.jobManager.removeJob(selected.id);
        if (ok) {
            // Select the next job in the list, using the refreshed list
            const remaining = this.ctx.jobManager.getAllJobs();
            if (remaining.length > 0) {
                const prevIdx = jobs.indexOf(selected);
                const idx = Math.max(0, Math.min(prevIdx, remaining.length - 1));
                this.selectedJobId = remaining[idx]?.id ?? null;
            } else {
                this.selectedJobId = null;
            }
            // User acted on this job — don't let a brand-new job steal the cursor
            this._userSelectedJobId = this.selectedJobId;
            this.widgets.message.display(
                `{green-fg}{bold}Job #${selected.id} removed{/bold}{/green-fg}\n\n` +
                `Channel: #${Validator.sanitizeBlessedTags(selected.channel)}`,
                2
            );
        }
    }

    setupKeyBindings() {
        // Global: escape/q goes back, enter has no global back (used for job selection)
        this.widgets.main.key(['escape', 'q'], () => this.onBack());

        // Tab switches focus between list and log.
        // Bound at screen level because the main container is never focused,
        // so a widget-level 'tab' handler would never fire.
        this._handleTab = () => {
            if (this.widgets.jobList.focused) {
                this.widgets.logBox.focus();
            } else {
                this.widgets.jobList.focus();
            }
            this.screen.render();
        };
        this.screen.key(['tab'], this._handleTab);

        // Job list: escape/q goes back, enter selects (handled by 'select item' event)
        this.widgets.jobList.key(['escape', 'q'], () => this.onBack());

        this.widgets.jobList.key(['c'], () => this.cancelSelectedJob());
        this.widgets.jobList.key(['d'], () => this.deleteSelectedJob());

        // Scrolling keys for the log box
        this.widgets.logBox.key(['up', 'k'], () => {
            this._logAutoScroll = false;
            this.widgets.logBox.scroll(-1);
            this.screen.render();
        });

        this.widgets.logBox.key(['down', 'j'], () => {
            this.widgets.logBox.scroll(1);
            // Re-enable auto-scroll when user scrolls to bottom
            if (this.widgets.logBox.getScrollPerc() >= 99) {
                this._logAutoScroll = true;
            }
            this.screen.render();
        });

        this.widgets.logBox.key(['pageup'], () => {
            this._logAutoScroll = false;
            this.widgets.logBox.scroll(-(this.widgets.logBox.height - 2));
            this.screen.render();
        });

        this.widgets.logBox.key(['pagedown'], () => {
            this.widgets.logBox.scroll(this.widgets.logBox.height - 2);
            if (this.widgets.logBox.getScrollPerc() >= 99) {
                this._logAutoScroll = true;
            }
            this.screen.render();
        });
        this.widgets.logBox.key(['c'], () => this.cancelSelectedJob());
        this.widgets.logBox.key(['d'], () => {
            this.deleteSelectedJob();
            this.screen.render();
        });

        // Allow exiting from log box
        this.widgets.logBox.key(['escape', 'q'], () => this.onBack());
    }

    startUpdates() {
        this.updateDisplay();
        this.updateInterval = setInterval(() => {
            this.updateDisplay();
            this.screen.render();
        }, 200);
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this._resizeHandler) this.screen.removeListener('resize', this._resizeHandler);
        if (this._handleTab) this.screen.removeKey(['tab'], this._handleTab);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default LiveMonitor;
