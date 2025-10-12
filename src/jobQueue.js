import { Job, JobState, JobType } from './job.js';
import { discoverMigrationUnits } from './migrate.js';
import { isAudio } from './utils.js';
import path from 'node:path';
import fs from 'fs-extra';

/**
 * Centralized job queue for managing migration jobs with proper lifecycle tracking
 */
export class JobQueue {
  constructor(options = {}) {
    this.jobs = new Map(); // jobId -> Job
    this.processingJobs = new Set(); // Set of job IDs currently being processed
    this.stabilityTimeout = options.stabilityTimeout || 5000;
    this.batchProcessDelay = options.batchProcessDelay || 300;
    this.sourceDir = options.sourceDir || './data/incoming';
    
    // Processing state
    this.isProcessing = false;
    this.batchTimer = null;
    this.logger = null;
  }

  /**
   * Set the logger instance
   */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
   * Add a path to the queue, creating appropriate job(s)
   */
  async enqueue(sourcePath) {
    const resolvedPath = path.resolve(sourcePath);

    // Skip the root SOURCE_DIR itself
    const resolvedSourceDir = path.resolve(this.sourceDir);
    if (resolvedPath === resolvedSourceDir) {
      this.logger?.debug(`🏠 Skipping root source directory: ${path.basename(sourcePath)}`);
      return;
    }

    this.logger?.debug(`📝 Enqueueing path: ${path.basename(sourcePath)} (${resolvedPath})`);

    try {
      // Check if source still exists
      const exists = await fs.pathExists(resolvedPath);
      if (!exists) {
        this.logger?.debug(`❌ Source no longer exists: ${path.basename(sourcePath)}`);
        return;
      }

      // Check if we already have a job for this path
      const existingJob = this.findJobByPath(resolvedPath);
      if (existingJob) {
        // If job is in a final state, create a new one (allows re-processing)
        if ([JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED].includes(existingJob.state)) {
          this.jobs.delete(existingJob.id);
        } else {
          // Job already exists and is active, skip
          this.logger?.debug(`⏭️  Job already exists for: ${existingJob.displayName}`);
          return;
        }
      }

      const job = await Job.fromPath(resolvedPath);
      
      // For root directory scans, discover all migration units
      // Only trigger root scan for the actual SOURCE_DIR, not any directory named "incoming"
      const resolvedSourceDir = path.resolve(this.sourceDir);
      if (job.type === JobType.DIRECTORY && resolvedPath === resolvedSourceDir) {
        await this.enqueueRootScan(resolvedPath);
        return;
      }

      // Check if this is part of a parent directory that should be processed as a unit
      if (job.type === JobType.FILE) {
        const parentJob = await this.checkForParentDirectoryJob(resolvedPath);
        if (parentJob) {
          this.logger?.debug(`📁 File "${job.displayName}" will be processed with parent directory "${parentJob.displayName}"`);
          return;
        }
      }

      this.jobs.set(job.id, job);
      this.logger?.info(`➕ Enqueued ${job.type} job: "${job.displayName}" [${job.id}]`);
      
      this.scheduleBatchProcess();

    } catch (error) {
      this.logger?.error(`❌ Error enqueuing path "${path.basename(sourcePath)}": ${error.message}`);
    }
  }

  /**
   * Handle scanning of the root incoming directory
   */
  async enqueueRootScan(rootPath) {
    try {
      const migrationUnits = await discoverMigrationUnits(rootPath);
      
      for (const unit of migrationUnits) {
        const job = await Job.fromPath(unit.path);
        
        // Skip if we already have this job
        const existingJob = this.findJobByPath(unit.path);
        if (existingJob && ![JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED].includes(existingJob.state)) {
          continue;
        }
        
        if (existingJob) {
          this.jobs.delete(existingJob.id);
        }

        this.jobs.set(job.id, job);
        this.logger?.debug(`➕ Discovered ${job.type}: "${job.displayName}" [${job.id}]`);
      }

      this.scheduleBatchProcess();
    } catch (error) {
      this.logger?.error(`❌ Error scanning root directory: ${error.message}`);
    }
  }

  /**
   * Check if a file should be processed as part of a parent directory
   */
  async checkForParentDirectoryJob(filePath) {
    const parentDir = path.dirname(filePath);
    
    // Never create a directory job for the root SOURCE_DIR itself
    const resolvedParentDir = path.resolve(parentDir);
    const resolvedSourceDir = path.resolve(this.sourceDir);
    if (resolvedParentDir === resolvedSourceDir) {
      this.logger?.debug(`🏠 Skipping parent directory job for root source directory: ${path.basename(parentDir)}`);
      return null;
    }
    
    // Check if parent directory has multiple files that should be processed together
    try {
      const parentStat = await fs.stat(parentDir);
      if (!parentStat.isDirectory()) return null;
      
      const parentFiles = await fs.readdir(parentDir, { withFileTypes: true });
      const audioFiles = parentFiles.filter(f => f.isFile() && isAudio(f.name));
      const allFiles = parentFiles.filter(f => f.isFile());
      
      // Process as directory if:
      // 1. Multiple audio files, OR
      // 2. Single audio file with supporting files (cue, txt, jpg, etc.)
      if (audioFiles.length > 1 || (audioFiles.length === 1 && allFiles.length > 1)) {
        // Check if we already have a job for the parent directory
        let parentJob = this.findJobByPath(parentDir);
        
        if (!parentJob) {
          // Create a directory job for the parent
          parentJob = await Job.fromPath(parentDir);
          this.jobs.set(parentJob.id, parentJob);
          this.logger?.debug(`📁 Created parent directory job: "${parentJob.displayName}" [${parentJob.id}]`);
        }
        
        return parentJob;
      }
    } catch (error) {
      // If we can't analyze the parent directory, treat as individual file
    }
    
    return null;
  }

