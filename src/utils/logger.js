import fs from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';

export class Logger {
    constructor() {
        this.logDir = 'logs';
        this.currentDate = new Date().toISOString().split('T')[0];
        this.logFile = path.join(this.logDir, `${this.currentDate}.log`);
        try {
            mkdirSync(this.logDir, { recursive: true });
        } catch (err) {
            console.error('Failed to create log directory:', err.message);
        }
    }

    log(level, message, data = null) {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        if (today !== this.currentDate) {
            this.currentDate = today;
            this.logFile = path.join(this.logDir, `${this.currentDate}.log`);
        }

        const timestamp = now.toISOString();
        const logLine = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
        fs.appendFile(this.logFile, logLine).catch(() => {});

        const colorMap = {
            'INFO': chalk.blue,
            'SUCCESS': chalk.green,
            'WARN': chalk.yellow,
            'ERROR': chalk.red,
            'DEBUG': chalk.gray
        };
        const colorFn = colorMap[level] || chalk.white;
        console.log(colorFn(`[${level}] ${message}`));
    }

    info(message, data) { this.log('INFO', message, data); }
    success(message, data) { this.log('SUCCESS', message, data); }
    warn(message, data) { this.log('WARN', message, data); }
    error(message, data) { this.log('ERROR', message, data); }
    debug(message, data) { this.log('DEBUG', message, data); }

    async getLogs(days = 7) {
        try {
            const files = await fs.readdir(this.logDir);
            const sorted = files
                .filter(f => f.endsWith('.log'))
                .sort((a, b) => a.localeCompare(b));
            const logs = {};
            for (const file of sorted.slice(-days)) {
                const content = await fs.readFile(path.join(this.logDir, file), 'utf-8');
                logs[file] = content.split('\n').filter(l => l);
            }
            return logs;
        } catch (err) {
            console.error('Failed to read logs:', err.message);
            return {};
        }
    }
}
