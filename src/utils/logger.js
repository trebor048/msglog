import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

export class Logger {
    constructor() {
        this.logDir = 'logs';
        this.currentDate = new Date().toISOString().split('T')[0];
        this.logFile = path.join(this.logDir, `${this.currentDate}.log`);
        this.notifications = [];
        this.maxNotifications = 100;
        this.initLogDir();
    }

    async initLogDir() {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (err) {
            console.error('Failed to create log directory:', err.message);
        }
    }

    async log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;

        try {
            await fs.appendFile(this.logFile, logLine);
        } catch (err) {
            console.error('Failed to write log:', err.message);
        }

        const colorMap = {
            'INFO': chalk.blue,
            'SUCCESS': chalk.green,
            'WARN': chalk.yellow,
            'ERROR': chalk.red,
            'DEBUG': chalk.gray
        };

        const colorFn = colorMap[level] || chalk.white;
        console.log(colorFn(`[${level}] ${message}`));

        // Store as notification
        this.addNotification(level, message, data);
    }

    addNotification(type, title, data = null) {
        const notification = {
            id: Date.now(),
            type: type.toLowerCase(),
            title,
            data,
            timestamp: new Date().toISOString(),
            read: false
        };

        this.notifications.push(notification);
        if (this.notifications.length > this.maxNotifications) {
            this.notifications.shift();
        }
    }

    info(message, data) { return this.log('INFO', message, data); }
    success(message, data) { return this.log('SUCCESS', message, data); }
    warn(message, data) { return this.log('WARN', message, data); }
    error(message, data) { return this.log('ERROR', message, data); }
    debug(message, data) { return this.log('DEBUG', message, data); }

    getNotifications(type = null, unreadOnly = false) {
        let filtered = this.notifications;
        if (type) filtered = filtered.filter(n => n.type === type);
        if (unreadOnly) filtered = filtered.filter(n => !n.read);
        return filtered;
    }

    markAsRead(id) {
        const n = this.notifications.find(x => x.id === id);
        if (n) n.read = true;
    }

    markAllAsRead() {
        this.notifications.forEach(n => n.read = true);
    }

    getNotificationStats() {
        return {
            total: this.notifications.length,
            unread: this.notifications.filter(n => !n.read).length,
            byType: {
                success: this.notifications.filter(n => n.type === 'success').length,
                error: this.notifications.filter(n => n.type === 'error').length,
                warn: this.notifications.filter(n => n.type === 'warn').length,
                info: this.notifications.filter(n => n.type === 'info').length
            }
        };
    }

    getStats() {
        return this.getNotificationStats();
    }

    async getLogs(days = 7) {
        try {
            const files = await fs.readdir(this.logDir);
            const logs = {};
            for (const file of files.slice(-days)) {
                const content = await fs.readFile(path.join(this.logDir, file), 'utf-8');
                logs[file] = content.split('\n').filter(l => l);
            }
            return logs;
        } catch (err) {
            console.error('Failed to read logs:', err.message);
            return {};
        }
    }

    async clearOldLogs(daysToKeep = 30) {
        try {
            const files = await fs.readdir(this.logDir);
            const now = Date.now();
            const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stat = await fs.stat(filePath);
                if (now - stat.mtime.getTime() > maxAge) {
                    await fs.unlink(filePath);
                }
            }
        } catch (err) {
            console.error('Failed to clear old logs:', err.message);
        }
    }
}

