/**
 * Centralized configuration for all environment variables
 * This module exports getter functions that dynamically read from process.env
 * to support runtime changes (especially important for tests)
 */

// Core directory configuration
export const SOURCE_DIR = () => process.env.SOURCE_DIR || './data/incoming';
export const DEST_DIR = () => process.env.DEST_DIR || './data/library';

// Logging configuration
export const LOG_FILE = () => process.env.LOG_FILE || './data/logs/migrations.log';
export const LOG_LEVEL = () => process.env.LOG_LEVEL || 'info';

// Claude AI configuration  
export const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || '';
export const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';
export const ANTHROPIC_API_URL = () => (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/$/, '');

// Processing behavior
export const DIRECTORY_STABILITY_TIMEOUT = () => Number(process.env.DIRECTORY_STABILITY_TIMEOUT || 5000); // 5 seconds default

// File system permissions
export const PUID = () => Number(process.env.PUID || 0);
export const PGID = () => Number(process.env.PGID || 0);
export const FILE_MODE = () => process.env.FILE_MODE || '664';
export const DIR_MODE = () => process.env.DIR_MODE || '775';

// Export all config as a function that returns current values
export function getConfig() {
  return {
    SOURCE_DIR: SOURCE_DIR(),
    DEST_DIR: DEST_DIR(),
    LOG_FILE: LOG_FILE(),
    LOG_LEVEL: LOG_LEVEL(),
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY(),
    CLAUDE_MODEL: CLAUDE_MODEL(),
    ANTHROPIC_API_URL: ANTHROPIC_API_URL(),
    DIRECTORY_STABILITY_TIMEOUT: DIRECTORY_STABILITY_TIMEOUT(),
    PUID: PUID(),
    PGID: PGID(),
    FILE_MODE: FILE_MODE(),
    DIR_MODE: DIR_MODE()
  };
}

export default getConfig;