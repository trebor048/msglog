import dotenv from 'dotenv';
import chalk from 'chalk';
import { Client } from 'discord.js-selfbot-v13';

import { loadConfig } from './setup.js';
import { initDatabase } from './setup.js';
import { CircuitBreaker, createWithRetry, AdaptiveRateLimiter } from './resilience.js';
import { JobManager } from './jobManager.js';
import { MessageStore, downloadAttachment, processEmbeds } from './storage.js';
import { SyncEngine } from './syncEngine.js';
import { setupEventHandlers, setupShutdownHandlers, createGracefulShutdown } from './lifecycle.js';
import startBlessedTUI from '../blessed-tui/index.js';
import { MessageSearch, MessageExporter, DatabaseManager } from './data.js';
import { PerformanceManager } from './performance.js';
import { Logger } from './logger.js';
import { Validator } from './utils.js';

dotenv.config();

// Autosync helper functions
function startAutoSync(ctx) {
    if (ctx.autoSyncEnabled || !ctx.listeningChannels.size) return;
    
    ctx.autoSyncEnabled = true;
    console.log(chalk.green(`✅ Autosync enabled (every ${ctx.autoSyncIntervalMs / 1000 / 60} minutes)`));

    const runSync = async () => {
        if (ctx.isShuttingDown || ctx.isPaused) return;
        
        const running = ctx.jobManager.getAllJobs().filter(j => j.status === 'running');
        if (running.length >= ctx.config.maxConcurrentJobs) return;
        
        await ctx.syncEngine.syncAllChannelsParallel(ctx.client, ctx.listeningChannels, ctx.withRetry, ctx.isShuttingDown, () => ctx.isPaused);
    };

    // Run immediately on startup
    runSync();
    
    ctx.autoSyncInterval = setInterval(runSync, ctx.autoSyncIntervalMs);
}

function stopAutoSync(ctx) {
    if (!ctx.autoSyncEnabled) return;
    
    ctx.autoSyncEnabled = false;
    if (ctx.autoSyncInterval) {
        clearInterval(ctx.autoSyncInterval);
        ctx.autoSyncInterval = null;
    }
    console.log(chalk.yellow('⏹️ Autosync disabled'));
}

// Application context container - reduces parameter passing
class AppContext {
    constructor(options) {
        const {
            config, client, db, jobManager, syncEngine, performance, circuitBreaker,
            listeningChannels, withRetry, gracefulShutdown, search, exporter, dbManager, logger
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
        this.isPaused = false;
        this.isShuttingDown = false;
        this.autoSyncEnabled = false;
        this.autoSyncInterval = null;
        this.autoSyncIntervalMs = 60 * 60 * 1000; // 1 hour default
    }
}

async function bootstrap() {
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
        const client = new Client({ checkUpdate: false, syncStatus: false });

        // Initialize database
        const db = initDatabase(config);

        // Initialize resilience patterns
        const circuitBreaker = new CircuitBreaker(5, 60000);
        const withRetry = createWithRetry(config, circuitBreaker);
        const rateLimiter = new AdaptiveRateLimiter(config);

        // Initialize managers and stores
        const jobManager = new JobManager();
        const performance = new PerformanceManager();
        const logger = new Logger();
        const dbManager = new DatabaseManager(db, performance);
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
                config, messageId);

        const syncEngine = new SyncEngine(jobManager, messageStore, rateLimiter, config, wrappedDownloadAttachment, wrappedProcessEmbeds, performance);
        const search = new MessageSearch(db, performance);
        const exporter = new MessageExporter(db, performance);

        const ctx = new AppContext({
            config, client, db, jobManager, syncEngine, performance, circuitBreaker,
            listeningChannels, withRetry, gracefulShutdown: null, search, exporter, dbManager, logger
        });

        ctx.autoSyncIntervalMs = autoSyncSettings.intervalMs || 60 * 60 * 1000;

        const gracefulShutdown = await createGracefulShutdown(client, db, jobManager, ctx, logger);
        ctx.gracefulShutdown = gracefulShutdown;

        // Wire up Discord rate-limit events to adaptive rate limiter
        client.on('rateLimit', info => {
            const match = info.path?.match(/\/channels\/(\d+)\/messages/);
            const channelId = match ? match[1] : 'global';
            const timeout = info.timeout ?? info.time ?? 0;
            rateLimiter.updateFromRateLimit(channelId, timeout, info.global);
        });

        // Setup shutdown handlers
        setupShutdownHandlers(client, db, jobManager, ctx, gracefulShutdown);

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
                        config, messageId),
                () => ctx.isShuttingDown
            );
        };

        // Setup event handlers
        setupEventHandlers(client, listeningChannels, messageStore, () => ctx.isPaused, storeMessagesWithDeps, logger);

        // Login and start
        client.login(process.env.USER_TOKEN).catch(err => {
            console.error(chalk.red('❌ Login failed:', err.message));
            logger?.error('Login failed', { error: err.message });
            process.exit(1);
        });

        client.once('ready', () => {
            console.log(chalk.green(`✅ Logged in as ${client.user.tag}`));
            if (autoSyncSettings.enabled && listeningChannels.size) {
                startAutoSync(ctx);
            }
            // Use new Blessed-based TUI
            startBlessedTUI(ctx).catch(err => {
                console.error(chalk.red('❌ TUI error:', err.message));
                logger?.error('TUI error', { error: err.message });
                gracefulShutdown('tui error');
            });
        });

    } catch (err) {
        console.error(chalk.red('❌ Bootstrap error:', err.message));
        process.exit(1);
    }
}

bootstrap();

export { startAutoSync, stopAutoSync };