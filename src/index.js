import dotenv from 'dotenv';

// Load environment variables from .env file FIRST
dotenv.config();

import chokidar from 'chokidar';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'node:path';
import { migratePath } from './migrate.js';
import { validateClaude } from './claude.js';

const LOG_FILE = process.env.LOG_FILE || './data/migrations.log';
await fs.ensureFile(LOG_FILE);

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
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
      { target: 'pino/file', options: { destination: LOG_FILE, mkdir: true } }
    ]
  }
});

const SOURCE_DIR = process.env.SOURCE_DIR || './data/incoming';
const DIRECTORY_STABILITY_TIMEOUT = Number(process.env.DIRECTORY_STABILITY_TIMEOUT || 5000); // 5 seconds default

const pending = new Set();
const directoryStability = new Map(); // Track directory stability
let timer = null;

const enqueue = (p) => {
  pending.add(p);
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
};

const isDirectoryStable = async (dirPath) => {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return true;
    
    // Check if directory has been stable for the configured timeout
    const now = Date.now();
    const lastModified = stat.mtime.getTime();
    const stabilityTime = DIRECTORY_STABILITY_TIMEOUT;
    
    if (now - lastModified < stabilityTime) {
      return false;
    }
    
    // Additional check: ensure no files are currently being written
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(dirPath, entry.name);
        const fileStat = await fs.stat(filePath);
        const fileAge = now - fileStat.mtime.getTime();
        if (fileAge < stabilityTime) {
          return false;
        }
      }
    }
    
    return true;
  } catch (error) {
    log.warn({ err: error.message, path: dirPath }, 'error checking directory stability');
    return false;
  }
};

// Track directories being processed to avoid duplicate processing
const processingDirectories = new Set();
// Track directories scheduled for re-processing to avoid duplicate re-queuing
const reQueuedDirectories = new Set();

const flush = async () => {
  const batch = Array.from(pending);
  pending.clear();
  
  // Group paths by their parent directory to process directories as units
  const directoryGroups = new Map();
  const individualFiles = [];
  
  for (const p of batch) {
    try {
      // Skip the root SOURCE_DIR itself - we only process its contents
      const resolvedSourceDir = path.resolve(SOURCE_DIR);
      const resolvedPath = path.resolve(p);
      if (resolvedPath === resolvedSourceDir) {
        log.debug(`🏠 Skipping root source directory: ${path.basename(p)}`);
        continue;
      }
      
      const stat = await fs.stat(p);
      const parentDir = path.dirname(p);
      
      if (stat.isDirectory()) {
        directoryGroups.set(p, [p]);
      } else {
        // Check if this file's parent directory is already being processed
        if (processingDirectories.has(parentDir)) {
          const fileName = path.basename(p);
          const parentName = path.basename(parentDir);
          log.info(`📁 Skipping file "${fileName}" - parent directory "${parentName}" being processed`);
          continue;
        }
        
        // Check if parent directory exists and has multiple files
        const parentStat = await fs.stat(parentDir).catch(() => null);
        if (parentStat && parentStat.isDirectory()) {
          const parentFiles = await fs.readdir(parentDir, { withFileTypes: true });
          const audioFiles = parentFiles.filter(f => f.isFile() && /\.(mp3|m4b)$/i.test(f.name));
          
          if (audioFiles.length > 1) {
            // This is part of a multi-file directory - process the directory instead
            if (!directoryGroups.has(parentDir)) {
              directoryGroups.set(parentDir, []);
            }
            continue;
          }
        }
        
        individualFiles.push(p);
      }
    } catch (e) {
      log.error({ err: e?.message || String(e), path: p }, 'error analyzing path');
    }
  }
  
  // Process directories first
  for (const [dirPath, _] of directoryGroups) {
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;
      
      // Skip if already scheduled for re-processing
      if (reQueuedDirectories.has(dirPath)) {
        const dirName = path.basename(dirPath);
        log.debug(`⏳ Skipping directory "${dirName}" - already scheduled for re-processing`);
        continue;
      }
      
      const isStable = await isDirectoryStable(dirPath);
      if (!isStable) {
        if (!reQueuedDirectories.has(dirPath)) {
          const dirName = path.basename(dirPath);
          log.info(`⏳ Directory "${dirName}" not yet stable, waiting ${DIRECTORY_STABILITY_TIMEOUT/1000}s...`);
          reQueuedDirectories.add(dirPath);
          setTimeout(() => {
            reQueuedDirectories.delete(dirPath);
            enqueue(dirPath);
          }, DIRECTORY_STABILITY_TIMEOUT);
        } else {
          const dirName = path.basename(dirPath);
          log.debug(`⏳ Directory "${dirName}" already scheduled for re-processing`);
        }
        continue;
      }
      
      processingDirectories.add(dirPath);
      await migratePath(dirPath, log);
      processingDirectories.delete(dirPath);
      
      // Clean up empty parent directories after processing
      const parentDir = path.dirname(dirPath);
      const resolvedSourceDir = path.resolve(SOURCE_DIR);
      if (parentDir !== resolvedSourceDir && path.resolve(parentDir).startsWith(resolvedSourceDir)) {
        try {
          const entries = await fs.readdir(parentDir);
          if (entries.length === 0) {
            await fs.remove(parentDir);
            const parentName = path.basename(parentDir);
            log.info(`🧹 Cleaned up empty parent directory: "${parentName}"`);
          }
        } catch (error) {
          // Parent directory might not exist or be accessible, ignore
        }
      }
    } catch (e) {
      // Don't log ENOENT errors as errors - directory was likely already processed
      if (e.code === 'ENOENT') {
        const dirName = path.basename(dirPath);
        log.debug(`✅ Directory "${dirName}" no longer exists - likely already processed`);
      } else {
        const dirName = path.basename(dirPath);
        log.error(`❌ Directory migration failed for "${dirName}": ${e?.message || String(e)}`);
      }
      processingDirectories.delete(dirPath);
    }
  }
  
  // Process individual files
  for (const p of individualFiles) {
    try {
      await migratePath(p, log);
    } catch (e) {
      const fileName = path.basename(p);
      log.error(`❌ File migration failed for "${fileName}": ${e?.message || String(e)}`);
    }
  }
};

log.info(`🚀 Welcome! Starting Dewey, your intelligent audiobook migrator!`);

// Ensure source directory exists
await fs.ensureDir(SOURCE_DIR);

// Validate Claude on boot (non-fatal)
await validateClaude(log);

log.info(`📁 Watching: ${SOURCE_DIR}`);
log.info(`⏱️  Directory stability timeout: ${DIRECTORY_STABILITY_TIMEOUT/1000}s`);
log.info(`🔍 Poll interval: ${Math.min(DIRECTORY_STABILITY_TIMEOUT / 10, 200)}ms`);
log.info("=== ✅ Dewey is ready and watching! 👀 ===\n");

chokidar
  .watch(SOURCE_DIR, { 
    ignoreInitial: false, 
    depth: 3, 
    awaitWriteFinish: { 
      stabilityThreshold: DIRECTORY_STABILITY_TIMEOUT,  // Use configurable timeout
      pollInterval: Math.min(DIRECTORY_STABILITY_TIMEOUT / 10, 200)  // Poll every 10% of timeout, max 200ms
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


