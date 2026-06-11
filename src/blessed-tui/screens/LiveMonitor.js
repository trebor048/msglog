import blessed from 'blessed';
import { Validator } from '../../utils/utils.js';

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

        this.spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.spinnerFrame = 0;

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
            border: { type: 'line' },
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
            border: { type: 'line' },
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
            border: 'line',
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
            content: ' UP/DOWN Select/Scroll  TAB Switch Panel  C Cancel Job  ESC/Q Back  ENTER Select Job  PAGEUP/PAGEDOWN Scroll Fast'
        });

        this.widgets.jobList.focus();

        // When a job is selected in the list, show its log
        this.widgets.jobList.on('select item', (item, index) => {
            const jobs = this.ctx.jobManager.getAllJobs();
            if (jobs[index]) {
                this.selectedJobId = jobs[index].id;
                this.renderLog(jobs[index]);
                this.screen.render();
            }
        });
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
        this.widgets.jobList.setItems(items);

        // Auto-select first running job, or keep current selection
        if (!this.selectedJobId && jobs.length) {
            const firstRunning = jobs.find(j => j.status === 'running') || jobs[0];
            this.selectedJobId = firstRunning.id;
        }

        // Sync list selection to selectedJobId
        const idx = jobs.findIndex(j => j.id === this.selectedJobId);
        if (idx >= 0) this.widgets.jobList.select(idx);
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
        content += `{white-fg}Channel:   ${Validator.sanitizeBlessedTags(job.channel)} (${job.channelId}){/white-fg}\n`;
        content += `{white-fg}Direction: ${job.direction}{/white-fg}\n`;
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
            job.logs.forEach(entry => {
                const time = new Date(entry.timestamp).toLocaleTimeString();
                const msg = Validator.sanitizeBlessedTags(String(entry.message));

                // Color-code log lines by content
                let lineColor = 'white';
                if (msg.includes('❌') || msg.includes('Error') || msg.includes('error') || msg.includes('failed')) {
                    lineColor = 'red';
                } else if (msg.includes('⚠') || msg.includes('Warning') || msg.includes('rate limit')) {
                    lineColor = 'yellow';
                } else if (msg.includes('✅') || msg.includes('Synced') || msg.includes('completed')) {
                    lineColor = 'green';
                } else if (msg.includes('📦') || msg.includes('Fetched') || msg.includes('messages')) {
                    lineColor = 'cyan';
                } else if (msg.includes('📍') || msg.includes('Starting') || msg.includes('Resuming')) {
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
        // Auto-scroll to bottom for running jobs
        if (job.status === 'running') {
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

            // Prune notifiedJobs to prevent unbounded growth (keep last 500)
            if (this.notifiedJobs.size > 500) {
                const entries = [...this.notifiedJobs];
                this.notifiedJobs = new Set(entries.slice(entries.length - 500));
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
            this.widgets.message.display(
                `{yellow-fg}{bold}Cancellation requested{/bold}{/yellow-fg}\n\n` +
                `Job #${selected.id} on #${Validator.sanitizeBlessedTags(selected.channel)}`,
                2
            );
        }
    }

    setupKeyBindings() {
        // Global: escape/q goes back, enter has no global back (used for job selection)
        this.widgets.main.key(['escape', 'q'], () => this.onBack());

        // Tab switches focus between list and log
        this.widgets.main.key(['tab'], () => {
            if (this.widgets.jobList.focused) {
                this.widgets.logBox.focus();
            } else {
                this.widgets.jobList.focus();
            }
            this.screen.render();
        });

        // Job list: escape/q goes back, enter selects (handled by 'select item' event)
        this.widgets.jobList.key(['escape', 'q'], () => this.onBack());

        // Arrow keys on job list update the log panel
        this.widgets.jobList.key(['up', 'down'], () => {
            setTimeout(() => {
                const jobs = this.ctx.jobManager.getAllJobs();
                const idx = this.widgets.jobList.selected;
                if (jobs[idx]) {
                    this.selectedJobId = jobs[idx].id;
                    this.renderLog(jobs[idx]);
                    this.screen.render();
                }
            }, 10);
        });
        this.widgets.jobList.key(['c'], () => this.cancelSelectedJob());

        // Scrolling keys for the log box
        this.widgets.logBox.key(['up', 'k'], () => {
            this.widgets.logBox.scroll(-1);
            this.screen.render();
        });

        this.widgets.logBox.key(['down', 'j'], () => {
            this.widgets.logBox.scroll(1);
            this.screen.render();
        });

        this.widgets.logBox.key(['pageup'], () => {
            this.widgets.logBox.scroll(-this.widgets.logBox.height + 2);
            this.screen.render();
        });

        this.widgets.logBox.key(['pagedown'], () => {
            this.widgets.logBox.scroll(this.widgets.logBox.height - 2);
            this.screen.render();
        });
        this.widgets.logBox.key(['c'], () => this.cancelSelectedJob());

        // Allow exiting from log box
        this.widgets.logBox.key(['escape', 'q'], () => this.onBack());

        // Allow tab from log box
        this.widgets.logBox.key(['tab'], () => {
            this.widgets.jobList.focus();
            this.screen.render();
        });
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
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default LiveMonitor;
