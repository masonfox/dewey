import path from 'node:path';
import fs from 'fs-extra';

/**
 * Job states representing the lifecycle of a migration job
 */
export const JobState = {
  PENDING: 'pending',           // Job created, waiting for processing
  WAITING_STABILITY: 'waiting', // Directory job waiting for stability
  PROCESSING: 'processing',     // Currently being migrated
  COMPLETED: 'completed',       // Successfully migrated
  FAILED: 'failed',            // Failed to migrate
  CANCELLED: 'cancelled'        // Cancelled (e.g., source no longer exists)
};

/**
 * Job types for different migration scenarios
 */
export const JobType = {
  FILE: 'file',                 // Single audio file migration
  DIRECTORY: 'directory',       // Directory containing audio files
  ROOT_SCAN: 'root_scan'        // Scan of root incoming directory
};

/**
 * Represents a single migration job with persistent state and ID
 */
export class Job {
  constructor(sourcePath, type = JobType.FILE) {
    this.id = this.generateJobId(sourcePath);
    this.sourcePath = path.resolve(sourcePath);
    this.type = type;
    this.state = JobState.PENDING;
    this.createdAt = new Date();
    this.lastModified = new Date();
    this.retryCount = 0;
    this.maxRetries = 3;
    this.stabilityCheckCount = 0;
    this.maxStabilityChecks = 20; // Prevent infinite stability checks
    
    // Additional metadata
    this.displayName = path.basename(sourcePath);
    this.error = null;
    this.result = null;
  }

  /**
   * Generate a short, readable job ID based on the source name
   */
  generateJobId(sourceName) {
    const base = path.basename(sourceName);
    // Take first 6 characters of base64 encoded hash for short, readable ID
    const hash = Buffer.from(base).toString('base64').replace(/[+/=]/g, '').slice(0, 6);
    return hash.toUpperCase();
  }

  /**
   * Update job state and timestamp
   */
  setState(newState, error = null) {
    this.state = newState;
    this.lastModified = new Date();
    if (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Check if job can be retried
   */
  canRetry() {
    return this.retryCount < this.maxRetries && 
           [JobState.FAILED, JobState.CANCELLED].includes(this.state);
  }

  /**
   * Increment retry count and reset to pending
   */
  retry() {
    if (!this.canRetry()) {
      throw new Error(`Job ${this.id} cannot be retried (retries: ${this.retryCount}/${this.maxRetries})`);
    }
    this.retryCount++;
    this.setState(JobState.PENDING);
    this.error = null;
  }

  /**
   * Check if the source path still exists
   */
  async sourceExists() {
    try {
      await fs.access(this.sourcePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get job age in milliseconds
   */
  getAge() {
    return Date.now() - this.createdAt.getTime();
  }

  /**
   * Get time since last modification in milliseconds
   */
  getTimeSinceModified() {
    return Date.now() - this.lastModified.getTime();
  }

  /**
   * Check if this directory job is stable (for directory type jobs)
   */
  async checkStability(stabilityTimeout = 5000) {
    if (this.type !== JobType.DIRECTORY) {
      return true; // Non-directory jobs are always "stable"
    }

    try {
      const stat = await fs.stat(this.sourcePath);
      if (!stat.isDirectory()) return true;
      
      // Check if directory has been stable for the configured timeout
      const now = Date.now();
      const lastModified = stat.mtime.getTime();
      
      if (now - lastModified < stabilityTimeout) {
        return false;
      }
      
      // Additional check: ensure no files are currently being written
      const entries = await fs.readdir(this.sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(this.sourcePath, entry.name);
          const fileStat = await fs.stat(filePath);
          const fileAge = now - fileStat.mtime.getTime();
          if (fileAge < stabilityTimeout) {
            return false;
          }
        }
      }
      
      return true;
    } catch (error) {
      // If we can't check stability (e.g., directory deleted), consider it "stable"
      return true;
    }
  }

  /**
   * Increment stability check count
   */
  incrementStabilityCheck() {
    this.stabilityCheckCount++;
    return this.stabilityCheckCount <= this.maxStabilityChecks;
  }

  /**
   * Create a scoped logger that includes job ID in all messages
   */
  createLogger(baseLogger) {
    return {
      debug: (msg, ...args) => baseLogger.debug(`[${this.id}] ${msg}`, ...args),
      info: (msg, ...args) => baseLogger.info(`[${this.id}] ${msg}`, ...args),
      warn: (msg, ...args) => baseLogger.warn(`[${this.id}] ${msg}`, ...args),
      error: (msg, ...args) => baseLogger.error(`[${this.id}] ${msg}`, ...args)
    };
  }

  /**
   * Get a summary of this job for logging
   */
  toSummary() {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      displayName: this.displayName,
      retryCount: this.retryCount,
      stabilityCheckCount: this.stabilityCheckCount,
      age: this.getAge(),
      error: this.error
    };
  }

  /**
   * Create a Job from a file system path, automatically determining the type
   */
  static async fromPath(sourcePath) {
    const resolvedPath = path.resolve(sourcePath);
    
    try {
      const stat = await fs.stat(resolvedPath);
      const type = stat.isDirectory() ? JobType.DIRECTORY : JobType.FILE;
      return new Job(resolvedPath, type);
    } catch (error) {
      // If we can't stat the path, assume it's a file for now
      // The job will fail later if the source doesn't exist
      return new Job(resolvedPath, JobType.FILE);
    }
  }
}