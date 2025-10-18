import { describe, test, expect } from 'bun:test';
import {
  DeweyError,
  SkipError,
  RetryableError,
  ConfigError,
  ClaudeError,
  isRetryable,
  isSkippable,
  isFatal
} from '../src/errors.js';

describe('Error Hierarchy', () => {
  test('DeweyError should be base error class', () => {
    const error = new DeweyError('Test error', 'TEST_CODE');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeweyError);
    expect(error.name).toBe('DeweyError');
    expect(error.code).toBe('TEST_CODE');
    expect(error.message).toBe('Test error');
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  test('DeweyError toJSON should serialize properly', () => {
    const error = new DeweyError('Test error', 'TEST_CODE');
    const json = error.toJSON();

    expect(json).toHaveProperty('name', 'DeweyError');
    expect(json).toHaveProperty('code', 'TEST_CODE');
    expect(json).toHaveProperty('message', 'Test error');
    expect(json).toHaveProperty('timestamp');
  });

  test('SkipError should extend DeweyError', () => {
    const error = new SkipError('Non-audio file', 'non-audio');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeweyError);
    expect(error).toBeInstanceOf(SkipError);
    expect(error.name).toBe('SkipError');
    expect(error.code).toBe('SKIP');
    expect(error.reason).toBe('non-audio');
  });

  test('RetryableError should extend DeweyError', () => {
    const originalError = new Error('Network timeout');
    const error = new RetryableError('Failed to connect', originalError);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeweyError);
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.name).toBe('RetryableError');
    expect(error.code).toBe('RETRYABLE');
    expect(error.originalError).toBe(originalError);
  });

  test('ConfigError should extend DeweyError', () => {
    const error = new ConfigError('Invalid config', ['SOURCE_DIR', 'DEST_DIR']);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeweyError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.name).toBe('ConfigError');
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.invalidFields).toEqual(['SOURCE_DIR', 'DEST_DIR']);
  });

  test('ClaudeError should extend DeweyError', () => {
    const error = new ClaudeError('API rate limited', 429, true);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeweyError);
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error.name).toBe('ClaudeError');
    expect(error.code).toBe('CLAUDE_ERROR');
    expect(error.statusCode).toBe(429);
    expect(error.isRateLimited).toBe(true);
  });
});

describe('Error Helper Functions', () => {
  test('isRetryable should identify retryable errors', () => {
    const retryableError = new RetryableError('Network error');
    const rateLimitedClaude = new ClaudeError('Rate limited', 429, true);
    const skipError = new SkipError('Non-audio');
    const genericError = new Error('Generic error');

    expect(isRetryable(retryableError)).toBe(true);
    expect(isRetryable(rateLimitedClaude)).toBe(true);
    expect(isRetryable(skipError)).toBe(false);
    expect(isRetryable(genericError)).toBe(false);
  });

  test('isSkippable should identify skip errors', () => {
    const skipError = new SkipError('Non-audio');
    const retryableError = new RetryableError('Network error');
    const genericError = new Error('Generic error');

    expect(isSkippable(skipError)).toBe(true);
    expect(isSkippable(retryableError)).toBe(false);
    expect(isSkippable(genericError)).toBe(false);
  });

  test('isFatal should identify fatal errors', () => {
    const configError = new ConfigError('Invalid config');
    const skipError = new SkipError('Non-audio');
    const genericError = new Error('Generic error');

    expect(isFatal(configError)).toBe(true);
    expect(isFatal(skipError)).toBe(false);
    expect(isFatal(genericError)).toBe(false);
  });
});

describe('Error Serialization', () => {
  test('SkipError toJSON should include reason', () => {
    const error = new SkipError('File skipped', 'duplicate');
    const json = error.toJSON();

    expect(json).toHaveProperty('reason', 'duplicate');
    expect(json).toHaveProperty('code', 'SKIP');
  });

  test('RetryableError toJSON should include originalError', () => {
    const originalError = new Error('Original error');
    const error = new RetryableError('Retry needed', originalError);
    const json = error.toJSON();

    expect(json).toHaveProperty('originalError');
    expect(json.originalError).toContain('Original error');
  });

  test('ConfigError toJSON should include invalidFields', () => {
    const error = new ConfigError('Invalid config', ['FIELD_1', 'FIELD_2']);
    const json = error.toJSON();

    expect(json).toHaveProperty('invalidFields');
    expect(json.invalidFields).toEqual(['FIELD_1', 'FIELD_2']);
  });

  test('ClaudeError toJSON should include statusCode and isRateLimited', () => {
    const error = new ClaudeError('API error', 500, false);
    const json = error.toJSON();

    expect(json).toHaveProperty('statusCode', 500);
    expect(json).toHaveProperty('isRateLimited', false);
  });
});
