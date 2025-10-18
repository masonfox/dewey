import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { Job, JobType } from '../src/job.js';

// Mock logger
const mockLog = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {})
};

// Test directory setup
let testDir;
let sourceDir;
let destDir;
let migratePath, migrateJob, discoverMigrationUnits, cleanupEmptyDirectories;

beforeAll(async () => {
  // Set up environment before importing modules
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-test-'));
  sourceDir = path.join(testDir, 'incoming');
  destDir = path.join(testDir, 'library');
  
  // Set environment variables before importing
  process.env.SOURCE_DIR = sourceDir;
  process.env.DEST_DIR = destDir;
  process.env.PUID = '0';
  process.env.PGID = '0';
  process.env.FILE_MODE = '664';
  process.env.DIR_MODE = '775';
  
  // Now import after env vars are set
  const migrateModule = await import('../src/migrate.js');
  migratePath = migrateModule.migratePath;
  migrateJob = migrateModule.migrateJob;
  discoverMigrationUnits = migrateModule.discoverMigrationUnits;
  cleanupEmptyDirectories = migrateModule.cleanupEmptyDirectories;
});

beforeEach(async () => {
  // Clean and recreate test directories for each test
  if (await fs.pathExists(sourceDir)) {
    await fs.remove(sourceDir);
  }
  if (await fs.pathExists(destDir)) {
    await fs.remove(destDir);
  }

  await fs.ensureDir(sourceDir);
  await fs.ensureDir(destDir);

  // Clear mock logger calls
  mockLog.debug.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
});

afterEach(async () => {
  // Clean up is handled in beforeEach
});

afterAll(async () => {
  // Clean up test directory
  if (testDir && await fs.pathExists(testDir)) {
    await fs.remove(testDir);
  }
});

describe('discoverMigrationUnits', () => {
  test('should find root audio files (case #1)', async () => {
    // Create loose audio files in root
    await fs.writeFile(path.join(sourceDir, 'book1.m4b'), 'fake audio');
    await fs.writeFile(path.join(sourceDir, 'book2.mp3'), 'fake audio');
    await fs.writeFile(path.join(sourceDir, 'readme.txt'), 'not audio');

    const units = await discoverMigrationUnits(sourceDir);

    expect(units).toHaveLength(2);
    // Use arrayContaining since order may vary between test runners
    expect(units).toEqual(expect.arrayContaining([
      { type: 'file', path: path.join(sourceDir, 'book1.m4b') },
      { type: 'file', path: path.join(sourceDir, 'book2.mp3') }
    ]));
  });

  test('should find directories with audio files (case #2)', async () => {
    // Create directories with audio files
    const book1Dir = path.join(sourceDir, 'Book 1');
    const book2Dir = path.join(sourceDir, 'Book 2');
    
    await fs.ensureDir(book1Dir);
    await fs.ensureDir(book2Dir);
    
    await fs.writeFile(path.join(book1Dir, 'chapter1.m4b'), 'fake audio');
    await fs.writeFile(path.join(book1Dir, 'cover.jpg'), 'image');
    await fs.writeFile(path.join(book2Dir, 'book2.mp3'), 'fake audio');
    
    const units = await discoverMigrationUnits(sourceDir);
    
    expect(units).toHaveLength(2);
    expect(units).toEqual(expect.arrayContaining([
      { type: 'directory', path: book1Dir },
      { type: 'directory', path: book2Dir }
    ]));
  });

  test('should find nested directories with audio files (case #3)', async () => {
    // Create nested structure: incoming/series/book1/files
    const seriesDir = path.join(sourceDir, 'Fantasy Series');
    const bookDir = path.join(seriesDir, 'Book 1');
    
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'chapter1.mp3'), 'fake audio');
    await fs.writeFile(path.join(bookDir, 'chapter2.mp3'), 'fake audio');
    
    const units = await discoverMigrationUnits(sourceDir);
    
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({
      type: 'directory',
      path: bookDir
    });
  });

  test('should handle mixed cases', async () => {
    // Root files
    await fs.writeFile(path.join(sourceDir, 'loose-book.m4b'), 'fake audio');
    
    // Direct directory with audio
    const directDir = path.join(sourceDir, 'Direct Book');
    await fs.ensureDir(directDir);
    await fs.writeFile(path.join(directDir, 'book.m4b'), 'fake audio');
    
    // Nested directory with audio
    const parentDir = path.join(sourceDir, 'Series Parent');
    const nestedDir = path.join(parentDir, 'Nested Book');
    await fs.ensureDir(nestedDir);
    await fs.writeFile(path.join(nestedDir, 'nested.mp3'), 'fake audio');
    
    const units = await discoverMigrationUnits(sourceDir);
    
    expect(units).toHaveLength(3);
    expect(units).toEqual(expect.arrayContaining([
      { type: 'file', path: path.join(sourceDir, 'loose-book.m4b') },
      { type: 'directory', path: directDir },
      { type: 'directory', path: nestedDir }
    ]));
  });

  test('should not return root directory as migration unit', async () => {
    // Create audio files in root
    await fs.writeFile(path.join(sourceDir, 'book.m4b'), 'fake audio');
    
    const units = await discoverMigrationUnits(sourceDir);
    
    // Should return the file, not the root directory
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe('file');
    expect(units[0].path).toBe(path.join(sourceDir, 'book.m4b'));
  });
});

