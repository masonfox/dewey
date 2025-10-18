import { jest } from '@jest/globals';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { Job, JobState, JobType } from '../src/job.js';

// Mock logger for testing
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

describe('Job', () => {
  let testDir;
  let testFile;
  let testDirectory;

  beforeEach(async () => {
    // Create test directory structure
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-job-test-'));
    testFile = path.join(testDir, 'test-book.m4b');
    testDirectory = path.join(testDir, 'test-directory');
    
    await fs.writeFile(testFile, 'fake audio content');
    await fs.ensureDir(testDirectory);
    await fs.writeFile(path.join(testDirectory, 'audio.m4b'), 'fake audio');
    
    // Clear mock calls
    Object.values(mockLogger).forEach(fn => fn.mockClear());
  });

  afterEach(async () => {
    if (testDir && await fs.pathExists(testDir)) {
      await fs.remove(testDir);
    }
  });

  describe('constructor', () => {
    test('should create a job with basic properties', () => {
      const job = new Job(testFile);

      expect(job.id).toBeDefined();
      expect(job.id).toHaveLength(8);  // Updated to 8 characters
      expect(job.sourcePath).toBe(path.resolve(testFile));
      expect(job.type).toBe(JobType.FILE);
      expect(job.state).toBe(JobState.PENDING);
      expect(job.displayName).toBe('test-book.m4b');
      expect(job.retryCount).toBe(0);
      expect(job.error).toBeNull();
    });

    test('should handle directory type', () => {
      const job = new Job(testDirectory, JobType.DIRECTORY);
      
      expect(job.type).toBe(JobType.DIRECTORY);
      expect(job.displayName).toBe('test-directory');
    });

    test('should generate unique IDs for different paths', () => {
      const job1 = new Job(testFile);
      const job2 = new Job(path.join(testDir, 'completely-different-name.mp3'));
      
      expect(job1.id).not.toBe(job2.id);
    });

    test('should generate consistent IDs for same path', () => {
      const job1 = new Job(testFile);
      const job2 = new Job(testFile);

      expect(job1.id).toBe(job2.id);
    });

    test('should prevent collisions for files with same basename in different directories', async () => {
      // Create two directories with files that have the same basename
      const dir1 = path.join(testDir, 'author1');
      const dir2 = path.join(testDir, 'author2');
      await fs.ensureDir(dir1);
      await fs.ensureDir(dir2);

      const file1 = path.join(dir1, 'same-filename.m4b');
      const file2 = path.join(dir2, 'same-filename.m4b');

      await fs.writeFile(file1, 'content1');
      await fs.writeFile(file2, 'content2');

      const job1 = new Job(file1);
      const job2 = new Job(file2);

      // IDs should be different even though the basenames are the same
      expect(job1.id).not.toBe(job2.id);
      expect(job1.displayName).toBe(job2.displayName); // But display names are the same
    });
  });

  describe('setState', () => {
    test('should update state and timestamp', async () => {
      const job = new Job(testFile);
      const initialTime = job.lastModified;
      
      // Wait a small amount to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));
      
      job.setState(JobState.PROCESSING);
      
      expect(job.state).toBe(JobState.PROCESSING);
      expect(job.lastModified.getTime()).toBeGreaterThan(initialTime.getTime());
      expect(job.error).toBeNull();
    });

    test('should set error message', () => {
      const job = new Job(testFile);
      const error = new Error('Test error');
      
      job.setState(JobState.FAILED, error);
      
      expect(job.state).toBe(JobState.FAILED);
      expect(job.error).toBe('Test error');
    });

    test('should handle string errors', () => {
      const job = new Job(testFile);
      
      job.setState(JobState.FAILED, 'String error');
      
      expect(job.error).toBe('String error');
    });
  });

  describe('retry logic', () => {
    test('should allow retry when below max retries', () => {
      const job = new Job(testFile);
      job.setState(JobState.FAILED, 'Test error');
      
      expect(job.canRetry()).toBe(true);
      
      job.retry();
      
      expect(job.state).toBe(JobState.PENDING);
      expect(job.retryCount).toBe(1);
      expect(job.error).toBeNull();
    });

    test('should not allow retry when at max retries', () => {
      const job = new Job(testFile);
      job.retryCount = 3; // At max
      job.setState(JobState.FAILED, 'Test error');
      
      expect(job.canRetry()).toBe(false);
      expect(() => job.retry()).toThrow('cannot be retried');
    });

    test('should not allow retry for non-retryable states', () => {
      const job = new Job(testFile);
      job.setState(JobState.COMPLETED);
      
      expect(job.canRetry()).toBe(false);
    });
  });

  describe('sourceExists', () => {
    test('should return true for existing file', async () => {
      const job = new Job(testFile);
      
      expect(await job.sourceExists()).toBe(true);
    });

    test('should return false for non-existent file', async () => {
      const nonExistentFile = path.join(testDir, 'does-not-exist.m4b');
      const job = new Job(nonExistentFile);
      
      expect(await job.sourceExists()).toBe(false);
    });
  });

  describe('stability checking', () => {
    test('should return true for file jobs', async () => {
      const job = new Job(testFile, JobType.FILE);
      
      expect(await job.checkStability()).toBe(true);
    });

    test('should check directory modification time', async () => {
      const job = new Job(testDirectory, JobType.DIRECTORY);
      
      // Touch the directory to make it "fresh" (within the stability window)
      const veryRecentTime = new Date(Date.now() - 50); // 50ms ago
      await fs.utimes(testDirectory, veryRecentTime, veryRecentTime);
      
      // Fresh directory should be unstable with short timeout (100ms)
      expect(await job.checkStability(100)).toBe(false);
      
      // With zero timeout, even fresh directory should be stable
      expect(await job.checkStability(0)).toBe(true);
    });

    test('should track stability check count', async () => {
      const job = new Job(testDirectory, JobType.DIRECTORY);
      
      expect(job.stabilityCheckCount).toBe(0);
      
      expect(job.incrementStabilityCheck()).toBe(true);
      expect(job.stabilityCheckCount).toBe(1);
      
      // Simulate many checks
      for (let i = 0; i < 20; i++) {
        job.incrementStabilityCheck();
      }
      
      expect(job.incrementStabilityCheck()).toBe(false); // Should exceed max
    });
  });

  describe('logger creation', () => {
    test('should create scoped logger with job ID', () => {
      const job = new Job(testFile);
      const scopedLogger = job.createLogger(mockLogger);
      
      scopedLogger.info('Test message');
      scopedLogger.warn('Warning message');
      scopedLogger.error('Error message');
      
      expect(mockLogger.info).toHaveBeenCalledWith(`[${job.id}] Test message`);
      expect(mockLogger.warn).toHaveBeenCalledWith(`[${job.id}] Warning message`);
      expect(mockLogger.error).toHaveBeenCalledWith(`[${job.id}] Error message`);
    });

    test('should pass through additional arguments', () => {
      const job = new Job(testFile);
      const scopedLogger = job.createLogger(mockLogger);
      
      scopedLogger.info('Test message', { extra: 'data' }, 123);
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        `[${job.id}] Test message`, 
        { extra: 'data' }, 
        123
      );
    });
  });

  describe('utility methods', () => {
    test('should calculate age correctly', () => {
      const job = new Job(testFile);
      const age = job.getAge();
      
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(1000); // Should be very recent
    });

    test('should calculate time since modified', async () => {
      const job = new Job(testFile);
      
      await new Promise(resolve => setTimeout(resolve, 10));
      job.setState(JobState.PROCESSING);
      
      const timeSinceModified = job.getTimeSinceModified();
      expect(timeSinceModified).toBeGreaterThanOrEqual(0);
      expect(timeSinceModified).toBeLessThan(100);
    });

    test('should create summary object', () => {
      const job = new Job(testFile);
      job.setState(JobState.PROCESSING);
      job.retryCount = 1;
      
      const summary = job.toSummary();
      
      expect(summary).toEqual({
        id: job.id,
        type: JobType.FILE,
        state: JobState.PROCESSING,
        displayName: 'test-book.m4b',
        retryCount: 1,
        stabilityCheckCount: 0,
        age: expect.any(Number),
        error: null
      });
    });
  });

  describe('fromPath static method', () => {
    test('should create file job for existing file', async () => {
      const job = await Job.fromPath(testFile);
      
      expect(job).toBeInstanceOf(Job);
      expect(job.type).toBe(JobType.FILE);
      expect(job.sourcePath).toBe(path.resolve(testFile));
    });

    test('should create directory job for existing directory', async () => {
      const job = await Job.fromPath(testDirectory);
      
      expect(job).toBeInstanceOf(Job);
      expect(job.type).toBe(JobType.DIRECTORY);
      expect(job.sourcePath).toBe(path.resolve(testDirectory));
    });

    test('should create file job for non-existent path', async () => {
      const nonExistentPath = path.join(testDir, 'does-not-exist.m4b');
      const job = await Job.fromPath(nonExistentPath);
      
      expect(job).toBeInstanceOf(Job);
      expect(job.type).toBe(JobType.FILE);
    });
  });
});