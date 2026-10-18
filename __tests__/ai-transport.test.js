import { test, expect, vi } from 'vitest';
import { normalizeViaAI, validateAI } from '../src/ai.js';

const text = '{"author":"Transport Author","title":"Transport Title"}';
const log = { warn: vi.fn(), info: vi.fn() };
function response(provider, refusal = false) {
  if (provider === 'anthropic') return { id: 'msg_test', type: 'message', role: 'assistant', model: 'chosen-model',
    content: [{ type: 'text', text }], stop_reason: refusal ? 'refusal' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 } };
  if (provider === 'google') return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: refusal ? 'SAFETY' : 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } };
  return { id: 'chat_test', object: 'chat.completion', created: 1, model: 'chosen-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text, ...(refusal ? { refusal: 'refused' } : {}) }, finish_reason: refusal ? 'content_filter' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
}

test.each([
  ['anthropic', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1/messages', 'x-api-key'],
  ['openai', 'OPENAI_API_KEY', 'https://api.openai.com/v1/chat/completions', 'authorization'],
  ['google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/models/chosen-model:generateContent', 'x-goog-api-key'],
  ['openai-compatible', 'AI_API_KEY', 'http://localhost:1234/v1/chat/completions', 'authorization']
])('%s adapter uses selected URL/model/key for both startup and normalization', async (provider, keyVariable, expectedURL, keyHeader) => {
  Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'chosen-model',
    ANTHROPIC_API_KEY: 'unselected-anthropic', OPENAI_API_KEY: 'unselected-openai', GOOGLE_GENERATIVE_AI_API_KEY: 'unselected-google', AI_API_KEY: 'unselected-compatible',
    ANTHROPIC_AUTH_TOKEN: 'unselected-token' });
  process.env[keyVariable] = ' "selected-secret" ';
  if (provider === 'openai-compatible') process.env.AI_BASE_URL = 'http://localhost:1234/v1';
  const fetch = vi.fn(async () => new Response(JSON.stringify(response(provider)), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  expect(await validateAI(log)).toBe(true);
  expect(await normalizeViaAI('file.mp3', '', '', log)).toEqual({ author: 'Transport Author', title: 'Transport Title' });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toBe(expectedURL);
    const headers = new Headers(init.headers);
    expect(headers.get(keyHeader)).toBe(keyHeader === 'authorization' ? 'Bearer selected-secret' : 'selected-secret');
    if (keyHeader !== 'authorization') expect(headers.has('authorization')).toBe(false);
    if (keyHeader !== 'x-api-key') expect(headers.has('x-api-key')).toBe(false);
    if (keyHeader !== 'x-goog-api-key') expect(headers.has('x-goog-api-key')).toBe(false);
    expect(JSON.stringify(init)).not.toContain('unselected');
    const body = JSON.parse(init.body);
    if (provider !== 'google') expect(body.model).toBe('chosen-model');
  }
});

test.each(['anthropic', 'openai', 'google', 'openai-compatible'])('%s honors an API base including custom path', async provider => {
  Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'chosen-model', AI_BASE_URL: 'https://proxy.example/custom/v42/',
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test', AI_API_KEY: 'test' });
  const fetch = vi.fn(async () => Response.json(response(provider)));
  vi.stubGlobal('fetch', fetch);
  expect(await validateAI(log)).toBe(true);
  const suffix = provider === 'anthropic' ? '/messages' : provider === 'google' ? '/models/chosen-model:generateContent' : '/chat/completions';
  expect(String(fetch.mock.calls[0][0])).toBe('https://proxy.example/custom/v42' + suffix);
});

test('legacy Anthropic API root retains /v1/messages routing', async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_MODEL: 'legacy-model', ANTHROPIC_API_URL: 'https://legacy.example/root///' });
  const fetch = vi.fn(async () => Response.json(response('anthropic')));
  vi.stubGlobal('fetch', fetch);
  expect(await validateAI(log)).toBe(true);
  expect(String(fetch.mock.calls[0][0])).toBe('https://legacy.example/root/v1/messages');
  expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('legacy-model');
});

test('credential-free compatible requests omit authorization despite ambient native keys', async () => {
  Object.assign(process.env, { AI_PROVIDER: 'openai-compatible', AI_MODEL: 'chosen-model', AI_BASE_URL: 'http://localhost:1234/v1',
    ANTHROPIC_API_KEY: 'unused', OPENAI_API_KEY: 'unused', GOOGLE_GENERATIVE_AI_API_KEY: 'unused' });
  const fetch = vi.fn(async () => Response.json(response('openai-compatible')));
  vi.stubGlobal('fetch', fetch);
  expect(await normalizeViaAI('file.mp3', '', '', log)).not.toBeNull();
  const headers = new Headers(fetch.mock.calls[0][1].headers);
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) expect(headers.has(name)).toBe(false);
});

test.each(['anthropic', 'openai', 'google', 'openai-compatible'])('%s provider refusal returns fallback without retry', async provider => {
  Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'chosen-model', AI_BASE_URL: 'http://localhost/v1',
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test', AI_API_KEY: 'test' });
  const fetch = vi.fn(async () => Response.json(response(provider, true)));
  vi.stubGlobal('fetch', fetch);
  expect(await normalizeViaAI('file.mp3', '', '', log)).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
});

test('invalid selection fails before transport access', async () => {
  process.env.AI_PROVIDER = 'unsupported';
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(validateAI(log)).rejects.toThrow(/AI_PROVIDER/);
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['openai', 'openai-compatible'])('%s rejects explicit refusal even when finish_reason is stop and content looks valid', async provider => {
  Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'chosen-model', AI_BASE_URL: 'http://localhost/v1', OPENAI_API_KEY: 'test', AI_API_KEY: 'test' });
  const body = response(provider, true);
  body.choices[0].finish_reason = 'stop';
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetch);
  expect(await validateAI(log)).toBe(false);
  expect(await normalizeViaAI('file.mp3', '', '', log)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('real SDK transport does not multiply the three-attempt retry budget', async () => {
  vi.useFakeTimers();
  try {
    Object.assign(process.env, { AI_PROVIDER: 'openai-compatible', AI_MODEL: 'chosen-model', AI_BASE_URL: 'http://retry-test/v1' });
    const fetch = vi.fn(async () => Response.json({ error: { message: 'transient-secret' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const result = normalizeViaAI('file.mp3', '', '', log);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('transient-secret');
  } finally {
    vi.useRealTimers();
  }
});