describe('cleanupEmptyDirectories', () => {
  test('should remove empty directories', async () => {
    const emptyDir = path.join(sourceDir, 'empty');
    await fs.ensureDir(emptyDir);
    
    expect(await fs.pathExists(emptyDir)).toBe(true);
    
    await cleanupEmptyDirectories(sourceDir, mockLog);
    
    expect(await fs.pathExists(emptyDir)).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith('🧹 Cleaned up empty directory: "empty"');
  });

  test('should remove nested empty directories', async () => {
    const parentDir = path.join(sourceDir, 'parent');
    const childDir = path.join(parentDir, 'child');
    const grandchildDir = path.join(childDir, 'grandchild');
    
    await fs.ensureDir(grandchildDir);
    
    await cleanupEmptyDirectories(sourceDir, mockLog);
    
    expect(await fs.pathExists(grandchildDir)).toBe(false);
    expect(await fs.pathExists(childDir)).toBe(false);
    expect(await fs.pathExists(parentDir)).toBe(false);
  });

  test('should not remove directories with files', async () => {
    const dirWithFile = path.join(sourceDir, 'has-file');
    await fs.ensureDir(dirWithFile);
    await fs.writeFile(path.join(dirWithFile, 'important.txt'), 'keep this');
    
    await cleanupEmptyDirectories(sourceDir, mockLog);
    
    expect(await fs.pathExists(dirWithFile)).toBe(true);
    expect(await fs.pathExists(path.join(dirWithFile, 'important.txt'))).toBe(true);
  });
});