  /**
   * Find a job by its source path
   */
  findJobByPath(sourcePath) {
    const resolvedPath = path.resolve(sourcePath);
    for (const job of this.jobs.values()) {
      if (job.sourcePath === resolvedPath) {
        return job;
      }
    }
    return null;
  }

  /**
   * Schedule batch processing with debouncing
   */
  scheduleBatchProcess() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    
    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, this.batchProcessDelay);
  }

  /**
   * Process a batch of jobs
   */
  async processBatch() {
    if (this.isProcessing) {
      // Already processing, schedule another batch
      this.scheduleBatchProcess();
      return;
    }

    this.isProcessing = true;

    try {
      const readyJobs = this.getReadyJobs();
      
      if (readyJobs.length === 0) {
        return;
      }

      this.logger?.debug(`🔄 Processing batch of ${readyJobs.length} job(s)`);

      for (const job of readyJobs) {
        await this.processJob(job);
      }

    } catch (error) {
      this.logger?.error(`❌ Batch processing error: ${error.message}`);
    } finally {
      this.isProcessing = false;
      
      // Check if there are more jobs to process
      const pendingJobs = this.getJobsByState(JobState.PENDING, JobState.WAITING_STABILITY);
      if (pendingJobs.length > 0) {
        this.scheduleBatchProcess();
      }
    }
  }

  /**
   * Get jobs that are ready to be processed
   */
  getReadyJobs() {
    const jobs = [];
    
    for (const job of this.jobs.values()) {
      // Skip if already being processed
      if (this.processingJobs.has(job.id)) {
        continue;
      }

      if (job.state === JobState.PENDING) {
        jobs.push(job);
      } else if (job.state === JobState.WAITING_STABILITY) {
        // Check if enough time has passed for another stability check
        const timeSinceModified = job.getTimeSinceModified();
        if (timeSinceModified >= this.stabilityTimeout) {
          jobs.push(job);
        }
      }
    }

    return jobs;
  }

  /**
   * Process a single job
   */
  async processJob(job) {
    const jobLogger = job.createLogger(this.logger);
    
    try {
      // Check if source still exists
      const exists = await job.sourceExists();
      if (!exists) {
        job.setState(JobState.CANCELLED, 'Source no longer exists');
        jobLogger.warn(`❌ Source no longer exists: "${job.displayName}"`);
        return;
      }

      // For directory jobs, check stability first
      if (job.type === JobType.DIRECTORY) {
        const isStable = await job.checkStability(this.stabilityTimeout);
        
        if (!isStable) {
          if (!job.incrementStabilityCheck()) {
            job.setState(JobState.FAILED, 'Exceeded maximum stability checks');
            jobLogger.error(`❌ Directory "${job.displayName}" exceeded maximum stability checks`);
            return;
          }
          
          job.setState(JobState.WAITING_STABILITY);
          jobLogger.info(`⏳ Directory "${job.displayName}" not yet stable, waiting ${this.stabilityTimeout/1000}s...`);
          
          // Schedule next check
          setTimeout(() => {
            this.scheduleBatchProcess();
          }, this.stabilityTimeout);
          
          return;
        }
      }

      // Mark as processing
      this.processingJobs.add(job.id);
      job.setState(JobState.PROCESSING);
      
      jobLogger.info(`🎵 Starting ${job.type} migration: "${job.displayName}"`);

      // Import and execute migration
      const { migrateJob } = await import('./migrate.js');
      const result = await migrateJob(job, jobLogger);
      
      job.setState(JobState.COMPLETED);
      job.result = result;
      
      jobLogger.info(`✅ Migration completed: "${job.displayName}"`);

    } catch (error) {
      job.setState(JobState.FAILED, error);
      const jobLogger = job.createLogger(this.logger);
      jobLogger.error(`❌ Migration failed for "${job.displayName}": ${error.message}`);
      
      // TODO: Implement retry logic if needed
      
    } finally {
      this.processingJobs.delete(job.id);
    }
  }

  /**
   * Get jobs by state(s)
   */
  getJobsByState(...states) {
    return Array.from(this.jobs.values()).filter(job => states.includes(job.state));
  }

  /**
   * Get job statistics
   */
  getStats() {
    const stats = {
      total: this.jobs.size,
      pending: 0,
      waiting: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };

    for (const job of this.jobs.values()) {
      switch (job.state) {
        case JobState.PENDING:
          stats.pending++;
          break;
        case JobState.WAITING_STABILITY:
          stats.waiting++;
          break;
        case JobState.PROCESSING:
          stats.processing++;
          break;
        case JobState.COMPLETED:
          stats.completed++;
          break;
        case JobState.FAILED:
          stats.failed++;
          break;
        case JobState.CANCELLED:
          stats.cancelled++;
          break;
      }
    }

    return stats;
  }

  /**
   * Clean up completed/failed jobs older than specified age
   */
  cleanup(maxAge = 300000) { // 5 minutes default
    const now = Date.now();
    const toRemove = [];

    for (const [jobId, job] of this.jobs) {
      if ([JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED].includes(job.state)) {
        if (now - job.lastModified.getTime() > maxAge) {
          toRemove.push(jobId);
        }
      }
    }

    for (const jobId of toRemove) {
      this.jobs.delete(jobId);
    }

    if (toRemove.length > 0) {
      this.logger?.debug(`🧹 Cleaned up ${toRemove.length} old job(s)`);
    }
  }
}