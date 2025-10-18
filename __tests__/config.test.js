import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigError } from '../src/errors.js';

describe('Configuration Validation', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  test('validateConfig should pass with valid default configuration', async () => {
    // Set up valid environment
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.LOG_LEVEL = 'info';
    process.env.DIRECTORY_STABILITY_TIMEOUT = '5000';
    process.env.PUID = '1000';
    process.env.PGID = '1000';
    process.env.FILE_MODE = '664';
    process.env.DIR_MODE = '775';
    process.env.ANTHROPIC_API_URL = 'https://api.anthropic.com';
    // Explicitly remove API key to test warning
    delete process.env.ANTHROPIC_API_KEY;

    // Need to reimport to pick up new env vars
    const config = await import('../src/config.js?t=' + Date.now());

    const warnings = config.validateConfig();
    expect(Array.isArray(warnings)).toBe(true);
    // Should have warning about missing API key
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('validateConfig should use defaults for empty SOURCE_DIR', async () => {
    delete process.env.SOURCE_DIR;
    process.env.DEST_DIR = './data/library';

    const config = await import('../src/config.js?t=' + Date.now());

    // Should use default and not throw
    const warnings = config.validateConfig();
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('validateConfig should use defaults for empty DEST_DIR', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    delete process.env.DEST_DIR;

    const config = await import('../src/config.js?t=' + Date.now());

    // Should use default and not throw
    const warnings = config.validateConfig();
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('validateConfig should fail when SOURCE_DIR equals DEST_DIR', async () => {
    process.env.SOURCE_DIR = './data/same';
    process.env.DEST_DIR = './data/same';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/must be different directories/);
  });

  test('validateConfig should fail with invalid LOG_LEVEL', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.LOG_LEVEL = 'invalid';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/LOG_LEVEL must be one of/);
  });

  test('validateConfig should fail with DIRECTORY_STABILITY_TIMEOUT < 1000', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.DIRECTORY_STABILITY_TIMEOUT = '500';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/must be >= 1000ms/);
  });

  test('validateConfig should warn with very high DIRECTORY_STABILITY_TIMEOUT', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.DIRECTORY_STABILITY_TIMEOUT = '400000'; // > 300000

    const config = await import('../src/config.js?t=' + Date.now());

    const warnings = config.validateConfig();
    expect(warnings.some(w => w.includes('very high'))).toBe(true);
  });

  test('validateConfig should fail with invalid PUID', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.PUID = 'not-a-number';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/PUID must be a valid number/);
  });

  test('validateConfig should fail with negative PUID', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.PUID = '-1';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/PUID must be >= 0/);
  });

  test('validateConfig should fail with invalid FILE_MODE', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.FILE_MODE = '999'; // Invalid octal

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/FILE_MODE must be a valid octal mode/);
  });

  test('validateConfig should fail with invalid DIR_MODE', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.DIR_MODE = 'abc'; // Invalid octal

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/DIR_MODE must be a valid octal mode/);
  });

  test('validateConfig should warn when ANTHROPIC_API_KEY is missing', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    delete process.env.ANTHROPIC_API_KEY;

    const config = await import('../src/config.js?t=' + Date.now());

    const warnings = config.validateConfig();
    expect(warnings.some(w => w.includes('ANTHROPIC_API_KEY not set'))).toBe(true);
  });

  test('validateConfig should warn when ANTHROPIC_API_KEY has wrong format', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.ANTHROPIC_API_KEY = 'invalid-key-format';

    const config = await import('../src/config.js?t=' + Date.now());

    const warnings = config.validateConfig();
    expect(warnings.some(w => w.includes('does not match expected format'))).toBe(true);
  });

  test('validateConfig should fail with invalid ANTHROPIC_API_URL', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.ANTHROPIC_API_URL = 'not-a-valid-url';

    const config = await import('../src/config.js?t=' + Date.now());

    expect(() => config.validateConfig()).toThrow(ConfigError);
    expect(() => config.validateConfig()).toThrow(/is not a valid URL/);
  });

  test('validateConfig should accept valid octal file modes', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.FILE_MODE = '644';
    process.env.DIR_MODE = '755';

    const config = await import('../src/config.js?t=' + Date.now());

    // Should not throw
    const warnings = config.validateConfig();
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('validateConfig should accept 4-digit octal modes', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.FILE_MODE = '0644';
    process.env.DIR_MODE = '0755';

    const config = await import('../src/config.js?t=' + Date.now());

    // Should not throw
    const warnings = config.validateConfig();
    expect(Array.isArray(warnings)).toBe(true);
  });

  test('validateConfig should accept all valid log levels', async () => {
    const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

    for (const level of validLevels) {
      process.env.SOURCE_DIR = './data/incoming';
      process.env.DEST_DIR = './data/library';
      process.env.LOG_LEVEL = level;

      const config = await import('../src/config.js?t=' + Date.now());

      // Should not throw
      const warnings = config.validateConfig();
      expect(Array.isArray(warnings)).toBe(true);
    }
  });

  test('ConfigError should include invalid fields', async () => {
    process.env.SOURCE_DIR = './data/incoming';
    process.env.DEST_DIR = './data/library';
    process.env.LOG_LEVEL = 'invalid';
    process.env.PUID = 'not-a-number';

    const config = await import('../src/config.js?t=' + Date.now());

    try {
      config.validateConfig();
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.invalidFields).toBeDefined();
      expect(error.invalidFields.length).toBeGreaterThan(0);
    }
  });
});
