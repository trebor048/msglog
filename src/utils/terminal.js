/**
 * Cross-platform terminal capability detection.
 *
 * The TUI must render acceptably in Windows Terminal, legacy cmd.exe/conhost,
 * Windows PowerShell 5.1, VS Code, and Linux/macOS terminals. The main gaps are:
 *   - Braille spinner glyphs (⠋…) are absent from Consolas / Lucida Console.
 *   - Emoji are absent from most Windows stock fonts (handled separately by
 *     Validator.emojiToAscii on user content).
 *   - Box-drawing borders are present in all common fonts, but not on truly
 *     dumb terminals (TERM=dumb).
 *
 * detectTerminal() is a PURE function so tests can pass fake env/platform.
 * The exported TERMINAL singleton is computed once from the real environment.
 */

const UNICODE_TERM_PROGRAMS = new Set([
    'Windows_Terminal', 'vscode', 'iTerm.app', 'Apple_Terminal',
    'WezTerm', 'alacritty', 'kitty', 'Hyper', 'Tabby',
]);

export function detectTerminal(env = process.env, platform = process.platform, isTTY = process.stdout.isTTY) {
    const term = (env.TERM || '').toLowerCase();
    const isDumb = term === 'dumb' || term === 'unknown';
    const termProgram = env.TERM_PROGRAM || '';

    const winUnicodeTerminal = Boolean(
        env.WT_SESSION ||
        env.ConEmuANSI === 'ON' ||
        env.ANSICON ||
        UNICODE_TERM_PROGRAMS.has(termProgram)
    );

    const unixUtf8 = Boolean(
        (env.LANG || '').toUpperCase().includes('UTF') ||
        (env.LC_ALL || '').toUpperCase().includes('UTF') ||
        (env.LC_CTYPE || '').toUpperCase().includes('UTF')
    );

    const modernUnix = Boolean(
        term.includes('xterm') ||
        term.includes('256color') ||
        term.includes('screen') ||
        term.includes('tmux') ||
        term.includes('linux') ||
        term.includes('rxvt')
    );

    const isWindows = platform === 'win32';

    // Braille / emoji-class glyphs need a real Unicode-aware terminal.
    // On Windows only Windows Terminal / VS Code / ConEmu / ANSICON qualify;
    // stock conhost + PowerShell 5.1 + cmd do not.
    const supportsUnicode = isWindows
        ? winUnicodeTerminal
        : (unixUtf8 || modernUnix || Boolean(env.CI));

    // Box-drawing borders work in effectively every real terminal font.
    const supportsBoxDrawing = !isDumb && isTTY;

    // Color is handled by blessed itself, but expose it for completeness and
    // for any ASCII-only decorations that should not assume color.
    const supportsColor = !(env.NO_COLOR) && !isDumb && isTTY;

    return { supportsUnicode, supportsBoxDrawing, supportsColor, isTTY, isDumb };
}

export const TERMINAL = detectTerminal();

export const SPINNER_FRAMES = TERMINAL.supportsUnicode
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['|', '/', '-', '\\'];

// blessed border types: 'line' uses box-drawing, 'ascii' uses + - |
export const BORDER_TYPE = TERMINAL.supportsBoxDrawing ? 'line' : 'ascii';

export default { TERMINAL, SPINNER_FRAMES, BORDER_TYPE, detectTerminal };
