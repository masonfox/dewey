import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { promises as fsPromises, constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { normalizeViaAI } from './ai.js';
import { heuristicsFromName, sanitizeSegment, isSupportedBook, bookFileKind, isPathWithin, isWithinReviewDir } from './utils.js';
import { JobType } from './job.js';
import { SOURCE_DIR, DEST_DIR, REVIEW_DIR, DRY_RUN, FILE_MODE, DIR_MODE, PUID, PGID } from './config.js';
import { SkipError } from './errors.js';
import { extractAudioMetadata, extractEpubMetadata, extractDirectoryMetadata } from './metadata.js';
import { findCandidates, resolveMatch } from './matching.js';
import { getLayout } from './layout.js';

// Re-export SkipError for backward compatibility
export { SkipError } from './errors.js';

/** Staging prefix for in-flight copies (D7); dot-prefixed so library scanners skip it */
export const PARTIAL_PREFIX = '.dewey-partial-';
export const REVIEW_FILE = 'dewey-review.json';

const DRY = '🧪 [dry-run]';

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
  log.debug(`🎬 migrateJob called with job type: ${job.type}, id: ${job.id}, sourcePath: ${job.sourcePath}`);

  try {
    if (job.type !== JobType.FILE && job.type !== JobType.DIRECTORY) {
      throw new Error(`Unsupported job type: ${job.type}`);
    }
    const result = await migrateUnit(job, log);
    log.debug(`✅ migrateJob completed successfully for ${job.id}:`, result);
    return result;
  } catch (error) {
    log.error(`❌ migrateJob failed for ${job.id}: ${error.message}`);
    log.error(`❌ Stack trace: ${error.stack}`);
    throw error;
  }
}

/** Build, plan, and execute one job's unit (D1) */
async function migrateUnit(job, log) {
  const unit = await buildUnit(job, log);
  const plan = await planUnit(unit, log);
  return executePlan(plan, { dryRun: DRY_RUN(), log });
}

// ---------------------------------------------------------------------------
// Unit building

/** Loose files directly in SOURCE_DIR (and top-level directories) have no useful parent */
function contextParent(p) {
  const parent = path.dirname(p);
  return path.resolve(parent) === path.resolve(SOURCE_DIR()) ? null : parent;
}

function logMetadata(label, metadata, log) {
  if (metadata?.hasMetadata) {
    log.info(`${label}: Author: "${metadata.author || 'N/A'}", Title: "${metadata.title || 'N/A'}", Year: "${metadata.year || 'N/A'}"`);
  } else {
    log.debug(`🔍 No embedded metadata found, using heuristics`);
  }
}

/**
 * Describe a job's source as a migration unit (D1): its supported files with kind, read-aloud flag,
 * size, and metadata, plus the normalized author/title.
 * @returns {Promise<{ job, type, sourcePath, displayName, parentDir, author, title, formats: string[],
 *   metadata: Object|null, files: Array<{ path, name, kind, readaloud, size, metadata }> }>}
 */
export async function buildUnit(job, log) {
  const source = job.sourcePath;
  const base = job.displayName;
  let files;
  let metadata;
  let heuristics;
  let fallbackTitle;

  if (job.type === JobType.FILE) {
    if (!isSupportedBook(source)) {
      throw new Error(`Skipping non-audio file: "${base}"`);
    }
    log.debug(`🚀 Starting file migration: ${source}`);
    if (!(await fs.pathExists(source))) {
      throw new Error(`Source file does not exist: ${source}`);
    }
    const kind = bookFileKind(source);
    metadata = kind === 'epub' ? await extractEpubMetadata(source, log) : await extractAudioMetadata(source, log);
    logMetadata(kind === 'epub' ? '📖 File metadata' : '🎵 File metadata', metadata, log);
    files = [{ path: source, name: base, kind, readaloud: !!metadata?.readaloud, metadata: metadata || null }];
    heuristics = heuristicsFromName(base, path.dirname(source));
    fallbackTitle = path.parse(base).name;
  } else {
    log.debug(`🚀 Starting directory migration: ${source}`);
    // Direct supported files only (non-recursive)
    const entries = await fs.readdir(source, { withFileTypes: true });
    const paths = entries
      .filter(e => !e.isDirectory() && isSupportedBook(e.name))
      .map(e => path.join(source, e.name))
      .sort();
    log.debug(`📊 Found ${paths.length} book files in directory`);
    if (paths.length === 0) {
      throw new SkipError(`Skipping directory with no audio files: "${base}"`, 'no-audio-files');
    }
    metadata = await extractDirectoryMetadata(source, log);
    logMetadata('🎵 Directory metadata', metadata, log);
    const described = new Map((metadata?.files || []).map(f => [path.resolve(f.path), f]));
    files = paths.map(p => {
      const d = described.get(path.resolve(p));
      return { path: p, name: path.basename(p), kind: bookFileKind(p), readaloud: !!d?.readaloud, metadata: d?.metadata || null };
    });
    heuristics = heuristicsFromName(base, null);
    fallbackTitle = base;
  }

  for (const file of files) file.size = (await fs.stat(file.path)).size;
  const formats = [...new Set(files.map(f => f.kind))];
  const parentDir = contextParent(source);
  const meta = (await normalizeViaAI(base, heuristics.author, heuristics.title, log, parentDir, metadata, formats)) || {};
  const { author, title } = getCanonicalAuthorTitle({ meta, heuristics, fallbackTitle, log });

  return { job, type: job.type, sourcePath: source, displayName: base, parentDir, author, title, formats, metadata: metadata || null, files };
}

