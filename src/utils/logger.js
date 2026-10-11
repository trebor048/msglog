import fs from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';

// Mirrors the TUI console-redirect redaction (src/blessed-tui/index.js): the
// daily file log must never persist lines that look sensitive (Authorization
// headers, tokens, passwords, secrets) — error messages from Discord/axios can
// otherwise leak credentials to disk.
const SENSITIVE_PATTERNS = [
    /Authorization/i,
    /token/i,
    /password/i,
    /secret/i,
];

const redactLine = (line) => SENSITIVE_PATTERNS.some(p => p.test(line))
    ? '[REDACTED — sensitive content]'
    : line;

export class Logger {
    constructor() {
        this.logDir = 'logs';
        this.currentDate = new Date().toISOString().split('T')[0];
        this.logFile = path.join(this.logDir, `${this.currentDate}.log`);
        this._appendFailed = false;
        this._writeQueue = Promise.resolve();
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
        let dataStr = '';
        if (data !== null && data !== undefined) {
            try {
                dataStr = ' ' + JSON.stringify(data);
            } catch {
                dataStr = ' [unserializable data]';
            }
        }
        const rawLine = `[${timestamp}] [${level}] ${message}${dataStr}`;
        const safeLine = redactLine(rawLine);
        const logLine = `${safeLine}\n`;
        // Serialize appends through a promise chain so writes are ordered
        // and no line is lost if the process exits before the write completes.
        this._writeQueue = this._writeQueue
            .then(() => fs.appendFile(this.logFile, logLine))
            .then(() => { this._appendFailed = false; })
            .catch((err) => {
                if (!this._appendFailed) {
                    this._appendFailed = true;
                    process.stderr.write(`[logger] failed to append log file: ${err.message}\n`);
                }
            });

        const colorMap = {
            'INFO': chalk.blue,
            'SUCCESS': chalk.green,
            'WARN': chalk.yellow,
            'ERROR': chalk.red,
            'DEBUG': chalk.gray
        };
        const colorFn = colorMap[level] || chalk.white;
        // Redact the console line too (when the TUI redirect isn't active the
        // console goes straight to the terminal).
        const consoleLine = redactLine(message);
        console.log(colorFn(`[${level}] ${consoleLine}`));
    }

    async flush() {
        // The write chain is reassigned on every log() call, so a single await
        // captures only a snapshot. Loop until the chain has fully settled to
        // cover any writes issued during the flush window.
        for (let i = 0; i < 100; i++) {
            const current = this._writeQueue;
            await current;
            if (this._writeQueue === current) break;
        }
    }

    info(message, data) { this.log('INFO', message, data); }
    success(message, data) { this.log('SUCCESS', message, data); }
    warn(message, data) { this.log('WARN', message, data); }
    error(message, data) { this.log('ERROR', message, data); }
    debug(message, data) { this.log('DEBUG', message, data); }

    async getLogs(days = 7) {
        try {
            const files = await fs.readdir(this.logDir);
            // Only app's own daily logs — exclude rotated TUI console captures
            const sorted = files
                .filter(f => f.endsWith('.log') && !f.startsWith('tui-console'))
                .sort((a, b) => a.localeCompare(b));
            const logs = {};
            for (const file of sorted.slice(-days)) {
                const content = await fs.readFile(path.join(this.logDir, file), 'utf-8');
                // Cap at 2000 lines per file to avoid unbounded memory reads
                const lines = content.split('\n').filter(l => l);
                logs[file] = lines.slice(-2000);
            }
            return logs;
        } catch (err) {
            console.error('Failed to read logs:', err.message);
            return {};
        }
    }
}
