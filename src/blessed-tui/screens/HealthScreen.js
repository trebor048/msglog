import blessed from 'blessed';
import { formatDuration } from '../../utils/utils.js';

/**
 * Enhanced System Health Check Screen
 */
export class HealthScreen {
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this.updateInterval = null;

        this.create();
        this.setupKeyBindings();
        this.startUpdates();
    }

    create() {
        // Main container
        this.widgets.main = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: '100%',
            style: { bg: 'black', fg: 'white' }
        });

        // Header — plain text, no tags needed
        this.widgets.header = blessed.box({
            parent: this.widgets.main,
            top: 0, left: 0, width: '100%', height: 1,
            style: { bg: 'blue', fg: 'white', bold: true },
            content: ' SYSTEM HEALTH'
        });

        // Health box — uses color tags in setContent, needs tags:true
        this.widgets.health = blessed.box({
            parent: this.widgets.main,
            top: 1, left: 0, width: '100%',
            height: this.screen.height - 3,
            border: { type: 'line' },
            tags: true,
            label: ' Health Metrics ',
            style: { border: { fg: 'cyan' } },
            scrollable: true,
            mouse: true,
            keys: true
        });

        // Footer — plain text, no tags needed
        this.widgets.footer = blessed.box({
            parent: this.widgets.main,
            bottom: 0, left: 0, width: '100%', height: 1,
            style: { fg: 'cyan' },
            content: ' ENTER/Q Back  R Reset  ? Help  Updates every sec'
        });

        this.widgets.health.focus();
    }

    updateHealth() {
        const healthStatus = this.ctx.performance.getHealthStatus(
            this.ctx.jobManager,
            this.ctx.circuitBreaker,
            this.ctx.listeningChannels
        );

        const heapUsed = healthStatus.memoryUsage.heapUsed / 1024 / 1024;
        const heapTotal = healthStatus.memoryUsage.heapTotal / 1024 / 1024;
        const memPercent = Math.floor((heapUsed / heapTotal) * 100);
        const memColor = memPercent > 80 ? 'red' : memPercent > 50 ? 'yellow' : 'green';

        const cbState = healthStatus.circuitBreaker?.state ?? 'UNKNOWN';
        const cbColor = cbState === 'CLOSED' ? 'green' : cbState === 'OPEN' ? 'red' : 'yellow';

        let content = '{cyan-fg}{bold}SYSTEM HEALTH METRICS{/bold}{/cyan-fg}\n';
        content += '{gray-fg}' + '─'.repeat(60) + '{/gray-fg}\n\n';

        content += '{cyan-fg}{bold}Uptime{/bold}{/cyan-fg}\n';
        content += `  {white-fg}${formatDuration(healthStatus.uptime)}{/white-fg}\n\n`;

        content += '{cyan-fg}{bold}Processing{/bold}{/cyan-fg}\n';
        content += `  Messages Processed: {green-fg}${healthStatus.totalMessages}{/green-fg}\n`;
        content += `  Jobs Completed:     {green-fg}${healthStatus.totalJobs}{/green-fg}\n`;
        content += `  Active Jobs:        {yellow-fg}${healthStatus.activeJobs}{/yellow-fg}\n\n`;

        content += '{cyan-fg}{bold}Circuit Breaker{/bold}{/cyan-fg}\n';
        content += `  State:    {${cbColor}-fg}${cbState}{/${cbColor}-fg}\n`;
        content += `  Failures: {yellow-fg}${healthStatus.circuitBreaker?.failures ?? 0}{/yellow-fg}\n\n`;

        content += '{cyan-fg}{bold}Memory{/bold}{/cyan-fg}\n';
        content += `  Heap Used:  {${memColor}-fg}${Math.round(heapUsed)} MB{/${memColor}-fg} / {white-fg}${Math.round(heapTotal)} MB{/white-fg}\n`;
        content += `  Usage:      {${memColor}-fg}${memPercent}%{/${memColor}-fg}\n\n`;

        content += '{cyan-fg}{bold}Channels{/bold}{/cyan-fg}\n';
        content += `  Active:    {green-fg}${healthStatus.activeChannels}{/green-fg}\n`;
        content += `  Listening: {green-fg}${this.ctx.listeningChannels.size}{/green-fg}\n\n`;

        const overallOk = cbState === 'CLOSED' && memPercent < 80;
        content += '{cyan-fg}{bold}Overall Status{/bold}{/cyan-fg}\n';
        content += overallOk
            ? '  {green-fg}HEALTHY{/green-fg}\n'
            : '  {red-fg}DEGRADED{/red-fg}\n';

        this.widgets.health.setContent(content);
    }

    setupKeyBindings() {
        this.widgets.health.key(['enter', 'q'], () => this.onBack());
        this.widgets.health.key(['r'], () => {
            this.ctx.circuitBreaker.reset();
            this.updateHealth();
            this.screen.render();
        });
    }

    startUpdates() {
        this.updateHealth();
        this.updateInterval = setInterval(() => {
            this.updateHealth();
            this.screen.render();
        }, 1000);
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this.widgets.main) this.widgets.main.destroy();
    }
}

export default HealthScreen;
