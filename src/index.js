import dotenv from 'dotenv';

// Load environment variables from .env file FIRST
dotenv.config();

import chokidar from 'chokidar';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'node:path';
import { JobQueue } from './jobQueue.js';
import { validateClaude } from './claude.js';
import { LOG_FILE, LOG_LEVEL, SOURCE_DIR, DEST_DIR, DIRECTORY_STABILITY_TIMEOUT } from './config.js';
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

log.info(`🚀 Welcome! Starting Dewey, your intelligent audiobook migrator!`);

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

log.info(`📁 Watching: ${SOURCE_DIR()}`);
log.info(`⏱️  Directory stability timeout: ${DIRECTORY_STABILITY_TIMEOUT()/1000}s`);
log.info(`🔍 Poll interval: ${Math.min(DIRECTORY_STABILITY_TIMEOUT() / 10, 200)}ms`);
log.info("=== ✅ Dewey is ready and watching! 👀 ===\n");

chokidar
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
  .on('add', enqueue)
  .on('addDir', enqueue)
  .on('change', enqueue)
  .on('unlink', () => {})
  .on('unlinkDir', () => {})
  .on('error', (err) => log.error(`❌ Watch error: ${String(err)}`));


