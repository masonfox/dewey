import path from 'node:path';
import fs from 'fs-extra';
import { promises as fsPromises } from 'node:fs';
import { normalizeViaClaude } from './claude.js';
import { heuristicsFromName, sanitizeSegment, isAudio } from './utils.js';
import { JobType } from './job.js';
import { SOURCE_DIR, DEST_DIR, FILE_MODE, DIR_MODE, PUID, PGID } from './config.js';
import { SkipError } from './errors.js';

// Re-export SkipError for backward compatibility
export { SkipError } from './errors.js';

// Returns canonical, normalized author and title for migration
function getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle, log }) {
  let authorRaw = meta?.author || heuristics?.author || 'Unknown';
  let titleRaw = meta?.title || heuristics?.title || fallbackTitle;
  
  const author = sanitizeSegment(authorRaw);
  const title = sanitizeSegment(titleRaw);
  
  // Log warning if we couldn't determine a proper author
  if (author === 'Unknown') {
    log?.warn(`⚠️  Could not determine author, using "Unknown" for "${fallbackTitle}"`);
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

/**
 * Main entry point for migrating a job - works with the new Job system
 */
export async function migrateJob(job, log) {
  log.info(`🎬 migrateJob called with job type: ${job.type}, id: ${job.id}, sourcePath: ${job.sourcePath}`);
  
  try {
    let result;
    if (job.type === JobType.FILE) {
      log.info(`📄 Calling migrateJobFile for ${job.id}`);
      result = await migrateJobFile(job, log);
    } else if (job.type === JobType.DIRECTORY) {
      log.info(`📁 Calling migrateJobDirectory for ${job.id}`);
      result = await migrateJobDirectory(job, log);
    } else {
      throw new Error(`Unsupported job type: ${job.type}`);
    }
    
    log.info(`✅ migrateJob completed successfully for ${job.id}:`, result);
    return result;
  } catch (error) {
    log.error(`❌ migrateJob failed for ${job.id}: ${error.message}`);
    log.error(`❌ Stack trace: ${error.stack}`);
    throw error;
  }
}

/**
 * Migrate a single file job
 */
async function migrateJobFile(job, log) {
  const file = job.sourcePath;
  const base = job.displayName;
  
  if (!isAudio(file)) {
    throw new Error(`Skipping non-audio file: "${base}"`);
  }

  log.info(`🚀 Starting file migration: ${file}`);
  
  // Verify source file exists and get stats
  if (!(await fs.pathExists(file))) {
    throw new Error(`Source file does not exist: ${file}`);
  }
  
  const sourceStats = await fs.stat(file);
  log.info(`📊 Source file size: ${sourceStats.size} bytes`);

  const heuristics = heuristicsFromName(base, path.dirname(file));
  const meta = (await normalizeViaClaude(base, heuristics.author, heuristics.title, log, path.dirname(file))) || {};
  const { author, title } = getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle: path.parse(base).name, log });
  
  const destDirRoot = DEST_DIR();
  const bookDir = path.join(destDirRoot, author, title);
  const target = path.join(bookDir, base);
  
  log.info(`📁 Target directory: ${bookDir}`);
  log.info(`📋 Target file: ${target}`);
  
  try {
    // Check if destination root exists and is writable
    if (!(await fs.pathExists(destDirRoot))) {
      throw new Error(`Destination root directory does not exist: ${destDirRoot}`);
    }
    
    const destRootStats = await fs.stat(destDirRoot);
    log.info(`📊 Dest root stats - mode: ${destRootStats.mode.toString(8)}, uid: ${destRootStats.uid}, gid: ${destRootStats.gid}`);
    
    // Try to create a test file to verify write permissions
    const testFile = path.join(destDirRoot, '.write-test-' + Date.now());
    try {
      await fs.writeFile(testFile, 'test');
      await fs.remove(testFile);
      log.info(`✅ Write permission verified for ${destDirRoot}`);
    } catch (writeTestError) {
      throw new Error(`Cannot write to destination directory ${destDirRoot}: ${writeTestError.message}`);
    }
    
    // Create the book directory
    log.info(`📁 Creating directory: ${bookDir}`);
    if (process.env.CI) {
      console.log(`[CI MIGRATE] About to create directory: ${bookDir}`);
    }
    await fs.ensureDir(bookDir, { mode: parseInt(DIR_MODE(), 8) });
    
    // Verify directory was created
    if (!(await fs.pathExists(bookDir))) {
      throw new Error(`Failed to create directory: ${bookDir}`);
    }
    log.info(`✅ Directory created successfully: ${bookDir}`);
    if (process.env.CI) {
      console.log(`[CI MIGRATE] Directory created successfully: ${bookDir}`);
    }

    // Copy the file with its original name - no renaming
    log.info(`📋 Copying file from ${file} to ${target}`);
    if (process.env.CI) {
      console.log(`[CI MIGRATE] About to copy file from ${file} to ${target}`);
    }
    
    // Try using Node.js built-in copyFile which might be more reliable in CI
    try {
      await fsPromises.copyFile(file, target);
      if (process.env.CI) {
        console.log(`[CI MIGRATE] Native copyFile completed`);
      }
    } catch (copyError) {
      log.error(`❌ Native copyFile failed: ${copyError.message}, trying fs-extra...`);
      if (process.env.CI) {
        console.log(`[CI MIGRATE] Native copyFile failed, trying fs-extra: ${copyError.message}`);
      }
      await fs.copy(file, target, { overwrite: true });
      if (process.env.CI) {
        console.log(`[CI MIGRATE] fs-extra copy completed`);
      }
    }
    
    // Small delay to ensure file system operations complete
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Verify the copy was successful
    if (!(await fs.pathExists(target))) {
      throw new Error(`Target file was not created: ${target}`);
    }
    if (process.env.CI) {
      console.log(`[CI MIGRATE] File copy verified: ${target}`);
    }
    
    const targetStats = await fs.stat(target);
    log.info(`📊 Target file size: ${targetStats.size} bytes`);
    
    if (sourceStats.size !== targetStats.size) {
      throw new Error(`File copy verification failed: size mismatch (source: ${sourceStats.size}, target: ${targetStats.size})`);
    }
    log.info(`✅ File copy verified: ${sourceStats.size} bytes`);
    
    await applyPerms(bookDir);
    
    // Only remove source after successful copy and verification
    await fs.remove(file);
    log.info(`🎉 Migrated: "${base}" → "${author} / ${title}"` );
    
    if (process.env.CI) {
      console.log(`[CI MIGRATE] Migration completed successfully. Checking final state...`);
      console.log(`[CI MIGRATE] Target file exists: ${await fs.pathExists(target)}`);
      console.log(`[CI MIGRATE] Book dir exists: ${await fs.pathExists(bookDir)}`);
      console.log(`[CI MIGRATE] Dest root contents: ${JSON.stringify(await fs.readdir(destDirRoot))}`);
    }
    
    return { author, title, files: 1 };
  } catch (error) {
    log.error(`❌ Migration failed for "${base}": ${error.message}`);
    log.error(`❌ Error stack: ${error.stack}`);
    
    // Additional debugging info
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
      log.error(`📊 Current process - uid: ${uid}, gid: ${gid}`);
      log.error(`📊 Source exists: ${await fs.pathExists(file)}`);
      log.error(`📊 Dest root exists: ${await fs.pathExists(destDirRoot)}`);
      log.error(`📊 Book dir exists: ${await fs.pathExists(bookDir)}`);
      log.error(`📊 Target exists: ${await fs.pathExists(target)}`);
    } catch (debugError) {
      log.error(`❌ Failed to gather debug info: ${debugError.message}`);
    }
    
    throw error;
  }
}

