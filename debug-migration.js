#!/usr/bin/env node

/**
 * Debug migration script to test the core migration functionality
 * This helps isolate the issue from the test framework
 */

import fs from 'fs-extra';
import { promises as fsPromises } from 'node:fs';
import path from 'path';
import os from 'os';
import { migrateJob } from './src/migrate.js';
import { Job, JobType } from './src/job.js';

async function debugMigration() {
  console.log('🔍 Starting migration debug test...');
  
  // Create temporary directories
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-debug-'));
  const sourceDir = path.join(testDir, 'incoming');
  const destDir = path.join(testDir, 'library');
  
  console.log(`📁 Test directory: ${testDir}`);
  console.log(`📥 Source directory: ${sourceDir}`);
  console.log(`📤 Destination directory: ${destDir}`);
  
  try {
    // IMPORTANT: Clear any existing env vars first (just like the integration test)
    delete process.env.SOURCE_DIR;
    delete process.env.DEST_DIR;

    // Set up environment exactly like the integration test
    process.env.SOURCE_DIR = sourceDir;
    process.env.DEST_DIR = destDir;
    process.env.PUID = '0';
    process.env.PGID = '0';
    process.env.FILE_MODE = '664';
    process.env.DIR_MODE = '775';
    
    // Import migration module AFTER env vars are set (like integration test does)
    console.log('🔄 Importing migration module...');
    const migrateModule = await import('./src/migrate.js');
    const { migrateJob } = migrateModule;
    console.log('✅ Migration module imported successfully');
    
    // Import config to verify it's reading the correct paths
    const configModule = await import('./src/config.js');
    const { DEST_DIR, SOURCE_DIR } = configModule;
    console.log(`📊 Config SOURCE_DIR(): ${SOURCE_DIR()}`);
    console.log(`📊 Config DEST_DIR(): ${DEST_DIR()}`);
    
    // Create directories
    await fs.ensureDir(sourceDir);
    await fs.ensureDir(destDir);
    
    // Create test file
    const testFilename = 'Test Author - Test Book.mp3';
    const testContent = 'fake audio content for debugging';
    const testFilePath = path.join(sourceDir, testFilename);
    
    console.log(`📝 Creating test file: ${testFilePath}`);
    await fs.writeFile(testFilePath, testContent);
    
    // Verify file was created
    const exists = await fs.pathExists(testFilePath);
    const stats = await fs.stat(testFilePath);
    console.log(`✅ Test file created: exists=${exists}, size=${stats.size} bytes`);
    
    // Check destination directory permissions
    const destStats = await fs.stat(destDir);
    console.log(`📊 Destination directory stats: mode=${destStats.mode.toString(8)}, uid=${destStats.uid}, gid=${destStats.gid}`);
    
    // Check write permissions
    const testWriteFile = path.join(destDir, '.write-test');
    try {
      await fs.writeFile(testWriteFile, 'test');
      await fs.remove(testWriteFile);
      console.log(`✅ Write permission test passed`);
    } catch (writeError) {
      console.log(`❌ Write permission test failed: ${writeError.message}`);
      throw writeError;
    }
    
    // Create simple logger
    const logger = {
      debug: (msg) => console.log(`[DEBUG] ${msg}`),
      info: (msg) => console.log(`[INFO] ${msg}`),
      warn: (msg) => console.log(`[WARN] ${msg}`),
      error: (msg) => console.log(`[ERROR] ${msg}`)
    };
    
    // Create job and run migration
    console.log(`🚀 Creating job for: ${testFilePath}`);
    const job = new Job(testFilePath, JobType.FILE);
    console.log(`📋 Job created: ${job.id}, type: ${job.type}, sourcePath: ${job.sourcePath}`);
    
    console.log(`🔄 Starting migration...`);
    const result = await migrateJob(job, logger);
    console.log(`✅ Migration completed:`, result);
    
    // Verify migration results
    console.log(`🔍 Verifying migration results...`);
    
    const destContents = await fs.readdir(destDir);
    console.log(`📂 Destination directory contents: ${JSON.stringify(destContents)}`);
    
    if (destContents.length === 0) {
      console.log(`❌ ERROR: Destination directory is empty!`);
      return false;
    }
    
    // Check for expected structure
    const expectedAuthor = 'Test Author';
    const expectedTitle = 'Test Book';
    const authorDir = path.join(destDir, expectedAuthor);
    const bookDir = path.join(authorDir, expectedTitle);
    const migratedFile = path.join(bookDir, testFilename);
    
    console.log(`🔍 Looking for: ${authorDir}`);
    console.log(`🔍 Author dir exists: ${await fs.pathExists(authorDir)}`);
    
    if (await fs.pathExists(authorDir)) {
      const authorContents = await fs.readdir(authorDir);
      console.log(`📂 Author directory contents: ${JSON.stringify(authorContents)}`);
      
      console.log(`🔍 Looking for: ${bookDir}`);
      console.log(`🔍 Book dir exists: ${await fs.pathExists(bookDir)}`);
      
      if (await fs.pathExists(bookDir)) {
        const bookContents = await fs.readdir(bookDir);
        console.log(`📂 Book directory contents: ${JSON.stringify(bookContents)}`);
        
        console.log(`🔍 Looking for: ${migratedFile}`);
        console.log(`🔍 Migrated file exists: ${await fs.pathExists(migratedFile)}`);
        
        if (await fs.pathExists(migratedFile)) {
          const migratedContent = await fs.readFile(migratedFile, 'utf8');
          const migratedStats = await fs.stat(migratedFile);
          console.log(`📄 Migrated file content: "${migratedContent}"`);
          console.log(`📊 Migrated file size: ${migratedStats.size} bytes`);
          
          if (migratedContent === testContent) {
            console.log(`✅ SUCCESS: Migration completed successfully!`);
            return true;
          } else {
            console.log(`❌ ERROR: File content mismatch!`);
            console.log(`   Expected: "${testContent}"`);
            console.log(`   Actual: "${migratedContent}"`);
            return false;
          }
        }
      }
    }
    
    console.log(`❌ ERROR: Migration structure not found!`);
    return false;
    
  } catch (error) {
    console.log(`❌ FATAL ERROR: ${error.message}`);
    console.log(`📚 Stack trace: ${error.stack}`);
    return false;
  } finally {
    // Clean up
    try {
      await fs.remove(testDir);
      console.log(`🧹 Cleaned up test directory: ${testDir}`);
    } catch (cleanupError) {
      console.log(`⚠️  Failed to clean up: ${cleanupError.message}`);
    }
  }
}

// Run the debug test
debugMigration().then(success => {
  console.log(`\n🏁 Debug test ${success ? 'PASSED' : 'FAILED'}`);
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error(`💥 Debug test crashed: ${error.message}`);
  process.exit(1);
});