// ---------------------------------------------------------------------------
// Planning

/** Streaming SHA-256 of a file */
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Same size, then same SHA-256 (hashing only when sizes match) */
export async function filesIdentical(a, b) {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

async function listNames(dir) {
  try {
    return (await fs.readdir(dir)).filter(name => !name.startsWith(PARTIAL_PREFIX));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

/** Names of read-aloud EPUBs already in the book folder; read only when a read-aloud file arrives */
async function existingReadaloudNames(bookDir, names, unit, log) {
  if (!unit.files.some(f => f.kind === 'epub' && f.readaloud)) return [];
  const readaloud = [];
  for (const name of names.filter(n => bookFileKind(n) === 'epub')) {
    const metadata = await extractEpubMetadata(path.join(bookDir, name), log);
    if (metadata?.readaloud) readaloud.push(name);
  }
  return readaloud;
}

/**
 * Plan a unit (D1, D7): match it against the library, choose the book folder (an existing
 * folder's names win), name each file through the layout, and classify each destination as
 * `copy`, `skip-identical`, or a conflict. Reads the filesystem but never writes.
 * @returns {Promise<{ outcome: 'place'|'quarantine', unit, bookDir: string|null, match,
 *   actions: Array<{ src, dest, op: 'copy'|'skip-identical', renamed: boolean }>,
 *   conflicts: Array<{ src, dest, why }>, reason: string|null, explanation: string, paths: string[] }>}
 */
export async function planUnit(unit, log) {
  const candidates = await findCandidates(unit, log);
  const match = await resolveMatch(unit, candidates, log);
  const base = { unit, match, actions: [], conflicts: [] };

  if (match.outcome === 'ambiguous') {
    return {
      ...base, outcome: 'quarantine', bookDir: null, reason: 'ambiguous',
      explanation: `${match.reason} (${match.signal})`,
      paths: match.candidates.map(c => c.path)
    };
  }

  const layout = getLayout();
  const bookDir = match.candidate ? match.candidate.path : layout.bookDir(DEST_DIR(), unit.author, unit.title);
  const bookTitle = match.candidate ? match.candidate.title : path.basename(bookDir);
  const existing = await listNames(bookDir);
  const readaloudNames = await existingReadaloudNames(bookDir, existing, unit, log);
  const planned = [];

  // Originals before read-aloud EPUBs, so a same-named read-aloud sees the original it collides with
  const ordered = [...unit.files].sort((a, b) => Number(a.readaloud) - Number(b.readaloud) || a.name.localeCompare(b.name));
  for (const file of ordered) {
    const name = layout.fileName(file, { title: bookTitle, existingNames: [...existing, ...planned], readaloudNames });
    const dest = path.join(bookDir, name);
    const renamed = name !== file.name;
    if (planned.some(n => n.toLowerCase() === name.toLowerCase())) {
      base.conflicts.push({ src: file.path, dest, why: 'another file in the unit has the same destination name' });
    } else if (await fs.pathExists(dest)) {
      if (await filesIdentical(file.path, dest)) {
        base.actions.push({ src: file.path, dest, op: 'skip-identical', renamed });
      } else {
        base.conflicts.push({ src: file.path, dest, why: 'a different file already exists at the destination' });
      }
    } else {
      base.actions.push({ src: file.path, dest, op: 'copy', renamed });
    }
    planned.push(name);
    if (file.kind === 'epub' && file.readaloud) readaloudNames.push(name);
  }

  if (base.conflicts.length) {
    return {
      ...base, outcome: 'quarantine', bookDir, reason: 'conflict',
      explanation: base.conflicts.map(c => `${path.basename(c.src)} → ${path.relative(DEST_DIR(), c.dest)}: ${c.why}`).join('; '),
      paths: [...new Set(base.conflicts.map(c => c.dest))]
    };
  }
  return { ...base, outcome: 'place', bookDir, reason: null, explanation: match.reason, paths: [bookDir] };
}

// ---------------------------------------------------------------------------
// Execution

function describeAction(action) {
  const from = path.basename(action.src);
  const to = path.basename(action.dest);
  const verb = action.op === 'copy' ? 'copied' : 'skipped identical';
  return `${verb}: "${from}"${action.renamed ? ` → "${to}" (renamed by layout)` : ''}`;
}

/**
 * Perform (or, with dryRun, only log) a plan (D7, D8). Placement stages each copy to
 * `.dewey-partial-<jobId>-<name>`, verifies its size, renames it into place without clobbering,
 * and removes the unit's sources only after every action succeeded. On failure the current
 * partial is deleted, files already renamed stay (they resolve as skip-identical on reprocessing),
 * and the sources stay. Quarantine moves the source to REVIEW_DIR.
 * @returns {Promise<Object>} `{ author, title, files }` when placed; `{ outcome: 'quarantined', reason,
 *   reviewPath, files }` when quarantined; `dryRun: true` is added in dry-run mode
 */
export async function executePlan(plan, { dryRun = false, log } = {}) {
  if (plan.outcome === 'quarantine') return quarantine(plan, { dryRun, log });

  const { unit, bookDir, actions } = plan;
  const prefix = dryRun ? `${DRY} would place` : '📂 Placing';
  const author = path.basename(path.dirname(bookDir));
  const title = path.basename(bookDir);
  log.info(`${prefix} "${unit.displayName}" in ${bookDir}`);

  if (dryRun) {
    if (!(await fs.pathExists(bookDir))) log.info(`${DRY} would create folder ${bookDir}`);
    for (const action of actions) {
      log.info(`${DRY} would have ${describeAction(action)}${action.op === 'copy' ? ` into ${bookDir}` : ''}`);
    }
    log.info(`${DRY} would remove source "${unit.sourcePath}"`);
    log.info(`${DRY} outcome: would place "${unit.displayName}" → "${author} / ${title}" (${actions.length} files)`);
    return { author, title, files: actions.length, dryRun: true };
  }

  const destDirRoot = DEST_DIR();
  if (!(await fs.pathExists(destDirRoot))) {
    throw new Error(`Destination root directory does not exist: ${destDirRoot}`);
  }
  // Verify write permission before touching anything
  const testFile = path.join(destDirRoot, '.write-test-' + Date.now());
  try {
    await fs.writeFile(testFile, 'test');
    await fs.remove(testFile);
  } catch (writeTestError) {
    throw new Error(`Cannot write to destination directory ${destDirRoot}: ${writeTestError.message}`);
  }

  const placed = [];
  let partial = null;
  try {
    await fs.ensureDir(bookDir, { mode: parseInt(DIR_MODE(), 8) });
    for (const action of actions) {
      if (action.op === 'copy') {
        partial = path.join(bookDir, `${PARTIAL_PREFIX}${unit.job.id}-${path.basename(action.dest)}`);
        // A partial with our own job-scoped name can only be a leftover of this unit
        await fs.remove(partial);
        await fsPromises.copyFile(action.src, partial, fsConstants.COPYFILE_EXCL);
        const [sourceStats, partialStats] = await Promise.all([fs.stat(action.src), fs.stat(partial)]);
        if (sourceStats.size !== partialStats.size) {
          throw new Error(`File copy verification failed for "${path.basename(action.src)}": size mismatch (source: ${sourceStats.size}, target: ${partialStats.size})`);
        }
        if (await fs.pathExists(action.dest)) {
          throw new Error(`Destination appeared during copy, refusing to overwrite: ${action.dest}`);
        }
        await fs.rename(partial, action.dest);
        partial = null;
        placed.push(action.dest);
      }
      log.info(`📄 ${describeAction(action)}`);
    }
  } catch (error) {
    if (partial) await fs.remove(partial).catch(() => {});
    log.error(`❌ Migration failed for "${unit.displayName}": ${error.message}`);
    throw error;
  }

  await applyPerms(bookDir, placed);

  // Only remove sources after every action succeeded
  await fs.remove(unit.sourcePath);
  if (unit.type === JobType.DIRECTORY) {
    await cleanupEmptyParentDirectories(unit.sourcePath, log);
  }
  log.info(`🎉 Migrated: "${unit.displayName}" → "${author} / ${title}" (${placed.length} copied, ${actions.length - placed.length} identical)`);
  return { author, title, files: actions.length };
}

function reviewStamp(date) {
  return date.toISOString().replace(/\D/g, '').slice(0, 14);
}

/** REVIEW_DIR/<timestamp>-<displayName>, with -2, -3, … appended when taken */
async function uniqueReviewFolder(root, name) {
  let candidate = path.join(root, name);
  for (let n = 2; await fs.pathExists(candidate); n++) candidate = path.join(root, `${name}-${n}`);
  return candidate;
}

/** Move the unit's source under REVIEW_DIR and record why (D8); never deletes a file */
async function quarantine(plan, { dryRun, log }) {
  const { unit, reason, explanation, paths } = plan;
  const now = new Date();
  const root = REVIEW_DIR();
  const folder = await uniqueReviewFolder(root, `${reviewStamp(now)}-${unit.displayName}`);
  const relative = isPathWithin(unit.sourcePath, SOURCE_DIR()) && !isWithinReviewDir(unit.sourcePath)
    ? path.relative(path.resolve(SOURCE_DIR()), unit.sourcePath)
    : path.basename(unit.sourcePath);
  const target = path.join(folder, relative || path.basename(unit.sourcePath));

  for (const c of plan.conflicts) {
    log.info(`⚠️  conflicting: "${path.basename(c.src)}" → ${c.dest} (${c.why})`);
  }

  if (dryRun) {
    log.info(`${DRY} would quarantine "${unit.displayName}" (${reason}: ${explanation}) to ${folder}`);
    log.info(`${DRY} outcome: would quarantine "${unit.displayName}"`);
    return { outcome: 'quarantined', reason, reviewPath: folder, files: unit.files.length, dryRun: true };
  }

  await fs.ensureDir(path.dirname(target));
  await fs.move(unit.sourcePath, target);
  await fs.writeJson(path.join(folder, REVIEW_FILE), {
    reason, explanation, paths, timestamp: now.toISOString()
  }, { spaces: 2 });
  if (unit.type === JobType.DIRECTORY) {
    await cleanupEmptyParentDirectories(unit.sourcePath, log);
  }
  log.warn(`🚧 Quarantined "${unit.displayName}" (${reason}): ${explanation} → ${folder}`);
  log.info(`📦 Outcome: quarantined "${unit.displayName}" for review in ${folder}`);
  return { outcome: 'quarantined', reason, reviewPath: folder, files: unit.files.length };
}

/**
 * Remove stale `.dewey-partial-*` staging files left by an interrupted run (D7). Walks the
 * library up to depth 3 (DEST_DIR/Author/Title/file); real files are never touched.
 * @returns {Promise<string[]>} Removed (or, with dryRun, removable) paths
 */
export async function sweepStalePartials(log, { root = DEST_DIR(), dryRun = DRY_RUN() } = {}) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (entry.name.startsWith(PARTIAL_PREFIX)) {
        found.push(full);
      }
    }
  }
  await walk(root, 1);
  for (const file of found) {
    if (dryRun) {
      log.info(`${DRY} would remove stale partial file ${file}`);
    } else {
      await fs.remove(file);
      log.info(`🧹 Removed stale partial file ${file}`);
    }
  }
  return found;
}