/**
 * Migrate a directory job
 */
async function migrateJobDirectory(job, log) {
  const dir = job.sourcePath;
  const base = job.displayName;

  log.info(`🚀 Starting directory migration: ${dir}`);

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

  log.info(`📊 Found ${audioFiles.length} audio files in directory`);

  // If this directory has no audio files, don't process it as a book
  if (audioFiles.length === 0) {
    throw new SkipError(`Skipping directory with no audio files: "${base}"`, 'no-audio-files');
  }

  const heuristics = heuristicsFromName(base, null);
  const meta = (await normalizeViaClaude(base, heuristics.author, heuristics.title, log, dir)) || {};
  const { author, title } = getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle: base, log });
  
  const destDirRoot = DEST_DIR();
  const bookDir = path.join(destDirRoot, author, title);
  
  log.info(`📁 Target directory: ${bookDir}`);
  
  try {
    // Check destination permissions
    if (!(await fs.pathExists(destDirRoot))) {
      throw new Error(`Destination root directory does not exist: ${destDirRoot}`);
    }
    
    const destRootStats = await fs.stat(destDirRoot);
    log.info(`📊 Dest root stats - mode: ${destRootStats.mode.toString(8)}, uid: ${destRootStats.uid}, gid: ${destRootStats.gid}`);
    
    // Create the book directory
    log.info(`📁 Creating directory: ${bookDir}`);
    await fs.ensureDir(bookDir, { mode: parseInt(DIR_MODE(), 8) });
    
    // Verify directory was created
    if (!(await fs.pathExists(bookDir))) {
      throw new Error(`Failed to create directory: ${bookDir}`);
    }
    log.info(`✅ Directory created successfully: ${bookDir}`);

    // Copy the audio files with verification
    for (const { src, name } of audioFiles) {
      const target = path.join(bookDir, name);
      log.info(`📋 Copying file from ${src} to ${target}`);
      
      const sourceStats = await fs.stat(src);
      
      // Try using Node.js built-in copyFile which might be more reliable in CI
      try {
        await fsPromises.copyFile(src, target);
      } catch (copyError) {
        log.error(`❌ Native copyFile failed for ${name}: ${copyError.message}, trying fs-extra...`);
        await fs.copy(src, target, { overwrite: true });
      }
      
      // Small delay to ensure file system operations complete
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify each file copy
      if (!(await fs.pathExists(target))) {
        throw new Error(`Target file was not created: ${target}`);
      }
      
      const targetStats = await fs.stat(target);
      
      if (sourceStats.size !== targetStats.size) {
        throw new Error(`File copy verification failed for "${name}": size mismatch (source: ${sourceStats.size}, target: ${targetStats.size})`);
      }
      log.info(`✅ File copy verified: ${name} (${sourceStats.size} bytes)`);
      copiedFiles++;
    }

    await applyPerms(bookDir);
    
    // Only remove source directory after all files are successfully copied and verified
    await fs.remove(dir);
    
    // Clean up any empty parent directories that might have been left behind
    await cleanupEmptyParentDirectories(dir, log);
    
    log.info(`🎉 Migrated directory: "${base}" → "${author} / ${title}" (${copiedFiles} files)`);
    
    return { author, title, files: copiedFiles };
  } catch (error) {
    log.error(`❌ Directory migration failed for "${base}": ${error.message}`);
    log.error(`❌ Error stack: ${error.stack}`);
    
    // Additional debugging info
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
      log.error(`📊 Current process - uid: ${uid}, gid: ${gid}`);
      log.error(`📊 Source dir exists: ${await fs.pathExists(dir)}`);
      log.error(`📊 Dest root exists: ${await fs.pathExists(destDirRoot)}`);
      log.error(`📊 Book dir exists: ${await fs.pathExists(bookDir)}`);
    } catch (debugError) {
      log.error(`❌ Failed to gather debug info: ${debugError.message}`);
    }
    
    throw error;
  }
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

