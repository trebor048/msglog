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
        const cleaned = filename
            .replace(/[<>:"|?*/\x00-\x1f]/g, '_')
            .replace(/^\.+/, '')
            .replace(/[. ]+$/g, '')
            .substring(0, 255);

        const base = cleaned.split('.')[0]?.toUpperCase();
        const reservedNames = new Set([
            'CON', 'PRN', 'AUX', 'NUL',
            'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
            'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
        ]);
        if (!cleaned || reservedNames.has(base)) {
            return `file_${Date.now()}`;
        }
        return cleaned;
    }

    /**
     * Verify a resolved path stays within a base directory.
     * Returns null if safe, or the safe resolved path if within bounds.
     */
    static validatePathConfinement(userPath, baseDir) {
        const resolved = path.resolve(baseDir, userPath);
        const normalizedBase = path.resolve(baseDir) + path.sep;
        if (!resolved.startsWith(normalizedBase)) {
            throw new Error(`Path traversal blocked: ${userPath} escapes ${baseDir}`);
        }
        return resolved;
    }

    /**
     * Validate a database file path stays within the project directory.
     */
    static validateDatabasePath(filepath, projectDir) {
        if (!filepath || typeof filepath !== 'string') {
            throw new Error('Invalid database path');
        }
        const sanitized = filepath.replace(/[<>:"|?*]/g, '_');
        if (sanitized !== filepath) {
            throw new Error('Database path contains invalid characters');
        }
        const resolved = path.resolve(projectDir, sanitized);
        const normalizedBase = path.resolve(projectDir) + path.sep;
        if (!resolved.startsWith(normalizedBase)) {
            throw new Error('Database path must be within the project directory');
        }
        return resolved;
    }

    /**
     * Strip Blessed.js tags to prevent injection from user-controlled strings.
     * Escapes { and } characters that would be parsed as Blessed tags.
     */
    static sanitizeBlessedTags(text) {
        if (!text || typeof text !== 'string') return '';
        // Replace { and } with visually similar Unicode alternatives
        // that Blessed's tag parser won't recognize
        return text
            .replace(/\{/g, '\u2774')  // ❴ — medium left curly bracket ornament
            .replace(/\}/g, '\u2775'); // ❵ — medium right curly bracket ornament
    }

    /**
     * Sanitize an error message for TUI display.
     * Strips file paths, stack traces, and internal details.
     */
    static sanitizeErrorMessage(err) {
        if (!err) return 'Unknown error';
        const msg = err.message || String(err);
        // Truncate at first newline (stack trace follows)
        const firstLine = msg.split('\n')[0];
        // Cap length
        const truncated = firstLine.length > 200 ? firstLine.substring(0, 197) + '...' : firstLine;
        return this.sanitizeBlessedTags(truncated);
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
        if (config.globalDelay < 50) errors.push('Global delay must be at least 50ms');
        if (config.globalDelay > 30000) errors.push('Global delay cannot exceed 30000ms');
        if (config.maxConcurrentJobs < 1) errors.push('Max concurrent jobs must be at least 1');
        if (config.maxConcurrentJobs > 20) errors.push('Max concurrent jobs cannot exceed 20');
        if (config.maxRateLimitChannels < 100) errors.push('Max rate-limit channels must be at least 100');
        if (config.maxRateLimitChannels > 500000) errors.push('Max rate-limit channels cannot exceed 500000');
        if (config.maxSyncPages < 1) errors.push('Max sync pages must be at least 1');
        if (config.maxSyncPages > 1000000) errors.push('Max sync pages cannot exceed 1000000');
        if (config.maxEventQueueSize < 100) errors.push('Max event queue size must be at least 100');
        if (config.maxEventQueueSize > 100000) errors.push('Max event queue size cannot exceed 100000');
        if (config.deletedRetentionDays < 1) errors.push('Deleted retention days must be at least 1');
        if (config.deletedRetentionDays > 3650) errors.push('Deleted retention days cannot exceed 3650');
        if (config.retryAttempts < 1) errors.push('Retry attempts must be at least 1');
        if (config.retryAttempts > 10) errors.push('Retry attempts cannot exceed 10');
        if (config.retryBaseDelayMs < 100) errors.push('Retry base delay must be at least 100ms');
        if (config.retryBaseDelayMs > 30000) errors.push('Retry base delay cannot exceed 30000ms');
        if (config.randomDelayMin < 0) errors.push('Random delay minimum cannot be negative');
        if (config.randomDelayMax < 0) errors.push('Random delay maximum cannot be negative');
        if (config.randomDelayMin > config.randomDelayMax) errors.push('Random delay minimum must be less than or equal to maximum');

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

// Spinner utility for long-running operations
export class Spinner {
    constructor(message = 'Processing...', frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
        this.message = message;
        this.frames = frames;
        this.interval = null;
        this.frameIndex = 0;
        this.isRunning = false;
        this.startTime = null;
        this.lastUpdate = null;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startTime = Date.now();
        this.lastUpdate = this.startTime;
        
        // Hide cursor
        process.stdout.write('\x1B[?25l');
        
        this.interval = setInterval(() => {
            const frame = this.frames[this.frameIndex % this.frames.length];
            const elapsed = Date.now() - this.startTime;
            const seconds = Math.floor(elapsed / 1000);
            
            process.stdout.write(`\r${frame} ${this.message} (${seconds}s)`);
            this.frameIndex++;
        }, 80);
    }

    update(message) {
        this.message = message;
    }

    stop(success = true, finalMessage = null) {
        if (!this.isRunning) return;
        
        clearInterval(this.interval);
        this.isRunning = false;
        
        // Show cursor
        process.stdout.write('\x1B[?25h');
        
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        if (finalMessage) {
            const icon = success ? '✅' : '❌';
            console.log(`\r${icon} ${finalMessage} (${seconds}s)`);
        } else {
            const icon = success ? '✅' : '❌';
            console.log(`\r${icon} ${this.message} completed (${seconds}s)`);
        }
    }

    static async withSpinner(message, operation) {
        const spinner = new Spinner(message);
        spinner.start();
        
        try {
            const result = await operation();
            spinner.stop(true);
            return result;
        } catch (error) {
            spinner.stop(false, `${message} failed: ${error.message}`);
            throw error;
        }
    }
}

// Progress bar for operations with known total items
export class ProgressBar {
    constructor(total, width = 40, message = 'Progress') {
        this.total = total;
        this.current = 0;
        this.width = width;
        this.message = message;
        this.startTime = Date.now();
    }

    update(current, message = null) {
        this.current = current;
        if (message) this.message = message;
        this.render();
    }

    increment(message = null) {
        this.current++;
        if (message) this.message = message;
        this.render();
    }

    render() {
        const percent = Math.min(100, (this.current / this.total) * 100);
        const filled = Math.floor((percent / 100) * this.width);
        const empty = this.width - filled;
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        // Calculate ETA if we have progress
        let eta = '';
        if (this.current > 0 && percent < 100) {
            const estimatedTotalTime = (elapsed / percent) * 100;
            const remainingTime = estimatedTotalTime - elapsed;
            const remainingSeconds = Math.floor(remainingTime / 1000);
            eta = `ETA: ${remainingSeconds}s`;
        }
        
        process.stdout.write(`\r${this.message}: [${bar}] ${percent.toFixed(1)}% ${this.current}/${this.total} (${seconds}s) ${eta}`);
    }

    complete(finalMessage = null) {
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        if (finalMessage) {
            console.log(`\r✅ ${finalMessage} (${seconds}s)`);
        } else {
            console.log(`\r✅ ${this.message} completed (${seconds}s)`);
        }
    }

    static async withProgress(total, message, operation) {
        const progress = new ProgressBar(total, 40, message);
        progress.render();
        
        try {
            const result = await operation((current, msg) => {
                progress.update(current, msg);
            });
            progress.complete();
            return result;
        } catch (error) {
            const elapsed = Date.now() - progress.startTime;
            const seconds = (elapsed / 1000).toFixed(1);
            console.log(`\r❌ ${message} failed: ${error.message} (${seconds}s)`);
            throw error;
        }
    }
}

// TUI-compatible spinner for Blessed.js applications
export class TuiSpinner {
    constructor(widget, message = 'Processing...', frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
        this.widget = widget;
        this.message = message;
        this.frames = frames;
        this.interval = null;
        this.frameIndex = 0;
        this.isRunning = false;
        this.startTime = null;
        this.lastUpdate = null;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startTime = Date.now();
        this.lastUpdate = this.startTime;
        
        this.interval = setInterval(() => {
            const frame = this.frames[this.frameIndex % this.frames.length];
            const elapsed = Date.now() - this.startTime;
            const seconds = Math.floor(elapsed / 1000);
            
            this.widget.setContent(`\n{yellow-fg}${frame} ${this.message} (${seconds}s){/yellow-fg}`);
            this.widget.screen.render();
            this.frameIndex++;
        }, 80);
    }

    update(message) {
        this.message = message;
    }

    stop(success = true, finalMessage = null) {
        if (!this.isRunning) return;
        
        clearInterval(this.interval);
        this.isRunning = false;
        
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        if (finalMessage) {
            const icon = success ? '✅' : '❌';
            this.widget.setContent(`\n{${success ? 'green' : 'red'}-fg}${icon} ${finalMessage} (${seconds}s){/${success ? 'green' : 'red'}-fg}`);
        } else {
            const icon = success ? '✅' : '❌';
            this.widget.setContent(`\n{${success ? 'green' : 'red'}-fg}${icon} ${this.message} completed (${seconds}s){/${success ? 'green' : 'red'}-fg}`);
        }
        this.widget.screen.render();
    }

    static async withTuiSpinner(widget, message, operation) {
        const spinner = new TuiSpinner(widget, message);
        spinner.start();
        
        try {
            const result = await operation();
            spinner.stop(true);
            return result;
        } catch (error) {
            spinner.stop(false, `${message} failed: ${error.message}`);
            throw error;
        }
    }
}

// TUI-compatible progress bar for Blessed.js applications
export class TuiProgressBar {
    constructor(widget, total, width = 40, message = 'Progress') {
        this.widget = widget;
        this.total = total;
        this.current = 0;
        this.width = width;
        this.message = message;
        this.startTime = Date.now();
    }

    update(current, message = null) {
        this.current = current;
        if (message) this.message = message;
        this.render();
    }

    increment(message = null) {
        this.current++;
        if (message) this.message = message;
        this.render();
    }

    render() {
        const percent = Math.min(100, (this.current / this.total) * 100);
        const filled = Math.floor((percent / 100) * this.width);
        const empty = this.width - filled;
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        // Calculate ETA if we have progress
        let eta = '';
        if (this.current > 0 && percent < 100) {
            const estimatedTotalTime = (elapsed / percent) * 100;
            const remainingTime = estimatedTotalTime - elapsed;
            const remainingSeconds = Math.floor(remainingTime / 1000);
            eta = `ETA: ${remainingSeconds}s`;
        }
        
        const content = `\n{cyan-fg}${this.message}{/cyan-fg}\n` +
                       `{green-fg}[${bar}]{/green-fg}\n` +
                       `{white-fg}${percent.toFixed(1)}% ${this.current}/${this.total} (${seconds}s) ${eta}{/white-fg}`;
        
        this.widget.setContent(content);
        this.widget.screen.render();
    }

    complete(finalMessage = null) {
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(1);
        
        if (finalMessage) {
            this.widget.setContent(`\n{green-fg}✅ ${finalMessage} (${seconds}s){/green-fg}`);
        } else {
            this.widget.setContent(`\n{green-fg}✅ ${this.message} completed (${seconds}s){/green-fg}`);
        }
        this.widget.screen.render();
    }

    static async withTuiProgress(widget, total, message, operation) {
        const progress = new TuiProgressBar(widget, total, 40, message);
        progress.render();
        
        try {
            const result = await operation((current, msg) => {
                progress.update(current, msg);
            });
            progress.complete();
            return result;
        } catch (error) {
            const elapsed = Date.now() - progress.startTime;
            const seconds = (elapsed / 1000).toFixed(1);
            widget.setContent(`\n{red-fg}❌ ${message} failed: ${error.message} (${seconds}s){/red-fg}`);
            widget.screen.render();
            throw error;
        }
    }
}
