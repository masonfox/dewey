import path from 'node:path';
import fs from 'fs-extra';
import { normalizeViaClaude } from './claude.js';
import { heuristicsFromName, sanitizeSegment, isAudio } from './utils.js';

const SOURCE_DIR = process.env.SOURCE_DIR || './data/incoming';
const DEST_DIR = process.env.DEST_DIR || './data/library';
const FILE_MODE = process.env.FILE_MODE || '664';
const DIR_MODE = process.env.DIR_MODE || '775';
const PUID = Number(process.env.PUID || 0);
const PGID = Number(process.env.PGID || 0);

// Returns canonical, normalized author and title for migration
function getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle, log, jobId }) {
  let authorRaw = meta?.author || heuristics?.author || 'Unknown';
  let titleRaw = meta?.title || heuristics?.title || fallbackTitle;
  
  const author = sanitizeSegment(authorRaw);
  const title = sanitizeSegment(titleRaw);
  
  // Log warning if we couldn't determine a proper author
  if (author === 'Unknown') {
    log?.warn(`[${jobId}] ⚠️  Could not determine author, using "Unknown" for "${fallbackTitle}"`);
  }
  
  return {
    author,
    title
  };
}

export async function migratePath(p, log) {
  const exists = await fs.pathExists(p);
  if (!exists) return;
  const stat = await fs.stat(p);
  if (stat.isDirectory()) return migrateDir(p, log);
  // For individual files, create a temporary directory and process as a directory
  return migrateFileAsDir(p, log);
}

// Generate a short job ID based on the source name
function generateJobId(sourceName) {
  // Take first 6 characters of base64 encoded hash for short, readable ID
  const hash = Buffer.from(sourceName).toString('base64').replace(/[+/=]/g, '').slice(0, 6);
  return hash.toUpperCase();
}

// Recursively discover all migration units (directories with audio or loose audio files)
// This prevents race conditions by doing all discovery upfront before any migration
export async function discoverMigrationUnits(rootDir) {
  const units = [];
  
  async function traverse(currentDir, isRoot = false) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      const directories = [];
      const audioFiles = [];
      
      // Separate directories and audio files
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          directories.push(fullPath);
        } else if (isAudio(fullPath)) {
          audioFiles.push(fullPath);
        }
      }
      
      // For the root directory (incoming), process contents but don't treat root as a unit
      if (isRoot) {
        // Add loose audio files in root as individual units
        for (const audioFile of audioFiles) {
          units.push({ type: 'file', path: audioFile });
        }
        // Continue to traverse subdirectories
        for (const subDir of directories) {
          await traverse(subDir, false);
        }
        return;
      }
      
      // For non-root directories: if this directory contains audio files, treat it as a migration unit
      if (audioFiles.length > 0) {
        units.push({ type: 'directory', path: currentDir });
        // Don't traverse subdirectories of directories that contain audio
        // (they should be processed as a single unit)
        return;
      }
      
      // If no audio files here, recursively check subdirectories
      for (const subDir of directories) {
        await traverse(subDir, false);
      }
    } catch (error) {
      // Skip directories that can't be read (permissions, etc.)
      console.warn(`Warning: Could not read directory ${currentDir}: ${error.message}`);
    }
  }
  
  // Start traversal from root, marking it as the root directory
  await traverse(rootDir, true);
  
  return units;
}

// Clean up empty directories recursively
export async function cleanupEmptyDirectories(rootDir, log) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    
    // First, recursively clean up subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(rootDir, entry.name);
        await cleanupEmptyDirectories(subDir, log);
        
        // After cleaning subdirectory, check if it's now empty
        try {
          const subEntries = await fs.readdir(subDir);
          if (subEntries.length === 0) {
            await fs.remove(subDir);
            log.info(`🧹 Cleaned up empty directory: "${entry.name}"`);
          }
        } catch (error) {
          // Directory might have already been removed, ignore
        }
      }
    }
  } catch (error) {
    // Root directory might not exist or be accessible, ignore
  }
}

