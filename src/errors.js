/**
 * Centralized error hierarchy for Dewey
 *
 * This module provides a consistent error handling strategy across the application.
 * All custom errors extend DeweyError for easy identification and handling.
 */

/**
 * Base error class for all Dewey-specific errors
 */
export class DeweyError extends Error {
  constructor(message, code = 'DEWEY_ERROR') {
    super(message);
    this.name = 'DeweyError';
    this.code = code;
    this.timestamp = new Date();
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp
    };
  }
}

/**
 * Error for skipped migrations (not actual failures)
 * These are expected conditions like non-audio files, duplicates, etc.
 */
export class SkipError extends DeweyError {
  constructor(message, reason = 'skip') {
    super(message, 'SKIP');
    this.name = 'SkipError';
    this.reason = reason;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      reason: this.reason
    };
  }
}

/**
 * Error for retryable failures
 * These are transient errors that may succeed on retry (network issues, etc.)
 */
export class RetryableError extends DeweyError {
  constructor(message, originalError = null) {
    super(message, 'RETRYABLE');
    this.name = 'RetryableError';
    this.originalError = originalError;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      originalError: this.originalError ? String(this.originalError) : null
    };
  }
}

/**
 * Error for configuration issues
 * These are fatal errors that prevent the application from starting
 */
export class ConfigError extends DeweyError {
  constructor(message, invalidFields = []) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
    this.invalidFields = invalidFields;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      invalidFields: this.invalidFields
    };
  }
}

/**
 * Error for Claude API failures
 * Specific error type for AI service issues
 */
export class ClaudeError extends DeweyError {
  constructor(message, statusCode = null, isRateLimited = false) {
    super(message, 'CLAUDE_ERROR');
    this.name = 'ClaudeError';
    this.statusCode = statusCode;
    this.isRateLimited = isRateLimited;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      statusCode: this.statusCode,
      isRateLimited: this.isRateLimited
    };
  }
}

/**
 * Check if an error is retryable
 */
export function isRetryable(error) {
  if (error instanceof RetryableError) {
    return true;
  }

  if (error instanceof ClaudeError && error.isRateLimited) {
    return true;
  }

  return false;
}

/**
 * Check if an error should be skipped (not logged as failure)
 */
export function isSkippable(error) {
  return error instanceof SkipError;
}

/**
 * Check if an error is fatal (should stop the application)
 */
export function isFatal(error) {
  return error instanceof ConfigError;
}
