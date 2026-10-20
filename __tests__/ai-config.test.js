import { describe, test, expect } from 'vitest';
import { CLAUDE_MODEL, resolveAIConfig, validateConfig } from '../src/config.js';
import { clearAIEnv } from './ai-env.js';
import { readFileSync } from 'node:fs';

describe('selected AI configuration', () => {
  test('defaults remain Anthropic even with other credentials; getters are dynamic', () => {
    process.env.OPENAI_API_KEY = 'other';
    expect(resolveAIConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', baseURL: 'https://api.anthropic.com/v1', usable: false });
    process.env.AI_PROVIDER = '  ';
    expect(resolveAIConfig().provider).toBe('anthropic');
    process.env.CLAUDE_MODEL = 'legacy';
    process.env.ANTHROPIC_API_URL = 'https://legacy.example///';
    expect(resolveAIConfig()).toMatchObject({ model: 'legacy', baseURL: 'https://legacy.example/v1' });
    process.env.AI_MODEL = 'new';
    process.env.AI_BASE_URL = 'https://new.example/custom/v1/';
    expect(resolveAIConfig()).toMatchObject({ model: 'new', baseURL: 'https://new.example/custom/v1' });
  });

  test('CLAUDE_MODEL getter falls back to the default and reads overrides dynamically', () => {
    expect(CLAUDE_MODEL()).toBe('claude-haiku-5-5');
    process.env.CLAUDE_MODEL = 'override';
    expect(CLAUDE_MODEL()).toBe('override');
    delete process.env.CLAUDE_MODEL;
    expect(CLAUDE_MODEL()).toBe('claude-haiku-5-5');
  });

  test.each([
    ['anthropic', 'ANTHROPIC_API_KEY'], ['openai', 'OPENAI_API_KEY'],
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'], ['openai-compatible', 'AI_API_KEY']
  ])('%s uses only its cleaned key and model', (provider, variable) => {
    Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: ' selected-model ', AI_BASE_URL: 'http://localhost:8080/v1',
      ANTHROPIC_API_KEY: 'unused-ant', OPENAI_API_KEY: 'unused-openai', GOOGLE_GENERATIVE_AI_API_KEY: 'unused-google', AI_API_KEY: 'unused-compatible',
      CLAUDE_MODEL: 'ignored', ANTHROPIC_API_URL: 'not-a-url' });
    process.env[variable] = `  ' selected-key '  `;
    expect(resolveAIConfig()).toMatchObject({ provider, model: 'selected-model', apiKey: 'selected-key', keyVariable: variable, usable: true });
    expect(() => validateConfig()).not.toThrow();
    process.env[variable] = ' "second-key" ';
    expect(resolveAIConfig().apiKey).toBe('second-key');
    process.env[variable] = `'mismatched"`;
    expect(resolveAIConfig().apiKey).toBe(`'mismatched"`);
  });

  test.each(['openai', 'google', 'openai-compatible'])('%s requires a nonblank model', provider => {
    process.env.AI_PROVIDER = provider;
    process.env.CLAUDE_MODEL = 'ignored';
    process.env.AI_MODEL = '  ';
    expect(() => validateConfig()).toThrow(/AI_MODEL/);
  });

  test.each(['ftp://user:secret@example.com', 'invalid-secret', 'file:///private'])('rejects invalid bases safely: %s', base => {
    process.env.AI_BASE_URL = base;
    expect(() => validateConfig()).toThrow(/AI_BASE_URL.*HTTP\(S\)/);
    try { resolveAIConfig(); } catch (error) { expect(error.message).not.toContain('secret'); expect(error.message).not.toContain(base); }
  });

  test('unsupported values never echo operator input', () => {
    process.env.AI_PROVIDER = 'secret-sentinel';
    expect(() => resolveAIConfig()).toThrow(/anthropic, openai, google, openai-compatible/);
    try { validateConfig(); } catch (error) { expect(error.message).not.toContain('secret-sentinel'); }
  });

  test.each(['anthropic', 'openai', 'google'])('missing %s credentials warns without requiring other keys', provider => {
    Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'test' });
    expect(resolveAIConfig().usable).toBe(false);
    expect(validateConfig().join(' ')).toContain(`${resolveAIConfig().keyVariable} not set`);
  });

  test('compatible requires a base, accepts no key, and ignores invalid legacy URL', () => {
    Object.assign(process.env, { AI_PROVIDER: 'openai-compatible', AI_MODEL: 'local', ANTHROPIC_API_URL: 'bad' });
    expect(() => validateConfig()).toThrow(/AI_BASE_URL/);
    process.env.AI_BASE_URL = 'http://localhost:1234/v1';
    expect(resolveAIConfig()).toMatchObject({ usable: true, apiKey: '' });
    expect(validateConfig()).toEqual([]);
  });

  test('documentation examples resolve to their intended provider and endpoint', () => {
    const examples = [
      [{ ANTHROPIC_API_KEY: 'sk-ant-example' }, 'anthropic', 'claude-haiku-5-5', 'https://api.anthropic.com/v1'],
      [{ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-4.1-mini', OPENAI_API_KEY: 'example' }, 'openai', 'gpt-4.1-mini', undefined],
      [{ AI_PROVIDER: 'google', AI_MODEL: 'gemini-2.5-flash', GOOGLE_GENERATIVE_AI_API_KEY: 'example' }, 'google', 'gemini-2.5-flash', undefined],
      [{ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'local-model', AI_BASE_URL: 'http://localhost:1234/v1' }, 'openai-compatible', 'local-model', 'http://localhost:1234/v1'],
      [{ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'hosted-model', AI_BASE_URL: 'https://inference.example.com/v1', AI_API_KEY: 'example' }, 'openai-compatible', 'hosted-model', 'https://inference.example.com/v1'],
      [{ CLAUDE_MODEL: 'legacy-model', ANTHROPIC_API_URL: 'https://proxy.example.com', ANTHROPIC_API_KEY: 'sk-ant-example' }, 'anthropic', 'legacy-model', 'https://proxy.example.com/v1']
    ];
    for (const [env, provider, model, baseURL] of examples) {
      clearAIEnv(); Object.assign(process.env, env);
      expect(resolveAIConfig()).toMatchObject({ provider, model, baseURL, usable: true });
      expect(() => validateConfig()).not.toThrow();
    }
  });

  test('literal README dotenv blocks and active .env.example configuration stay valid', () => {
    const parse = block => Object.fromEntries(block.split(/\r?\n/)
      .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const blocks = [...readme.matchAll(/```dotenv\r?\n([\s\S]*?)```/g)];
    expect(blocks).toHaveLength(6);
    const expected = ['anthropic', 'openai', 'google', 'openai-compatible', 'openai-compatible', 'anthropic'];
    blocks.forEach(([, block], index) => {
      clearAIEnv(); Object.assign(process.env, parse(block));
      expect(resolveAIConfig()).toMatchObject({ provider: expected[index], usable: true });
      expect(() => validateConfig()).not.toThrow();
    });
    clearAIEnv();
    const example = parse(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
    Object.assign(process.env, example);
    expect(resolveAIConfig()).toMatchObject({ provider: 'anthropic', usable: false });
    expect(() => validateConfig()).not.toThrow();
  });
});
