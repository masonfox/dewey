/**
 * End-to-End Integration Tests
 *
 * These tests validate the complete migration workflow including Claude API interaction.
 * They run against the real Claude API when ANTHROPIC_API_KEY is set.
 *
 * To run these tests:
 * - Set ANTHROPIC_API_KEY in your environment
 * - Run: bun test __tests__/integration.test.js
 *
 * Tests are skipped if API key is not available.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { Job, JobType, JobState } from '../src/job.js';

// Check if we have an API key for integration tests
const hasApiKey = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && key.trim() !== '' && key.startsWith('sk-ant-');
};

// Simple mock logger that tracks calls without using mock()
const createMockLog = () => ({
  debug: (...args) => { 
    mockLog._calls.debug.push(args); 
  },
  info: (...args) => { 
    if (process.env.CI) console.log('[CI MOCK INFO]', ...args);
    mockLog._calls.info.push(args); 
  },
  warn: (...args) => { 
    if (process.env.CI) console.log('[CI MOCK WARN]', ...args);
    mockLog._calls.warn.push(args); 
  },
  error: (...args) => { 
    if (process.env.CI) console.log('[CI MOCK ERROR]', ...args);
    mockLog._calls.error.push(args); 
  },
  _calls: { debug: [], info: [], warn: [], error: [] },
  _reset() {
    this._calls.debug = [];
    this._calls.info = [];
    this._calls.warn = [];
    this._calls.error = [];
  }
});

const mockLog = createMockLog();

// Test directory setup
let testDir;
let sourceDir;
let destDir;
let migrateJob;

beforeAll(async () => {
  // Set up environment before importing modules
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-integration-'));
  sourceDir = path.join(testDir, 'incoming');
  destDir = path.join(testDir, 'library');

  // IMPORTANT: Clear any existing env vars from .env file first
  // This ensures test-specific paths take precedence
  delete process.env.SOURCE_DIR;
  delete process.env.DEST_DIR;

  // Set environment variables before importing
  process.env.SOURCE_DIR = sourceDir;
  process.env.DEST_DIR = destDir;
  process.env.PUID = '0';
  process.env.PGID = '0';
  process.env.FILE_MODE = '664';
  process.env.DIR_MODE = '775';

  // Import migration module after env vars are set
  const migrateModule = await import('../src/migrate.js');
  migrateJob = migrateModule.migrateJob;
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
  mockLog._reset();
});

afterAll(async () => {
  // Clean up test directory
  if (testDir && await fs.pathExists(testDir)) {
    await fs.remove(testDir);
  }
});

describe('End-to-End Integration Tests', () => {
  // Helper to create a fake audio file
  async function createAudioFile(filename, content = 'fake audio content') {
    const filePath = path.join(sourceDir, filename);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  // Helper to verify migration
  async function verifyMigration(expectedAuthor, expectedTitle, expectedFilename) {
    const authorDir = path.join(destDir, expectedAuthor);
    const bookDir = path.join(authorDir, expectedTitle);
    const migratedFile = path.join(bookDir, expectedFilename);

    expect(await fs.pathExists(authorDir)).toBe(true);
    expect(await fs.pathExists(bookDir)).toBe(true);
    expect(await fs.pathExists(migratedFile)).toBe(true);

    return migratedFile;
  }

  describe('Claude API Integration', () => {
    // Run these tests only if API key is available
    const testIf = hasApiKey() ? test : test.skip;

    testIf('should migrate single audiobook file using Claude API', async () => {
      // Create a test file with a well-known book
      const filename = 'Stephen King - The Shining.m4b';
      const sourcePath = await createAudioFile(filename);

      // Create a job for this file
      const job = new Job(sourcePath, JobType.FILE);

      // Migrate the file (migrateJob doesn't manage state, so we do it manually)
      try {
        const result = await migrateJob(job, mockLog);
        job.setState(JobState.COMPLETED);
      } catch (error) {
        job.setState(JobState.FAILED, error);
        throw error;
      }

      // Verify the job completed successfully
      expect(job.state).toBe(JobState.COMPLETED);
      expect(job.error).toBeNull();

      // Verify the file was migrated to the correct location
      // Claude should extract "Stephen King" as author and "The Shining" as title
      const migratedFile = await verifyMigration('Stephen King', 'The Shining', filename);

      // Verify file contents are intact
      const content = await fs.readFile(migratedFile, 'utf-8');
      expect(content).toBe('fake audio content');

      // Verify source file was removed
      expect(await fs.pathExists(sourcePath)).toBe(false);
    }, 30000); // 30 second timeout for API call

    testIf('should migrate multiple files in a directory using Claude API', async () => {
      // Create a directory with multiple audio files
      const bookDir = path.join(sourceDir, 'Brandon Sanderson - Mistborn');
      await fs.ensureDir(bookDir);

      await fs.writeFile(path.join(bookDir, 'chapter1.mp3'), 'chapter 1');
      await fs.writeFile(path.join(bookDir, 'chapter2.mp3'), 'chapter 2');
      await fs.writeFile(path.join(bookDir, 'chapter3.mp3'), 'chapter 3');

      // Create a job for the directory
      const job = new Job(bookDir, JobType.DIRECTORY);

      // Migrate the directory
      try {
        await migrateJob(job, mockLog);
        job.setState(JobState.COMPLETED);
      } catch (error) {
        job.setState(JobState.FAILED, error);
        throw error;
      }

      // Verify the job completed successfully
      expect(job.state).toBe(JobState.COMPLETED);
      expect(job.error).toBeNull();

      // Verify all files were migrated
      const authorDir = path.join(destDir, 'Brandon Sanderson');
      const titleDir = path.join(authorDir, 'Mistborn');

      expect(await fs.pathExists(path.join(titleDir, 'chapter1.mp3'))).toBe(true);
      expect(await fs.pathExists(path.join(titleDir, 'chapter2.mp3'))).toBe(true);
      expect(await fs.pathExists(path.join(titleDir, 'chapter3.mp3'))).toBe(true);

      // Verify source directory was removed
      expect(await fs.pathExists(bookDir)).toBe(false);
    }, 30000);

    testIf('should handle various filename formats with Claude', async () => {
      const testCases = [
        {
          input: 'J.K. Rowling - Harry Potter and the Philosophers Stone.mp3',
          // Note: sanitizeSegment removes periods, so "J.K." becomes "J K"
          expectedAuthor: 'J K Rowling',
          expectedTitle: 'Harry Potter and the Philosophers Stone'
        },
        {
          input: 'Agatha Christie - Murder on the Orient Express.m4b',
          expectedAuthor: 'Agatha Christie',
          expectedTitle: 'Murder on the Orient Express'
        },
        {
          input: 'Isaac Asimov - Foundation.mp3',
          expectedAuthor: 'Isaac Asimov',
          expectedTitle: 'Foundation'
        }
      ];

      for (const testCase of testCases) {
        // Clean directories between test cases
        await fs.emptyDir(sourceDir);
        await fs.emptyDir(destDir);

        const sourcePath = await createAudioFile(testCase.input);
        const job = new Job(sourcePath, JobType.FILE);

        try {
          await migrateJob(job, mockLog);
          job.setState(JobState.COMPLETED);
        } catch (error) {
          job.setState(JobState.FAILED, error);
          throw error;
        }

        expect(job.state).toBe(JobState.COMPLETED);

        await verifyMigration(
          testCase.expectedAuthor,
          testCase.expectedTitle,
          testCase.input
        );

        // Small delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }, 90000); // Longer timeout for multiple API calls

    testIf('should preserve file integrity during migration', async () => {
      const filename = 'Neil Gaiman - American Gods.m4b';
      const largeContent = 'x'.repeat(10000); // 10KB of data
      const sourcePath = await createAudioFile(filename, largeContent);

      const job = new Job(sourcePath, JobType.FILE);

      try {
        await migrateJob(job, mockLog);
        job.setState(JobState.COMPLETED);
      } catch (error) {
        job.setState(JobState.FAILED, error);
        throw error;
      }

      expect(job.state).toBe(JobState.COMPLETED);

      const migratedFile = await verifyMigration('Neil Gaiman', 'American Gods', filename);
      const migratedContent = await fs.readFile(migratedFile, 'utf-8');

      expect(migratedContent).toBe(largeContent);
      expect(migratedContent.length).toBe(10000);
    }, 30000);
  });

  describe('Fallback to Heuristics', () => {
    // These tests run regardless of API key availability

    test('should fall back to heuristics when Claude API is unavailable', async () => {
      // Temporarily clear API key
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      try {
        const filename = 'Author Name - Book Title.mp3';
        const sourcePath = await createAudioFile(filename);

        const job = new Job(sourcePath, JobType.FILE);

        try {
          await migrateJob(job, mockLog);
          job.setState(JobState.COMPLETED);
        } catch (error) {
          job.setState(JobState.FAILED, error);
          throw error;
        }

        expect(job.state).toBe(JobState.COMPLETED);

        // Heuristics should extract from filename
        await verifyMigration('Author Name', 'Book Title', filename);

        // Should have logged a warning about missing API key
        const warnCalls = mockLog._calls.warn;
        const hasApiWarning = warnCalls.some(call =>
          call[0]?.includes('Claude API key not set')
        );
        expect(hasApiWarning).toBe(true);
      } finally {
        // Restore API key
        if (originalKey) {
          process.env.ANTHROPIC_API_KEY = originalKey;
        }
      }
    }, 10000);

    test('should handle files without clear author-title format', async () => {
      const filename = 'some_random_audiobook.mp3';
      const sourcePath = await createAudioFile(filename);

      const job = new Job(sourcePath, JobType.FILE);

      try {
        await migrateJob(job, mockLog);
        job.setState(JobState.COMPLETED);
      } catch (error) {
        job.setState(JobState.FAILED, error);
        throw error;
      }

      expect(job.state).toBe(JobState.COMPLETED);

      // Claude might return "Some Random Audiobook" (title case normalization)
      // sanitizeSegment replaces underscores with spaces, so we check for those outcomes
      const possibleDirs = [
        { author: 'Unknown', title: 'some random audiobook' },
        { author: 'Unknown', title: 'Some Random Audiobook' },
        { author: 'Unknown', title: 'Some random audiobook' }
      ];

      let found = false;
      for (const {author, title} of possibleDirs) {
        const authorDir = path.join(destDir, author);
        const bookDir = path.join(authorDir, title);
        if (await fs.pathExists(bookDir)) {
          found = true;
          break;
        }
      }

      expect(found).toBe(true);
    }, 10000);
  });

  describe('Error Handling', () => {
    test('should handle migration failures gracefully', async () => {
      const filename = 'Test Author - Test Book.mp3';
      const sourcePath = await createAudioFile(filename);

      // Make destination read-only to force a failure
      await fs.chmod(destDir, 0o444);

      const job = new Job(sourcePath, JobType.FILE);

      try {
        await migrateJob(job, mockLog);
        job.setState(JobState.COMPLETED);
      } catch (error) {
        job.setState(JobState.FAILED, error);
      }

      // Restore permissions
      await fs.chmod(destDir, 0o755);

      // Job should be in failed state
      expect(job.state).toBe(JobState.FAILED);
      expect(job.error).not.toBeNull();

      // Source file should still exist (not deleted on failure)
      expect(await fs.pathExists(sourcePath)).toBe(true);
    }, 10000);
  });
});

// Print a helpful message if tests are skipped
if (!hasApiKey()) {
  console.log('\n⚠️  Integration tests requiring Claude API will be skipped.');
  console.log('   Set ANTHROPIC_API_KEY environment variable to run full integration tests.\n');
}
