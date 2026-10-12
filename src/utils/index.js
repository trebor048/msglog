import dotenv from 'dotenv';
import chalk from 'chalk';
import { Client } from 'discord.js-selfbot-v13';

import { loadConfig } from './setup.js';
import { initDatabase } from './setup.js';
import { CircuitBreaker, createWithRetry, AdaptiveRateLimiter } from './resilience.js';
import { JobManager } from './jobManager.js';
import { MessageStore, downloadAttachment, processEmbeds } from './storage.js';
import { SyncEngine } from './syncEngine.js';
import { setupEventHandlers, setupShutdownHandlers, createGracefulShutdown, setupProcessErrorHandlers } from './lifecycle.js';
import startBlessedTUI from '../blessed-tui/index.js';
import { MessageSearch, MessageExporter, DatabaseManager } from './data.js';
import { PerformanceManager } from './performance.js';
import { Logger } from './logger.js';
import { Validator } from './utils.js';
import { startAutoSync } from './autosync.js';
import { handleFatalStartup } from './startupCleanup.js';

dotenv.config();

// Application context container - reduces parameter passing
class AppContext {
    constructor(options) {
        const {
            config, client, db, jobManager, syncEngine, performance, circuitBreaker,
            listeningChannels, withRetry, gracefulShutdown, search, exporter, dbManager, logger, messageStore
        } = options;
        this.config = config;
        this.client = client;
        this.db = db;
        this.jobManager = jobManager;
        this.syncEngine = syncEngine;
        this.performance = performance;
        this.circuitBreaker = circuitBreaker;
        this.listeningChannels = listeningChannels;
        this.withRetry = withRetry;
        this.gracefulShutdown = gracefulShutdown;
        this.search = search;
        this.exporter = exporter;
        this.dbManager = dbManager;
        this.logger = logger;
        this.messageStore = messageStore;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.autoSyncEnabled = false;
        this.autoSyncInterval = null;
        this.autoSyncIntervalMs = 60 * 60 * 1000; // 1 hour default
        this.teardownEventHandlers = null;
        this.teardownShutdownHandlers = null;
        this.teardownProcessErrorHandlers = null;
        this.runtimeMetrics = {
            eventQueueSize: 0,
            maxEventQueueSize: config.maxEventQueueSize ?? 2000,
            queuedMessagesDropped: 0,
            queuedMessagesProcessed: 0
        };
    }
}