// Clean up empty parent directories after removing a directory
async function cleanupEmptyParentDirectories(removedDir, log) {
  const sourceDir = path.resolve(SOURCE_DIR());
  let currentDir = path.dirname(removedDir);
  
  // Walk up the directory tree and remove empty directories
  while (currentDir !== sourceDir && currentDir !== path.dirname(currentDir)) {
    try {
      const entries = await fs.readdir(currentDir);
      if (entries.length === 0) {
        await fs.remove(currentDir);
        log.info(`🧹 Cleaned up empty parent directory: "${path.basename(currentDir)}"`);
        currentDir = path.dirname(currentDir);
      } else {
        // Directory is not empty, stop cleanup
        break;
      }
    } catch (error) {
      // Directory might not exist or be accessible, stop cleanup
      break;
    }
  }
}

// Clean up empty directories recursively
export async function cleanupEmptyDirectories(rootDir, log, preserveRoot = null) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    
    // First, recursively clean up subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(rootDir, entry.name);
        await cleanupEmptyDirectories(subDir, log, preserveRoot);
        
        // After cleaning subdirectory, check if it's now empty
        // but don't delete if it's the preserved root directory
        try {
          const subEntries = await fs.readdir(subDir);
          if (subEntries.length === 0 && (!preserveRoot || path.resolve(subDir) !== path.resolve(preserveRoot))) {
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
  const { Job } = await import('./job.js');
  const job = await Job.fromPath(file);
  const jobLog = job.createLogger(log);
  
  return await migrateJobFile(job, jobLog);
}

async function migrateDir(dir, log) {
  const base = path.basename(dir);
  
  // Special handling for the root SOURCE_DIR - process its contents instead of treating it as a book
  const resolvedSourceDir = path.resolve(SOURCE_DIR());
  const resolvedDir = path.resolve(dir);
  if (resolvedDir === resolvedSourceDir) {
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
    // but NEVER delete the root source directory itself
    await cleanupEmptyDirectories(dir, log, dir);
    return;
  }

  // Use the new job-based approach
  const { Job } = await import('./job.js');
  const job = await Job.fromPath(dir);
  const jobLog = job.createLogger(log);
  
  return await migrateJobDirectory(job, jobLog);
}

async function applyPerms(target) {
  try {
    // Apply ownership and permissions to the directory
    try { 
      await fs.chown(target, PUID(), PGID()); 
    } catch (chownError) {
      // Ownership changes might fail in containers or restricted environments
      // This is non-fatal, so we continue
    }
    
    try { 
      await fs.chmod(target, parseInt(DIR_MODE(), 8)); 
    } catch (chmodError) {
      // Permission changes might fail in restricted environments
      // This is non-fatal, so we continue
    }
    
    // Apply permissions to all files in the directory
    const names = await fs.readdir(target).catch(() => []);
    for (const name of names) {
      const p = path.join(target, name);
      try {
        const s = await fs.stat(p);
        if (s.isDirectory()) {
          await fs.chmod(p, parseInt(DIR_MODE(), 8));
        } else {
          await fs.chmod(p, parseInt(FILE_MODE(), 8));
        }
        try { 
          await fs.chown(p, PUID(), PGID()); 
        } catch (chownError) {
          // Ownership changes might fail, but this is non-fatal
        }
      } catch (statError) {
        // File might have been deleted or is inaccessible, skip it
      }
    }
  } catch (error) {
    // Don't let permission failures break the migration
    // but log them for debugging
    console.warn(`Warning: Failed to apply permissions to ${target}: ${error.message}`);
  }
}