describe('migrateJob function tests', () => {
  test('should migrate file job', async () => {
    const audioFile = path.join(sourceDir, 'Test Book.m4b');
    await fs.writeFile(audioFile, 'fake audio content');
    
    const job = await Job.fromPath(audioFile);
    const jobLogger = job.createLogger(mockLog);
    const result = await migrateJob(job, jobLogger);
    
    // Check file was moved to library
    expect(await fs.pathExists(audioFile)).toBe(false);
    
    // Should be in Unknown author since we don't have Claude API
    const migratedFile = path.join(destDir, 'Unknown', 'Test Book', 'Test Book.m4b');
    expect(await fs.pathExists(migratedFile)).toBe(true);
    
    // Verify content
    const content = await fs.readFile(migratedFile, 'utf8');
    expect(content).toBe('fake audio content');
    
    // Check return value
    expect(result).toEqual({
      author: 'Unknown',
      title: 'Test Book',
      files: 1
    });
  });

  test('should migrate directory job', async () => {
    const bookDir = path.join(sourceDir, 'Stephen King - The Shining');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'shining.m4b'), 'horror audio');
    await fs.writeFile(path.join(bookDir, 'cover.jpg'), 'image data');
    
    const job = await Job.fromPath(bookDir);
    const jobLogger = job.createLogger(mockLog);
    const result = await migrateJob(job, jobLogger);
    
    // Original directory should be gone
    expect(await fs.pathExists(bookDir)).toBe(false);
    
    // Should be migrated 
    const authorDirs = await fs.readdir(destDir);
    expect(authorDirs.length).toBeGreaterThan(0);
    
    // Find the migrated audio file
    let foundAudio = false;
    for (const authorDir of authorDirs) {
      const authorPath = path.join(destDir, authorDir);
      if ((await fs.stat(authorPath)).isDirectory()) {
        const bookDirs = await fs.readdir(authorPath);
        for (const bookDirName of bookDirs) {
          const bookPath = path.join(authorPath, bookDirName);
          if ((await fs.stat(bookPath)).isDirectory()) {
            const files = await fs.readdir(bookPath);
            if (files.includes('shining.m4b')) {
              foundAudio = true;
              const content = await fs.readFile(path.join(bookPath, 'shining.m4b'), 'utf8');
              expect(content).toBe('horror audio');
              // Image files shouldn't be migrated (only audio)
              expect(files.includes('cover.jpg')).toBe(false);
            }
          }
        }
      }
    }
    expect(foundAudio).toBe(true);
    
    // Check return value
    expect(result).toEqual({
      author: expect.any(String),
      title: expect.any(String),
      files: 1
    });
  });

  test('should throw error for non-audio file job', async () => {
    const textFile = path.join(sourceDir, 'readme.txt');
    await fs.writeFile(textFile, 'This is not audio');
    
    const job = await Job.fromPath(textFile);
    const jobLogger = job.createLogger(mockLog);
    
    await expect(migrateJob(job, jobLogger)).rejects.toThrow('Skipping non-audio file');
  });

  test('should throw SkipError for directory with no audio files', async () => {
    const emptyDir = path.join(sourceDir, 'Empty Directory');
    await fs.ensureDir(emptyDir);
    await fs.writeFile(path.join(emptyDir, 'readme.txt'), 'No audio here');
    
    const job = await Job.fromPath(emptyDir);
    const jobLogger = job.createLogger(mockLog);
    
    // Verify it throws a SkipError with the correct properties
    try {
      await migrateJob(job, jobLogger);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error.name).toBe('SkipError');
      expect(error.reason).toBe('no-audio-files');
      expect(error.message).toContain('Skipping directory with no audio files');
    }
  });

  test('should use job logger with consistent ID', async () => {
    const audioFile = path.join(sourceDir, 'Test Book.m4b');
    await fs.writeFile(audioFile, 'fake audio content');
    
    const job = await Job.fromPath(audioFile);
    const jobLogger = job.createLogger(mockLog);
    await migrateJob(job, jobLogger);
    
    // Verify all log messages include the job ID
    const logCalls = mockLog.info.mock.calls;
    expect(logCalls.length).toBeGreaterThan(0);
    
    logCalls.forEach(call => {
      expect(call[0]).toMatch(new RegExp(`\\[${job.id}\\]`));
    });
  });
});

