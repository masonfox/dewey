/**
 * Centralized configuration for all environment variables
 * This module exports getter functions that dynamically read from process.env
 * to support runtime changes (especially important for tests)
 */

import { ConfigError } from './errors.js';

// Core directory configuration
export const SOURCE_DIR = () => process.env.SOURCE_DIR || './data/incoming';
export const DEST_DIR = () => process.env.DEST_DIR || './data/library';

// Logging configuration
export const LOG_FILE = () => process.env.LOG_FILE || './data/logs/migrations.log';
export const LOG_LEVEL = () => process.env.LOG_LEVEL || 'info';

// Claude AI configuration  
export const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || '';
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
export const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
export const ANTHROPIC_API_URL = () => (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/$/, '');

const nonblank = value => value?.trim() || '';
const keyVariables = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY', 'openai-compatible': 'AI_API_KEY'
};

/** Resolve at use time; never include raw values in configuration errors. */
export function resolveAIConfig() {
  const provider = nonblank(process.env.AI_PROVIDER) || 'anthropic';
  if (!Object.hasOwn(keyVariables, provider)) {
    throw new ConfigError('AI_PROVIDER must be one of: anthropic, openai, google, openai-compatible', ['AI_PROVIDER']);
  }
  const model = nonblank(process.env.AI_MODEL) || (provider === 'anthropic'
    ? nonblank(process.env.CLAUDE_MODEL) || DEFAULT_CLAUDE_MODEL : '');
  if (!model) throw new ConfigError('AI_MODEL is required for the selected provider', ['AI_MODEL']);
  const legacy = provider === 'anthropic' && !nonblank(process.env.AI_BASE_URL);
  const urlVariable = legacy ? 'ANTHROPIC_API_URL' : 'AI_BASE_URL';
  let baseURL = nonblank(process.env.AI_BASE_URL) || (legacy
    ? `${(nonblank(process.env.ANTHROPIC_API_URL) || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1` : undefined);
  if (baseURL || provider === 'openai-compatible') {
    try {
      const url = new URL(baseURL);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      baseURL = baseURL.replace(/\/+$/, '');
    } catch {
      throw new ConfigError(`${urlVariable} is not a valid URL; an HTTP(S) API base is required`, [urlVariable]);
    }
  }
  const keyVariable = keyVariables[provider];
  let apiKey = nonblank(process.env[keyVariable]);
  if (apiKey.length >= 2 && ['"', "'"].includes(apiKey[0]) && apiKey.at(-1) === apiKey[0]) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  return { provider, model, baseURL, apiKey, keyVariable, usable: provider === 'openai-compatible' || Boolean(apiKey) };
}

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

/**
 * Validate configuration values
 * Throws ConfigError if any validation fails
 */
export function validateConfig() {
  const errors = [];
  const warnings = [];

  // Validate required directories
  // Note: We check the env var directly to catch empty strings before defaults are applied
  const sourceDir = SOURCE_DIR();
  const destDir = DEST_DIR();

  // Since SOURCE_DIR() and DEST_DIR() have defaults, they will never be empty
  // But we should validate they're not the same
  if (!sourceDir || sourceDir.trim() === '') {
    errors.push('SOURCE_DIR cannot be empty');
  }

  if (!destDir || destDir.trim() === '') {
    errors.push('DEST_DIR cannot be empty');
  }

  // Ensure source and dest are different
  if (sourceDir && destDir && sourceDir === destDir) {
    errors.push('SOURCE_DIR and DEST_DIR must be different directories');
  }

  // Validate log level
  const validLogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const logLevel = LOG_LEVEL();
  if (!validLogLevels.includes(logLevel)) {
    errors.push(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')} (got: "${logLevel}")`);
  }

  // Validate stability timeout
  const stabilityTimeout = DIRECTORY_STABILITY_TIMEOUT();
  if (isNaN(stabilityTimeout)) {
    errors.push('DIRECTORY_STABILITY_TIMEOUT must be a valid number');
  } else if (stabilityTimeout < 1000) {
    errors.push('DIRECTORY_STABILITY_TIMEOUT must be >= 1000ms (got: ' + stabilityTimeout + 'ms)');
  } else if (stabilityTimeout > 300000) {
    warnings.push('DIRECTORY_STABILITY_TIMEOUT is very high (' + (stabilityTimeout / 1000) + 's) - this may delay processing');
  }

  // Validate PUID/PGID
  const puid = PUID();
  const pgid = PGID();

  if (isNaN(puid)) {
    errors.push('PUID must be a valid number');
  } else if (puid < 0) {
    errors.push('PUID must be >= 0');
  }

  if (isNaN(pgid)) {
    errors.push('PGID must be a valid number');
  } else if (pgid < 0) {
    errors.push('PGID must be >= 0');
  }

  // Validate file mode strings
  const fileMode = FILE_MODE();
  const dirMode = DIR_MODE();

  if (!/^[0-7]{3,4}$/.test(fileMode)) {
    errors.push(`FILE_MODE must be a valid octal mode (e.g., "644", "664") - got: "${fileMode}"`);
  }

  if (!/^[0-7]{3,4}$/.test(dirMode)) {
    errors.push(`DIR_MODE must be a valid octal mode (e.g., "755", "775") - got: "${dirMode}"`);
  }

  try {
    const ai = resolveAIConfig();
    if (!ai.usable) warnings.push(ai.keyVariable + ' not set - will use heuristics for metadata extraction');
    else if (ai.provider === 'anthropic' && !ai.apiKey.startsWith('sk-ant-')) {
      warnings.push('ANTHROPIC_API_KEY does not match expected format (should start with "sk-ant-")');
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    errors.push(error.message);
  }

  // Throw if there are any errors
  if (errors.length > 0) {
    const invalidFields = errors.map(e => e.split(' ')[0]);
    throw new ConfigError(
      `Configuration validation failed:\n  - ${errors.join('\n  - ')}`,
      invalidFields
    );
  }

  // Return warnings for non-fatal issues
  return warnings;
}

export default getConfig;
