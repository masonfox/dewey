import { beforeEach, afterEach, expect, vi } from 'vitest';
import { aiEnvKeys, clearAIEnv } from './ai-env.js';

// Ordinary tests cannot inherit provider selection or accidentally send traffic.
// The two live suites additionally require RUN_LIVE_AI_TESTS=1 and credentials.
const originalEnv = { ...process.env };
const liveSuite = process.env.RUN_LIVE_AI_TESTS === '1' &&
  /[\\/](?:integration|metadata-integration)\.test\.js$/.test(expect.getState().testPath || '');
if (!liveSuite) clearAIEnv();
beforeEach(() => {
  if (!liveSuite) {
    clearAIEnv();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network forbidden in deterministic tests'); }));
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAIEnv();
  if (liveSuite) for (const key of aiEnvKeys) {
    if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
  }
});
