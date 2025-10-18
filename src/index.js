import dotenv from 'dotenv';

// Load environment variables from .env file FIRST
dotenv.config();

import chokidar from 'chokidar';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'node:path';
import http from 'node:http';
import { JobQueue } from './jobQueue.js';
import { validateClaude } from './claude.js';
import { LOG_FILE, LOG_LEVEL, SOURCE_DIR, DEST_DIR, DIRECTORY_STABILITY_TIMEOUT, validateConfig } from './config.js';
import { isFatal } from './errors.js';

// Validate configuration early - fail fast if config is invalid
try {
  const warnings = validateConfig();
  // We'll log warnings after the logger is set up
  if (warnings.length > 0) {
    // Store for later logging
    globalThis.__configWarnings = warnings;
  }
} catch (error) {
  if (isFatal(error)) {
    console.error(`\n❌ Fatal Configuration Error:\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

await fs.ensureFile(LOG_FILE());

const log = pino({
  level: LOG_LEVEL(),
  transport: {
    targets: [
      { 
        target: 'pino-pretty', 
        options: { 
          translateTime: 'HH:MM:ss',
          colorize: true,
          ignore: 'pid,hostname',
          messageFormat: '{msg}'
        } 
      },
      { target: 'pino/file', options: { destination: LOG_FILE(), mkdir: true } }
    ]
  }
});

// Initialize the job queue
const jobQueue = new JobQueue({
  stabilityTimeout: DIRECTORY_STABILITY_TIMEOUT(),
  batchProcessDelay: 300,
  sourceDir: SOURCE_DIR()
});

// Simple enqueue function that delegates to the job queue
const enqueue = async (p) => {
  await jobQueue.enqueue(p);
};

// Application status for healthcheck
let appStatus = {
  ready: false,
  watcherReady: false,
  startTime: new Date().toISOString(),
  lastActivity: null,
  watchedPath: SOURCE_DIR(),
  errors: []
};

log.info(`🚀 Welcome! Starting Dewey, your intelligent audiobook migrator!`);

// Log any configuration warnings
if (globalThis.__configWarnings && globalThis.__configWarnings.length > 0) {
  for (const warning of globalThis.__configWarnings) {
    log.warn(`⚠️  ${warning}`);
  }
  delete globalThis.__configWarnings;
}

// Ensure source directory exists
await fs.ensureDir(SOURCE_DIR());
await fs.ensureDir(DEST_DIR());

// Initialize job queue with logger
jobQueue.setLogger(log);

// Validate Claude on boot (non-fatal)
await validateClaude(log);

// Set up periodic job cleanup (every 5 minutes)
setInterval(() => {
  jobQueue.cleanup();
}, 300000);

// Create a simple HTTP server for health status
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(appStatus, null, 2));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, 'localhost', () => {
  log.info('🏥 Health check server listening on /health');
});

log.info(`📁 Watching: ${SOURCE_DIR()}`);
log.info(`⏱️  Directory stability timeout: ${DIRECTORY_STABILITY_TIMEOUT()/1000}s`);
log.info(`🔍 Poll interval: ${Math.min(DIRECTORY_STABILITY_TIMEOUT() / 10, 200)}ms`);

const watcher = chokidar
  .watch(SOURCE_DIR(), { 
    ignoreInitial: false, 
    depth: 3, 
    awaitWriteFinish: { 
      stabilityThreshold: DIRECTORY_STABILITY_TIMEOUT(),  // Use configurable timeout
      pollInterval: Math.min(DIRECTORY_STABILITY_TIMEOUT() / 10, 200)  // Poll every 10% of timeout, max 200ms
    },
    ignorePermissionErrors: true,
    persistent: true
  })
  .on('ready', () => {
    appStatus.watcherReady = true;
    appStatus.ready = true;
    log.info("=== ✅ Dewey is ready and watching! 👀 ===\n");
  })
  .on('add', (path) => {
    appStatus.lastActivity = new Date().toISOString();
    enqueue(path);
  })
  .on('addDir', (path) => {
    appStatus.lastActivity = new Date().toISOString();
    enqueue(path);
  })
  .on('change', (path) => {
    appStatus.lastActivity = new Date().toISOString();
    enqueue(path);
  })
  .on('unlink', () => {})
  .on('unlinkDir', () => {})
  .on('error', (err) => {
    const errorMsg = `❌ Watch error: ${String(err)}`;
    log.error(errorMsg);
    appStatus.errors.push({
      timestamp: new Date().toISOString(),
      error: String(err)
    });
    // Keep only last 10 errors
    if (appStatus.errors.length > 10) {
      appStatus.errors = appStatus.errors.slice(-10);
    }
  });


