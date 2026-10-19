import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

function createMockLogger() {
  const calls = { info: [], warn: [], debug: [], error: [] };
  const log = Object.fromEntries(Object.keys(calls).map(level => [level, (...args) => calls[level].push(args)]));
  return { log, calls };
}

function ffprobeInstalled() {
  childProcess.execFile.mockImplementation((command, args, options, callback) => {
    if (args[0] === '-version') return callback(null, { stdout: 'ffprobe version 7.1 Copyright (c)\nbuilt with gcc', stderr: '' });
    callback(null, { stdout: JSON.stringify({ format: { tags: { title: 'Dune', artist: 'Frank Herbert' } } }), stderr: '' });
  });
}

function ffprobeMissing() {
  childProcess.execFile.mockImplementation((command, args, options, callback) => {
    const error = new Error('spawn ffprobe ENOENT');
    error.code = 'ENOENT';
    callback(error);
  });
}

describe('validateFfprobe', () => {
  let metadata;

  beforeEach(async () => {
    vi.resetModules();
    childProcess.execFile.mockReset();
    metadata = await import('../src/metadata.js');
  });

  test('logs the version and returns true when ffprobe is installed', async () => {
    ffprobeInstalled();
    const { log, calls } = createMockLogger();

    expect(await metadata.validateFfprobe(log)).toBe(true);
    expect(calls.info.flat()).toContain('🎧 ffprobe validation successful (ffprobe version 7.1 Copyright (c))');
    expect(calls.warn).toHaveLength(0);
  });

  test('warns once on boot and not again on the first audio job when ffprobe is missing', async () => {
    ffprobeMissing();
    const { log, calls } = createMockLogger();

    expect(await metadata.validateFfprobe(log)).toBe(false);
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0][0]).toMatch(/ffprobe not found on PATH/);

    expect(await metadata.extractAudioMetadata('/books/Dune.m4b', log)).toBeNull();
    expect(calls.warn).toHaveLength(1);
  });

  test('re-probes rather than trusting an earlier cached failure', async () => {
    ffprobeMissing();
    const { log } = createMockLogger();
    await metadata.extractAudioMetadata('/books/Dune.m4b', log);

    ffprobeInstalled();
    expect(await metadata.validateFfprobe(log)).toBe(true);
    expect(await metadata.extractAudioMetadata('/books/Dune.m4b', log)).toMatchObject({ author: 'Frank Herbert' });
  });
});