async function bootstrap() {
    let client = null;
    let db = null;
    let logger = null;
    let teardownProcessErrorHandlers = null;
    let teardownEventHandlers = null;
    let teardownShutdownHandlers = null;

    try {
        // Validate environment
        if (!process.env.USER_TOKEN) {
            throw new Error('USER_TOKEN environment variable not set');
        }

        // Load and validate configuration
        const config = await loadConfig();
        const configValidation = Validator.validateConfig(config);
        if (!configValidation.valid) {
            throw new Error(`Config validation failed: ${configValidation.errors.join(', ')}`);
        }

        // Initialize Discord client
        client = new Client({ checkUpdate: false, syncStatus: false });

        // Initialize database
        db = initDatabase(config);

        // Initialize resilience patterns
        const circuitBreaker = new CircuitBreaker(5, 60000);
        const withRetry = createWithRetry(config, circuitBreaker);
        const rateLimiter = new AdaptiveRateLimiter(config);

        // Initialize managers and stores
        const jobManager = new JobManager();
        const performance = new PerformanceManager();
        logger = new Logger();
        const dbManager = new DatabaseManager(db, performance, config);
        const messageStore = new MessageStore(db, config, performance);

        // Load persisted state
        const listeningChannels = dbManager.loadListeningChannels();
        const autoSyncSettings = dbManager.loadAutoSync();

        // Create wrapped functions for SyncEngine
        const wrappedDownloadAttachment = (url, channelId, filename, messageId, size) =>
            downloadAttachment(url, channelId, filename, withRetry, config, messageId, size);
        const wrappedProcessEmbeds = (embeds, channelId, messageId) =>
            processEmbeds(embeds, channelId,
                (url, cId, fn, mId) => downloadAttachment(url, cId, fn, withRetry, config, mId),
                config, messageId, withRetry);

        const syncEngine = new SyncEngine(jobManager, messageStore, rateLimiter, config, wrappedDownloadAttachment, wrappedProcessEmbeds, performance);
        const search = new MessageSearch(db, performance);
        const exporter = new MessageExporter(db, performance);

        const ctx = new AppContext({
            config, client, db, jobManager, syncEngine, performance, circuitBreaker,
            listeningChannels, withRetry, gracefulShutdown: null, search, exporter, dbManager, logger, messageStore
        });

        ctx.autoSyncIntervalMs = autoSyncSettings.intervalMs || 60 * 60 * 1000;

        const gracefulShutdown = await createGracefulShutdown(client, db, jobManager, ctx, logger);
        ctx.gracefulShutdown = gracefulShutdown;
        ctx.teardownProcessErrorHandlers = setupProcessErrorHandlers(gracefulShutdown, logger);
        teardownProcessErrorHandlers = ctx.teardownProcessErrorHandlers;

        // Wire up Discord rate-limit events to adaptive rate limiter. The handler
        // is kept by name so teardown can detach it — every client.on(...) here
        // must have a symmetric client.off(...) (the client is destroyed right
        // after teardown, but the listener registry should stay balanced).
        const onRateLimit = (info) => {
            const match = info.path?.match(/\/channels\/(\d+)\/messages/);
            const channelId = match ? match[1] : 'global';
            const timeout = info.timeout ?? 0;
            rateLimiter.updateFromRateLimit(channelId, timeout, info.global);
        };
        client.on('rateLimit', onRateLimit);

        // Setup shutdown handlers
        ctx.teardownShutdownHandlers = setupShutdownHandlers(client, db, jobManager, ctx, gracefulShutdown);
        teardownShutdownHandlers = ctx.teardownShutdownHandlers;

        // Create dependency-injected store function
        const storeMessagesWithDeps = async (messages, channel) => {
            await messageStore.storeMessagesBatch(
                messages,
                channel,
                withRetry,
                (url, channelId, filename, messageId, size) =>
                    downloadAttachment(url, channelId, filename, withRetry, config, messageId, size),
                 (embeds, channelId, messageId) =>
                     processEmbeds(embeds, channelId,
                         (url, cId, fn, mId) => downloadAttachment(url, cId, fn, withRetry, config, mId),
                         config, messageId, withRetry),
                // Realtime path gates on pause (not shutdown): the shutdown drain
                // must still be able to write queued messages before the DB closes.
                () => ctx.isPaused
            );
        };

        // Setup event handlers
        const eventTeardown = setupEventHandlers(
            client,
            listeningChannels,
            messageStore,
            () => ctx.isPaused,
            storeMessagesWithDeps,
            logger,
            config,
            ctx.runtimeMetrics
        );
        // Also detach the rate-limit listener so every client.on(...) registered
        // here has a symmetric off() on teardown.
        ctx.teardownEventHandlers = async () => {
            client.off('rateLimit', onRateLimit);
            await eventTeardown();
        };
        teardownEventHandlers = ctx.teardownEventHandlers;

        // Register ready handler BEFORE login so we never miss the event
        // (login() can resolve before the client-level ready event fires).
        client.once('ready', () => {
            console.log(chalk.green(`✅ Logged in as ${client.user.tag}`));
            if (autoSyncSettings.enabled && listeningChannels.size) {
                startAutoSync(ctx);
            }
            // Use new Blessed-based TUI
            startBlessedTUI(ctx).catch(err => {
                console.error(chalk.red('❌ TUI error:', err.message));
                logger?.error('TUI error', { error: err.message });
                gracefulShutdown('tui error', { exitCode: 1 }).catch(() => {});
            });
        });

        // Login and start
        try {
            await client.login(process.env.USER_TOKEN);
        } catch (err) {
            await handleFatalStartup('Login failed', err, {
                client,
                db,
                logger,
                teardownProcessErrorHandlers,
                teardownEventHandlers,
                teardownShutdownHandlers
            });
            return;
        }

    } catch (err) {
        await handleFatalStartup('Bootstrap error', err, {
            client,
            db,
            logger,
            teardownProcessErrorHandlers,
            teardownEventHandlers,
            teardownShutdownHandlers
        });
    }
}

bootstrap().catch(err => {
    console.error(chalk.red('❌ Fatal bootstrap error:', err));
    process.exit(1);
});
