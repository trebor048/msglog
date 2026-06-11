/**
 * Centralized theme constants for the Blessed TUI.
 * Every screen imports from here instead of hardcoding color strings.
 */

export const COLORS = {
    // Core palette
    PRIMARY_BG: 'black',
    PRIMARY_FG: 'white',
    HEADER_BG: 'blue',
    HEADER_FG: 'white',
    BORDER: 'cyan',
    FOCUS_BG: 'blue',
    FOCUS_FG: 'white',
    HOVER_BG: 'green',
    HOVER_FG: 'black',
    FOOTER_FG: 'cyan',

    // Semantic
    SUCCESS: 'green',
    ERROR: 'red',
    WARNING: 'yellow',
    INFO: 'blue',
    MUTED: 'gray',
    HIGHLIGHT: 'cyan',
    BOLD_FG: 'white',

    // Status
    RUNNING: 'cyan',
    COMPLETED: 'green',
    FAILED: 'red',
    PAUSED: 'yellow',
    ACTIVE: 'green',
    INACTIVE: 'gray',
    LISTENING: 'green',
};

export const STYLES = {
    // Main container
    mainBox: () => ({
        bg: COLORS.PRIMARY_BG,
        fg: COLORS.PRIMARY_FG,
    }),

    // Header bar
    header: () => ({
        bg: COLORS.HEADER_BG,
        fg: COLORS.HEADER_FG,
        bold: true,
    }),

    // Bordered list
    list: (label) => ({
        border: { fg: COLORS.BORDER },
        selected: { bg: COLORS.FOCUS_BG, fg: COLORS.FOCUS_FG, bold: true },
        item: { fg: COLORS.PRIMARY_FG },
        label,
    }),

    // Bordered box
    borderedBox: (borderColor = COLORS.BORDER, label = '') => ({
        border: { fg: borderColor },
        label,
    }),

    // Footer bar
    footer: () => ({
        fg: COLORS.FOOTER_FG,
    }),

    // Input/prompt
    input: () => ({
        border: { fg: COLORS.WARNING },
        bg: COLORS.PRIMARY_BG,
        fg: COLORS.PRIMARY_FG,
    }),

    // Highlighted dialog
    dialog: () => ({
        border: { fg: COLORS.WARNING },
        bg: COLORS.PRIMARY_BG,
        fg: COLORS.PRIMARY_FG,
    }),

    // Message notification
    message: (color) => ({
        border: { fg: color || COLORS.HIGHLIGHT },
        bg: COLORS.PRIMARY_BG,
        fg: COLORS.PRIMARY_FG,
    }),
};

/**
 * Layout constants to avoid magic numbers across screens
 */
export const LAYOUT = {
    HEADER_HEIGHT: 1,
    FOOTER_HEIGHT: 1,
    MIN_TERM_WIDTH: 60,
    MIN_TERM_HEIGHT: 20,
    DEFAULT_UPDATE_INTERVAL: 500,
    LIVE_MONITOR_INTERVAL: 200,
    HEALTH_INTERVAL: 1000,
    MAX_ITEMS_PER_PAGE: 50,
};

/**
 * Blessed-friendly tag helpers — use these instead of raw {color-fg} strings
 */
export const tag = (color, text) => `{${color}-fg}${text}{/${color}-fg}`;
export const tagBold = (color, text) => `{${color}-fg}{bold}${text}{/bold}{/${color}-fg}`;
export const dim = (text) => `{gray-fg}${text}{/gray-fg}`;

export default { COLORS, STYLES, LAYOUT, tag, tagBold, dim };
