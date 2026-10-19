import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { APICallError, generateText } from 'ai';
vi.mock('ai', async importOriginal => ({ ...await importOriginal(), generateText: vi.fn() }));
import { normalizeViaAI, validateAI, parseMetadata, buildPrompt, reserveAttempt, resolveMatchViaAI } from '../src/ai.js';
import { normalizeViaClaude, validateClaude } from '../src/claude.js';

const log = { warn: vi.fn(), info: vi.fn() };
const valid = { text: '{"author":"Author","title":"Title"}', finishReason: 'stop' };
const normalize = () => normalizeViaAI('filename.mp3', 'fallback', 'fallback', log, '/parent');
const apiError = statusCode => new APICallError({ message: 'secret-sentinel https://user:pass@host?token=secret',
  url: 'https://secret', requestBodyValues: {}, statusCode, responseBody: 'secret-sentinel' });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  vi.clearAllMocks();
  generateText.mockReset();
  Object.assign(process.env, { AI_PROVIDER: 'openai-compatible', AI_MODEL: 'test-model',
    AI_BASE_URL: 'http://localhost/v1', AI_API_KEY: crypto.randomUUID() });
});
afterEach(() => vi.useRealTimers());

test('legacy imports forward to the same neutral implementation', () => {
  expect(normalizeViaClaude).toBe(normalizeViaAI);
  expect(validateClaude).toBe(validateAI);
});

test('prompt preserves filename, parent context, all embedded tags and authority', () => {
  const prompt = buildPrompt('book.mp3', '/incoming/parent', { hasMetadata: true, author: 'Tag Author', title: 'Tag Title', year: 2024, genre: 'Fiction' });
  for (const text of ['book.mp3', 'PARENT_DIR: parent', 'Tag Author', 'Tag Title', '2024', 'Fiction', 'authoritative', 'primary source']) expect(prompt).toContain(text);
});

test('accepts fenced JSON and returns only trimmed strings', async () => {
  generateText.mockResolvedValue({ text: '```json\n{"author":" Author ","title":" Title ","extra":true}\n```' });
  expect(await normalize()).toEqual({ author: 'Author', title: 'Title' });
  expect(generateText).toHaveBeenCalledOnce();
  expect(generateText.mock.calls[0][0]).toMatchObject({ maxRetries: 0, maxOutputTokens: 1024 });
});

test.each([undefined, null, 123, 'not JSON', '{}', 'null', '{"author":1,"title":"Title"}', '{"author":"Author","title":[]}', '{"author":" ","title":"Title"}', '{"author":"Author","title":""}'])('rejects invalid content without retry: %s', async text => {
  generateText.mockResolvedValue({ text });
  expect(await normalize()).toBeNull();
  expect(generateText).toHaveBeenCalledOnce();
  expect(() => parseMetadata(text)).toThrow();
});

test.each([408, 429, 500, 502, 503, 599])('retries transient HTTP %s with exact 2s/4s backoff and three attempts', async status => {
  generateText.mockRejectedValue(apiError(status));
  const result = normalize();
  await vi.advanceTimersByTimeAsync(0);
  expect(generateText).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(generateText).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(generateText).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3999);
  expect(generateText).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeNull();
  expect(generateText).toHaveBeenCalledTimes(3);
});

test.each([400, 401, 403, 404, 422])('does not retry HTTP %s and diagnostics contain no raw errors', async status => {
  process.env.AI_API_KEY = 'secret-sentinel';
  process.env.AI_BASE_URL = 'https://user:pass@host/v1?token=secret';
  generateText.mockRejectedValue(apiError(status));
  expect(await normalize()).toBeNull();
  expect(generateText).toHaveBeenCalledOnce();
  const output = JSON.stringify(log.warn.mock.calls);
  for (const secret of ['secret-sentinel', 'user:pass', 'token=secret', 'https://secret']) expect(output).not.toContain(secret);
  expect(output).toContain(`HTTP ${status}`);
});

test.each([new TypeError('secret-sentinel'), Object.assign(new Error('secret-sentinel'), { code: 'ECONNRESET' }), new DOMException('secret-sentinel', 'AbortError')])('network/abort errors recover with retries', async error => {
  generateText.mockRejectedValueOnce(error).mockResolvedValue(valid);
  const result = normalize();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toEqual({ author: 'Author', title: 'Title' });
  expect(generateText).toHaveBeenCalledTimes(2);
});

