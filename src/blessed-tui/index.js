import fs from 'fs';
import path from 'path';
import BlessedTUIApp from './app.js';

/**
 * Redirect all console output to a log file while the TUI is running.
 * Any console.log/error/warn from anywhere in the app would corrupt
 * the Blessed screen — this silences them safely.
 */
function redirectConsoleToFile() {
    const logDir = './logs';
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

    const logFile = path.join(logDir, `tui-console-${new Date().toISOString().split('T')[0]}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    const write = (level, args) => {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
            typeof a === 'string' ? a : JSON.stringify(a)
        ).join(' ')}\n`;
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
