import path from 'path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const sleepJitter = ms => sleep(ms * (0.9 + Math.random() * 0.2));

export const formatDuration = ms => {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60_000) % 60;
    const h = Math.floor(ms / 3_600_000);
    return h > 0 ? `${h}h ${m}m ${s}s`
        : m > 0 ? `${m}m ${s}s`
            : `${s}s`;
};

export const getFileExtension = url => {
    try {
        const ext = path.extname(new URL(url).pathname);
        return ext ? ext.slice(1) : 'unknown';
    } catch {
        return 'unknown';
    }
};

export const resetStdin = () => {
    if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }
};

// Validation utilities
export class Validator {
    static isValidDate(dateString) {
        const date = new Date(dateString);
        return date instanceof Date && !isNaN(date);
    }

    static isValidDateRange(startDate, endDate) {
        if (!this.isValidDate(startDate) || !this.isValidDate(endDate)) {
            return false;
        }
        return new Date(startDate) <= new Date(endDate);
    }

    static sanitizeFilename(filename) {
        return filename
            .replace(/[<>:"|?*\x00-\x1f]/g, '_')
            .replace(/^\.+/, '')
            .substring(0, 255);
    }

    static validateSearchFilters(filters) {
        const errors = [];

        if (filters.startDate && !this.isValidDate(filters.startDate)) {
            errors.push('Invalid start date format');
        }

        if (filters.endDate && !this.isValidDate(filters.endDate)) {
            errors.push('Invalid end date format');
        }

        if (filters.startDate && filters.endDate) {
            if (!this.isValidDateRange(filters.startDate, filters.endDate)) {
                errors.push('Start date must be before end date');
            }
        }

        if (filters.limit && (filters.limit < 1 || filters.limit > 10000)) {
            errors.push('Limit must be between 1 and 10000');
        }

        if (filters.messageType && !['text', 'media', 'both'].includes(filters.messageType)) {
            errors.push('Invalid message type');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    static validateConfig(config) {
        const errors = [];

        if (!config.databaseFile) errors.push('Database file not specified');
        if (config.globalDelay < 0) errors.push('Global delay cannot be negative');
        if (config.maxConcurrentJobs < 1) errors.push('Max concurrent jobs must be at least 1');
        if (config.retryAttempts < 1) errors.push('Retry attempts must be at least 1');

        return {
            valid: errors.length === 0,
            errors
        };
    }
}
