import fs from 'fs';
import path from 'path';
import BlessedTUIApp from './app.js';

/**
 * Redirect all console output to a log file while the TUI is running.
 * Any console.log/error/warn from anywhere in the app would corrupt
 * the Blessed screen — this silences them safely.
 *
 * ⚠️ Security: Filters out known sensitive patterns (tokens, auth headers)
 * before writing to disk.
 */
function redirectConsoleToFile() {
    const logDir = './logs';
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

    const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
    const date = new Date().toISOString().split('T')[0];
    const baseName = `tui-console-${date}`;

    const getRotatedLogFile = () => {
        for (let i = 0; i < 1000; i++) {
            const suffix = i === 0 ? '' : `.${i}`;
            const candidate = path.join(logDir, `${baseName}${suffix}.log`);
            try {
                const stats = fs.statSync(candidate);
                if (stats.size < MAX_LOG_FILE_SIZE) return candidate;
            } catch {
                return candidate;
            }
        }
        return path.join(logDir, `${baseName}.${Date.now()}.log`);
    };

    let currentLogFile = getRotatedLogFile();
    let stream = fs.createWriteStream(currentLogFile, { flags: 'a' });

    // Patterns that indicate sensitive data — truncate these lines
    const SENSITIVE_PATTERNS = [
        /Authorization/i,
        /token/i,
        /password/i,
        /secret/i,
    ];

    const write = (level, args) => {
        let line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
            typeof a === 'string' ? a : JSON.stringify(a)
        ).join(' ')}\n`;

        // Redact any line matching sensitive patterns
        if (SENSITIVE_PATTERNS.some(p => p.test(line))) {
            line = `[${new Date().toISOString()}] [${level}] [REDACTED — sensitive content]\n`;
        }

        // Size-based rotation
        try {
            const nextSize = (fs.existsSync(currentLogFile) ? fs.statSync(currentLogFile).size : 0) + Buffer.byteLength(line);
            if (nextSize > MAX_LOG_FILE_SIZE) {
                stream.end();
                currentLogFile = getRotatedLogFile();
                stream = fs.createWriteStream(currentLogFile, { flags: 'a' });
            }
        } catch {
            // keep best-effort logging
        }

        stream.write(line);
    };

    const orig = {
        log:   console.log.bind(console),
        error: console.error.bind(console),
        warn:  console.warn.bind(console),
        info:  console.info.bind(console),
    };

    console.log   = (...a) => write('LOG',   a);
    console.error = (...a) => write('ERROR', a);
    console.warn  = (...a) => write('WARN',  a);
    console.info  = (...a) => write('INFO',  a);

    // Return a restore function for clean shutdown
    return () => {
        console.log   = orig.log;
        console.error = orig.error;
        console.warn  = orig.warn;
        console.info  = orig.info;
        stream.end();
    };
}

/**
 * Start the Blessed-based TUI
 * @param {Object} ctx - AppContext containing all dependencies
 */
export async function startBlessedTUI(ctx) {
    // Non-TTY fallback: if stdin is not a terminal (CI, SSH without -t, etc.),
    // Blessed cannot initialize. Log a warning and keep the process alive
    // for the auto-sync/message-logging background functionality.
    if (!process.stdin.isTTY) {
        console.log('[msg-log] Non-TTY environment detected — TUI disabled.');
        console.log('[msg-log] Background logging and auto-sync are still active.');
        console.log('[msg-log] Press Ctrl+C to exit.');
        // Keep process alive indefinitely (auto-sync handles itself)
        await new Promise(() => {});
        return;
    }

    const restoreConsole = redirectConsoleToFile();

    try {
        const app = new BlessedTUIApp(ctx);
        // Attach restore so graceful shutdown can re-enable console
        ctx._restoreConsole = restoreConsole;
        await app.start();
    } catch (err) {
        restoreConsole();
        // Now safe to print to terminal again
        process.stderr.write(`TUI startup error: ${err.message}\n${err.stack}\n`);
        throw err;
    }
}

export default startBlessedTUI;
