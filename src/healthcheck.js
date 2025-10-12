#!/usr/bin/env node

/**
 * Simple, deterministic healthcheck for Dewey audiobook migrator
 * Queries the application's actual status endpoint
 */

import dotenv from 'dotenv';

// Load environment variables from .env file FIRST
dotenv.config();

import http from 'node:http';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

async function healthcheck() {
  try {
    const status = await getApplicationStatus();
    
    if (!status.ready) {
      throw new Error('Application is not ready');
    }
    
    if (!status.watcherReady) {
      throw new Error('File watcher is not ready');
    }
    
    if (status.errors && status.errors.length > 0) {
      // Check if there are recent errors (within last 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const recentErrors = status.errors.filter(err => new Date(err.timestamp) > fiveMinutesAgo);
      
      if (recentErrors.length > 3) {
        throw new Error(`Too many recent errors: ${recentErrors.length}`);
      }
    }
    
    console.log('✅ Health check passed - application is ready and watching');
    process.exit(EXIT_SUCCESS);
    
  } catch (error) {
    console.error(`❌ Health check failed: ${error.message}`);
    process.exit(EXIT_FAILURE);
  }
}

function getApplicationStatus() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: '/health',
      method: 'GET',
      timeout: 3000
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const status = JSON.parse(data);
          resolve(status);
        } catch (error) {
          reject(new Error('Invalid status response'));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error(`Cannot connect to application: ${error.message}`));
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Health check request timed out'));
    });
    
    req.end();
  });
}

// Timeout to prevent hanging
setTimeout(() => {
  console.error('❌ Health check timed out');
  process.exit(EXIT_FAILURE);
}, 5000);

healthcheck();