async function migrateFileAsDir(file, log) {
  const base = path.basename(file);
  const jobId = generateJobId(base);
  
  if (!isAudio(file)) {
    return log.warn(`[${jobId}] ⚠️  Skipping non-audio file: "${base}"`);
  }

  log.info(`[${jobId}] 🎵 Starting file migration: "${base}"`);
  
  const heuristics = heuristicsFromName(base, path.dirname(file));
  const meta = (await normalizeViaClaude(base, heuristics.author, heuristics.title, log)) || {};
  const { author, title } = getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle: path.parse(base).name, log, jobId });
  const bookDir = path.join(DEST_DIR, author, title);
  await fs.ensureDir(bookDir, { mode: parseInt(DIR_MODE, 8) });

  // Copy the file with its original name - no renaming
  const target = path.join(bookDir, base);
  await fs.copy(file, target, { overwrite: true });
  await applyPerms(bookDir);

  await fs.remove(file);
  log.info(`[${jobId}] 📚 Migrated: "${base}" → "${author} / ${title}"`);
}

async function migrateDir(dir, log) {
  const base = path.basename(dir);
  
  // Special handling for the incoming directory - process its contents instead of treating it as a book
  if (base === 'incoming') {
    // Batch discovery: find all migration units (directories with audio or loose audio files) upfront
    const migrationUnits = await discoverMigrationUnits(dir);
    
    // Process each unit atomically - no more race conditions
    for (const unit of migrationUnits) {
      if (unit.type === 'directory') {
        await migrateDir(unit.path, log);
      } else {
        // Verify file still exists before processing (defensive programming)
        if (await fs.pathExists(unit.path)) {
          await migrateFileAsDir(unit.path, log);
        }
      }
    }
    
    // Clean up any empty directories left behind after processing
    await cleanupEmptyDirectories(dir, log);
    return;
  }

  const jobId = generateJobId(base);
  log.info(`[${jobId}] 📁 Starting directory migration: "${base}"`);

  // Copy only audio files from this directory (non-recursive)
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let copiedFiles = 0;
  const audioFiles = [];
  
  // First, collect all audio files in this directory
  for (const e of entries) {
    const src = path.join(dir, e.name);
    if (e.isDirectory()) continue;
    if (!isAudio(src)) continue;
    audioFiles.push({ src, name: e.name });
  }

  // If this directory has no audio files, don't process it as a book
  // (it's likely a container directory with subdirectories that have the actual audio)
  if (audioFiles.length === 0) {
    log.info(`[${jobId}] ⏭️  Skipping directory with no audio files: "${base}"`);
    return;
  }

  const heuristics = heuristicsFromName(base, null);
  const meta = (await normalizeViaClaude(base, heuristics.author, heuristics.title, log)) || {};
  const { author, title } = getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle: base, log, jobId });
  const bookDir = path.join(DEST_DIR, author, title);
  await fs.ensureDir(bookDir, { mode: parseInt(DIR_MODE, 8) });

  // Copy the audio files
  for (const { src, name } of audioFiles) {
    const target = path.join(bookDir, name);
    await fs.copy(src, target, { overwrite: true });
    copiedFiles++;
  }

  await applyPerms(bookDir);
  await fs.remove(dir);
  
  log.info(`[${jobId}] 📚 Migrated directory: "${base}" → "${author} / ${title}" (${copiedFiles} files)`);
}

async function applyPerms(target) {
  try { await fs.chown(target, PUID, PGID); } catch {}
  try { await fs.chmod(target, DIR_MODE); } catch {}
  const names = await fs.readdir(target).catch(() => []);
  for (const name of names) {
    const p = path.join(target, name);
    try {
      const s = await fs.stat(p);
      if (s.isDirectory()) await fs.chmod(p, DIR_MODE);
      else await fs.chmod(p, FILE_MODE);
      try { await fs.chown(p, PUID, PGID); } catch {}
    } catch {}
  }
}