test('15-second deadlines abort every attempt, with no more than three', async () => {
  generateText.mockImplementation(() => new Promise(() => {}));
  const result = normalize();
  await vi.advanceTimersByTimeAsync(14999);
  expect(generateText.mock.calls[0][0].abortSignal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(generateText.mock.calls[0][0].abortSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(36000);
  expect(await result).toBeNull();
  expect(generateText).toHaveBeenCalledTimes(3);
  for (const [options] of generateText.mock.calls) expect(options.abortSignal.aborted).toBe(true);
});

test('refusal never retries even with valid-looking JSON', async () => {
  generateText.mockResolvedValue({ ...valid, finishReason: 'content-filter' });
  expect(await normalize()).toBeNull();
  expect(generateText).toHaveBeenCalledOnce();
});

test.each(['anthropic', 'openai', 'google'])('missing native %s credentials causes zero requests', async provider => {
  process.env.AI_PROVIDER = provider;
  expect(await validateAI(log)).toBe(false);
  expect(await normalize()).toBeNull();
  expect(generateText).not.toHaveBeenCalled();
});

test('startup deadline is ten seconds with no retry and normalization can recover', async () => {
  generateText.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(valid);
  const result = validateAI(log);
  await vi.advanceTimersByTimeAsync(9999);
  expect(generateText.mock.calls[0][0].abortSignal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(false);
  expect(generateText).toHaveBeenCalledOnce();
  expect(generateText.mock.calls[0][0]).toMatchObject({ maxRetries: 0, maxOutputTokens: 16 });
  expect(await normalize()).toEqual({ author: 'Author', title: 'Title' });
});

test('startup failures are advisory and secret-free; success identifies selection', async () => {
  process.env.AI_API_KEY = 'secret-sentinel';
  generateText.mockRejectedValueOnce(apiError(401)).mockResolvedValue(valid);
  expect(await validateAI(log)).toBe(false);
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-sentinel');
  expect(await validateAI(log)).toBe(true);
  expect(log.info).toHaveBeenCalledWith(expect.stringContaining('openai-compatible model=test-model'));
});

describe('rolling attempt pacing', () => {
  test('minute boundary and concurrent waits reserve slots atomically', async () => {
    const config = { provider: 'openai', baseURL: 'https://example', apiKey: crypto.randomUUID() };
    await Promise.all(Array.from({ length: 45 }, () => reserveAttempt(config)));
    let completed = 0;
    const waiting = Array.from({ length: 46 }, () => reserveAttempt(config).then(() => completed++));
    await vi.advanceTimersByTimeAsync(59999);
    expect(completed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(45);
    await vi.advanceTimersByTimeAsync(60000);
    await Promise.all(waiting);
    expect(completed).toBe(46);
  });

  test('provider, endpoint, and full credential configurations have independent budgets', async () => {
    const config = { provider: 'openai', baseURL: 'https://example', apiKey: 'same-prefix-' + crypto.randomUUID() };
    await Promise.all(Array.from({ length: 45 }, () => reserveAttempt(config)));
    for (const distinct of [{ ...config, provider: 'google' }, { ...config, baseURL: 'https://other' }, { ...config, apiKey: config.apiKey + '-other' }]) {
      await reserveAttempt(distinct);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test('retries consume capacity too', async () => {
    const { resolveAIConfig } = await import('../src/config.js');
    const config = resolveAIConfig();
    await Promise.all(Array.from({ length: 44 }, () => reserveAttempt(config)));
    generateText.mockRejectedValueOnce(apiError(429)).mockResolvedValue(valid);
    const result = normalize();
    await vi.advanceTimersByTimeAsync(59999);
    expect(generateText).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ author: 'Author', title: 'Title' });
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});

describe('format-aware normalization prompt', () => {
  test('EPUB unit prompt names the ebook format and labels OPF title, author, and language', () => {
    const prompt = buildPrompt('Dune.epub', '/incoming', { title: 'Dune', author: 'Frank Herbert', language: 'en' }, ['epub']);
    for (const text of ['book librarian', 'FORMATS: ebook (EPUB)', 'EPUB OPF package', 'Title: "Dune"', 'Author: "Frank Herbert"', 'Language: "en"', 'primary source']) expect(prompt).toContain(text);
    expect(prompt).not.toContain('audio file tags');
    expect(prompt).toContain('Return ONLY valid JSON: { "author": "Full Author Name", "title": "Clean Book Title" }');
  });

  test('mixed units list both formats and label tags by declared source', () => {
    const prompt = buildPrompt('Dune', null, { hasMetadata: true, title: 'Dune', author: 'Frank Herbert', source: 'audio' }, ['audio', 'epub']);
    expect(prompt).toContain('FORMATS: audiobook, ebook (EPUB)');
    expect(prompt).toContain('from audio file tags');
  });

  test('audio units without formats keep tag wording and no format line', () => {
    expect(buildPrompt('book.mp3', null, { hasMetadata: true, title: 'T' })).toContain('from audio file tags');
    const prompt = buildPrompt('book.mp3', null, { hasMetadata: false, title: null, author: null });
    expect(prompt).not.toContain('FORMATS:');
    expect(prompt).not.toContain('EMBEDDED METADATA');
  });

  test('normalizeViaAI forwards formats to the prompt', async () => {
    generateText.mockResolvedValue(valid);
    await normalizeViaAI('Dune.epub', '', '', log, null, { title: 'Dune', language: 'en' }, ['epub']);
    expect(generateText.mock.calls[0][0].prompt).toContain('EPUB OPF package');
  });
});

describe('resolveMatchViaAI', () => {
  const unit = { displayName: 'Dune - Deluxe Edition.m4b', formats: ['audio'],
    metadata: { title: 'Dune: Deluxe Edition', author: 'Frank Herbert', language: 'en', identifiers: ['asin:B00B7NPRY8'] } };
  const candidates = [
    { folder: 'Dune Messiah', title: 'Dune Messiah', author: 'Frank Herbert', language: 'en', formats: ['epub'] },
    { folder: 'Dune', title: 'Dune', author: 'Frank Herbert', language: 'en', formats: ['epub'] }
  ];
  const reply = body => ({ text: JSON.stringify(body), finishReason: 'stop' });
  const resolve = () => resolveMatchViaAI(unit, candidates, log);

  test('accepts a listed, same-edition, high-confidence candidate', async () => {
    generateText.mockResolvedValue(reply({ match: 2, sameEdition: true, confidence: 'high' }));
    const result = await resolve();
    expect(result).toMatchObject({ matched: candidates[1], index: 1, distinct: false, reason: expect.any(String) });
    const { prompt, maxRetries } = generateText.mock.calls[0][0];
    expect(maxRetries).toBe(0);
    for (const text of ['1. folder="Dune Messiah"', '2. folder="Dune"', 'Formats: audiobook', 'formats=ebook (EPUB)',
      '"Dune: Deluxe Edition"', 'Language: "en"', 'asin:B00B7NPRY8', '"match"', '"sameEdition"', '"confidence"']) expect(prompt).toContain(text);
  });

  test.each([
    ['medium-confidence null match', '{"match":null,"sameEdition":false,"confidence":"medium"}'],
    ['low-confidence null match', '{"match":null,"confidence":"low"}'],
    ['medium confidence', '{"match":2,"sameEdition":true,"confidence":"medium"}'],
    ['low confidence', '{"match":2,"sameEdition":true,"confidence":"low"}'],
    ['different edition', '{"match":2,"sameEdition":false,"confidence":"high"}'],
    ['out-of-range index', '{"match":3,"sameEdition":true,"confidence":"high"}'],
    ['zero index', '{"match":0,"sameEdition":true,"confidence":"high"}'],
    ['fractional index', '{"match":1.5,"sameEdition":true,"confidence":"high"}'],
    ['string index', '{"match":"2","sameEdition":true,"confidence":"high"}'],
    ['unknown confidence', '{"match":2,"sameEdition":true,"confidence":"certain"}'],
    ['missing match', '{"sameEdition":true,"confidence":"high"}'],
    ['invalid JSON', 'secret-sentinel not JSON'],
    ['empty text', undefined]
  ])('%s yields no match without retry', async (_, text) => {
    generateText.mockResolvedValue({ text, finishReason: 'stop' });
    expect(await resolve()).toEqual({ matched: null, index: null, distinct: false, reason: expect.any(String) });
    expect(generateText).toHaveBeenCalledOnce();
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls])).not.toContain('secret-sentinel');
  });

  test('refusal yields no match without retry even with an accepting body', async () => {
    generateText.mockResolvedValue({ ...reply({ match: 2, sameEdition: true, confidence: 'high' }), finishReason: 'content-filter' });
    expect(await resolve()).toEqual({ matched: null, index: null, distinct: false, reason: 'AI refused' });
    expect(generateText).toHaveBeenCalledOnce();
  });

  test('unusable config yields no match and zero requests', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    expect(await resolve()).toEqual({ matched: null, index: null, distinct: false, reason: 'AI unavailable' });
    expect(generateText).not.toHaveBeenCalled();
  });

  test('no candidates yields no match and zero requests', async () => {
    expect(await resolveMatchViaAI(unit, [], log)).toMatchObject({ matched: null, distinct: false });
    expect(generateText).not.toHaveBeenCalled();
  });

  test.each([
    ['with sameEdition', '{"match":null,"sameEdition":false,"confidence":"high"}'],
    ['without sameEdition', '{"match":null,"confidence":"high"}']
  ])('high-confidence null match %s is distinct (new book)', async (_, text) => {
    generateText.mockResolvedValue({ text, finishReason: 'stop' });
    const sequel = { displayName: 'Dune Messiah.m4b', formats: ['audio'], metadata: { title: 'Dune Messiah', author: 'Frank Herbert' } };
    expect(await resolveMatchViaAI(sequel, [candidates[1]], log)).toEqual({ matched: null, index: null, distinct: true, reason: expect.any(String) });
    expect(generateText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0][0].prompt).toContain('A sequel, prequel, or other book in the same series is a different work');
  });

  test('medium-confidence null match is not distinct (ambiguous)', async () => {
    generateText.mockResolvedValue(reply({ match: null, sameEdition: false, confidence: 'medium' }));
    expect(await resolve()).toEqual({ matched: null, index: null, distinct: false, reason: expect.any(String) });
  });

  test('a high-confidence different-edition match is not distinct', async () => {
    generateText.mockResolvedValue(reply({ match: 2, sameEdition: false, confidence: 'high' }));
    expect(await resolve()).toMatchObject({ matched: null, distinct: false });
  });

  test('lists at most five candidates and rejects a sixth', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ folder: `Book ${i + 1}`, title: `Book ${i + 1}`, author: 'A', formats: ['epub'] }));
    generateText.mockResolvedValue(reply({ match: 6, sameEdition: true, confidence: 'high' }));
    expect((await resolveMatchViaAI(unit, many, log)).matched).toBeNull();
    const { prompt } = generateText.mock.calls[0][0];
    expect(prompt).toContain('5. folder="Book 5"');
    expect(prompt).not.toContain('Book 6');
  });

  test('timeouts use 15-second deadlines and three attempts, then no match', async () => {
    generateText.mockImplementation(() => new Promise(() => {}));
    const result = resolve();
    await vi.advanceTimersByTimeAsync(14999);
    expect(generateText.mock.calls[0][0].abortSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(36001);
    expect(await result).toMatchObject({ matched: null, reason: expect.stringContaining('timeout') });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  test('transient failures retry and can still match', async () => {
    generateText.mockRejectedValueOnce(apiError(503)).mockResolvedValue(reply({ match: 1, sameEdition: true, confidence: 'high' }));
    const result = resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).matched).toBe(candidates[0]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  test('attempts count toward the shared 45-per-minute budget', async () => {
    const { resolveAIConfig } = await import('../src/config.js');
    await Promise.all(Array.from({ length: 44 }, () => reserveAttempt(resolveAIConfig())));
    generateText.mockResolvedValue(reply({ match: 2, sameEdition: true, confidence: 'high' }));
    expect((await resolve()).matched).toBe(candidates[1]);
    // The match request took the 45th slot, so normalization waits for the window.
    generateText.mockResolvedValue(valid);
    const normalized = normalize();
    await vi.advanceTimersByTimeAsync(59999);
    expect(generateText).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await normalized).toEqual({ author: 'Author', title: 'Title' });
  });
});
