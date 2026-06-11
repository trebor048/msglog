/**
 * Screen base class — shared lifecycle for all Blessed TUI screens.
 * Subclasses override create(), setupKeyBindings(), and optionally startUpdates().
 *
 * Lifecycle: constructor → create() → setupKeyBindings() → [startUpdates()] → destroy()
 */
export class Screen {
    /**
     * @param {object} screen   Blessed screen instance
     * @param {object} ctx      AppContext
     * @param {function} onBack Callback for navigating back / exiting
     */
    constructor(screen, ctx, onBack) {
        this.screen = screen;
        this.ctx = ctx;
        this.onBack = onBack;
        this.widgets = {};
        this._intervals = [];
    }

    /** Subclasses MUST override — build all widgets */
    create() {
        throw new Error('create() must be implemented by subclass');
    }

    /** Subclasses SHOULD override — register key bindings */
    setupKeyBindings() {}

    /** Subclasses MAY override — called once after create */
    startUpdates() {}

    /** Schedule a recurring update with auto-cleanup on destroy */
    _setInterval(fn, ms) {
        fn();
        const id = setInterval(fn, ms);
        this._intervals.push(id);
        return id;
    }

    /** Check if terminal meets minimum size */
    _checkTerminalSize(minW = 60, minH = 20) {
        return this.screen.width >= minW && this.screen.height >= minH;
    }

    /** Helper: common back key binding on a widget */
    _bindBackKeys(widget, ...extraKeys) {
        const keys = [...new Set(['escape', 'q', ...extraKeys])];
        widget.key(keys, () => this.onBack());
    }

    destroy() {
        this._intervals.forEach(id => clearInterval(id));
        this._intervals = [];
        if (this.widgets.main) {
            this.widgets.main.destroy();
            this.widgets = {};
        }
    }
}

export default Screen;