describe('migratePath integration tests (legacy)', () => {
  test('should migrate individual audio file', async () => {
    const audioFile = path.join(sourceDir, 'Test Book.m4b');
    await fs.writeFile(audioFile, 'fake audio content');
    
    await migratePath(audioFile, mockLog);
    
    // Check file was moved to library
    expect(await fs.pathExists(audioFile)).toBe(false);
    
    // Should be in Unknown author since we don't have Claude API
    const migratedFile = path.join(destDir, 'Unknown', 'Test Book', 'Test Book.m4b');
    expect(await fs.pathExists(migratedFile)).toBe(true);
    
    // Verify content
    const content = await fs.readFile(migratedFile, 'utf8');
    expect(content).toBe('fake audio content');
  });

  test('should migrate directory with audio files', async () => {
    const bookDir = path.join(sourceDir, 'Stephen King - The Shining');
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'shining.m4b'), 'horror audio');
    await fs.writeFile(path.join(bookDir, 'cover.jpg'), 'image data');
    
    await migratePath(bookDir, mockLog);
    
    // Original directory should be gone
    expect(await fs.pathExists(bookDir)).toBe(false);
    
    // Should be migrated (exact path depends on Claude API, but should be in Unknown without API)
    const authorDirs = await fs.readdir(destDir);
    expect(authorDirs.length).toBeGreaterThan(0);
    
    // Find the migrated audio file
    let foundAudio = false;
    for (const authorDir of authorDirs) {
      const authorPath = path.join(destDir, authorDir);
      if ((await fs.stat(authorPath)).isDirectory()) {
        const bookDirs = await fs.readdir(authorPath);
        for (const bookDirName of bookDirs) {
          const bookPath = path.join(authorPath, bookDirName);
          if ((await fs.stat(bookPath)).isDirectory()) {
            const files = await fs.readdir(bookPath);
            if (files.includes('shining.m4b')) {
              foundAudio = true;
              const content = await fs.readFile(path.join(bookPath, 'shining.m4b'), 'utf8');
              expect(content).toBe('horror audio');
              // Image files shouldn't be migrated (only audio)
              expect(files.includes('cover.jpg')).toBe(false);
            }
          }
        }
      }
    }
    expect(foundAudio).toBe(true);
  });

  test('should handle nested directory structure', async () => {
    // Create the Inkheart-like structure
    const parentDir = path.join(sourceDir, 'Cornelia Funke - Inkheart Series');
    const bookDir = path.join(parentDir, 'Book 1 - Inkheart');
    
    await fs.ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, 'chapter01.mp3'), 'chapter 1');
    await fs.writeFile(path.join(bookDir, 'chapter02.mp3'), 'chapter 2');
    
    await migratePath(sourceDir, mockLog);
    
    // Parent directory should be cleaned up
    expect(await fs.pathExists(parentDir)).toBe(false);
    
    // Audio files should be migrated
    const authorDirs = await fs.readdir(destDir);
    expect(authorDirs.length).toBeGreaterThan(0);
    
    let foundChapters = 0;
    for (const authorDir of authorDirs) {
      const authorPath = path.join(destDir, authorDir);
      if ((await fs.stat(authorPath)).isDirectory()) {
        const bookDirs = await fs.readdir(authorPath);
        for (const bookDirName of bookDirs) {
          const bookPath = path.join(authorPath, bookDirName);
          if ((await fs.stat(bookPath)).isDirectory()) {
            const files = await fs.readdir(bookPath);
            foundChapters += files.filter(f => f.startsWith('chapter') && f.endsWith('.mp3')).length;
          }
        }
      }
    }
    expect(foundChapters).toBe(2);
  });

  test('should cleanup empty parent directories after nested processing', async () => {
    // Test the specific issue reported: nested folders not being removed 
    // Create structure: "Parent Dir/Child Dir/audio.mp3"
    const parentDir = path.join(sourceDir, 'Funke, Cornelia - Book 1 - Inkheart (2003) (Inkheart)');
    const childDir = path.join(parentDir, 'Inkheart');
    
    await fs.ensureDir(childDir);
    await fs.writeFile(path.join(childDir, 'inkheart-chapter1.mp3'), 'audio content');
    
    // Verify initial structure exists
    expect(await fs.pathExists(parentDir)).toBe(true);
    expect(await fs.pathExists(childDir)).toBe(true);
    
    // Process the child directory directly (simulates how individual directories are processed)
    await migratePath(childDir, mockLog);
    
    // Child directory should be removed after migration
    expect(await fs.pathExists(childDir)).toBe(false);
    
    // Parent directory should now be automatically cleaned up by our new cleanup logic
    expect(await fs.pathExists(parentDir)).toBe(false);
    
    // Audio file should be migrated to destination
    const authorDirs = await fs.readdir(destDir);
    expect(authorDirs.length).toBeGreaterThan(0);
    
    let foundAudio = false;
    for (const authorDir of authorDirs) {
      const authorPath = path.join(destDir, authorDir);
      if ((await fs.stat(authorPath)).isDirectory()) {
        const bookDirs = await fs.readdir(authorPath);
        for (const bookDirName of bookDirs) {
          const bookPath = path.join(authorPath, bookDirName);
          if ((await fs.stat(bookPath)).isDirectory()) {
            const files = await fs.readdir(bookPath);
            if (files.includes('inkheart-chapter1.mp3')) {
              foundAudio = true;
              const content = await fs.readFile(path.join(bookPath, 'inkheart-chapter1.mp3'), 'utf8');
              expect(content).toBe('audio content');
            }
          }
        }
      }
    }
    expect(foundAudio).toBe(true);
  });

  test('should handle non-existent path gracefully', async () => {
    const nonExistentPath = path.join(sourceDir, 'does-not-exist.m4b');
    
    // Should not throw error
    await expect(migratePath(nonExistentPath, mockLog)).resolves.toBeUndefined();
  });

  test('should skip non-audio files', async () => {
    const textFile = path.join(sourceDir, 'readme.txt');
    await fs.writeFile(textFile, 'This is not audio');
    
    // The new architecture throws an error for non-audio files, but migratePath should handle this gracefully
    await expect(migratePath(textFile, mockLog)).rejects.toThrow('Skipping non-audio file');
    
    // File should still exist (not migrated)
    expect(await fs.pathExists(textFile)).toBe(true);
  });
});