// Recursively discover all migration units (directories with supported book files or loose book files)
// This prevents race conditions by doing all discovery upfront before any migration
export async function discoverMigrationUnits(rootDir) {
  const units = [];

  async function traverse(currentDir, isRoot = false) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      const directories = [];
      const bookFiles = [];

      // Separate directories and supported book files; never descend into REVIEW_DIR
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!isWithinReviewDir(fullPath)) directories.push(fullPath);
        } else if (isSupportedBook(fullPath)) {
          bookFiles.push(fullPath);
        }
      }

      // For the root directory (incoming), process contents but don't treat root as a unit
      if (isRoot) {
        // Add loose book files in root as individual units
        for (const bookFile of bookFiles) {
          units.push({ type: 'file', path: bookFile });
        }
        // Continue to traverse subdirectories
        for (const subDir of directories) {
          await traverse(subDir, false);
        }
        return;
      }

      // For non-root directories: if this directory contains book files, treat it as a migration unit
      if (bookFiles.length > 0) {
        units.push({ type: 'directory', path: currentDir });
        // Don't traverse subdirectories of directories that contain book files
        // (they should be processed as a single unit)
        return;
      }

      // If no book files here, recursively check subdirectories
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

  return await migrateUnit(job, jobLog);
}

async function migrateDir(dir, log) {
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
    // but NEVER delete the root source directory itself; dry runs change nothing
    if (!DRY_RUN()) await cleanupEmptyDirectories(dir, log, dir);
    return;
  }

  // Use the new job-based approach
  const { Job } = await import('./job.js');
  const job = await Job.fromPath(dir);
  const jobLog = job.createLogger(log);

  return await migrateUnit(job, jobLog);
}

/** Ownership and modes for the book folder and the files this unit placed */
async function applyPerms(dir, files) {
  for (const [p, mode] of [[dir, DIR_MODE()], ...files.map(f => [f, FILE_MODE()])]) {
    try {
      await fs.chmod(p, parseInt(mode, 8));
    } catch {
      // Permission changes might fail in restricted environments; non-fatal
    }
    try {
      await fs.chown(p, PUID(), PGID());
    } catch {
      // Ownership changes might fail in containers; non-fatal
    }
  }
}
