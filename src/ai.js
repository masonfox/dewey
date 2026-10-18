import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateText, APICallError } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { resolveAIConfig } from './config.js';

export function createModel(config) {
  const options = { apiKey: config.apiKey, baseURL: config.baseURL };
  switch (config.provider) {
    case 'anthropic': return createAnthropic({ ...options, authToken: '' })(config.model);
    case 'openai': return createOpenAI(options).chat(config.model);
    case 'google': return createGoogleGenerativeAI(options)(config.model);
    case 'openai-compatible': return createOpenAICompatible({ ...options, name: 'dewey-compatible' }).chatModel(config.model);
    default: throw new Error('Unsupported AI provider');
  }
}

const attempts = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reservation is synchronous between awaits; concurrent waiters recheck capacity.
export async function reserveAttempt(config) {
  const identity = createHash('sha256').update(JSON.stringify([
    config.provider, config.baseURL, config.apiKey
  ])).digest('hex');
  for (;;) {
    const now = Date.now();
    const recent = (attempts.get(identity) || []).filter(time => time > now - 60000);
    attempts.set(identity, recent);
    if (recent.length < 45) {
      recent.push(now);
      return;
    }
    await sleep(recent[0] + 60000 - now);
  }
}

function label(config) {
  let model = config.model.replace(/https?:\/\/\S+/g, '[URL]');
  if (config.apiKey) model = model.split(config.apiKey).join('[redacted]');
  return `${config.provider} model=${model.replace(/[\r\n]/g, ' ')}`;
}

function failure(error) {
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
  const network = APICallError.isInstance(error) ? error.isRetryable && !status
    : error instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code);
  return { retryable: timeout || network || status === 408 || status === 429 || (status >= 500 && status < 600),
    category: status ? `HTTP ${status}` : timeout ? 'timeout' : network ? 'network' : 'provider/content failure' };
}

function refused(result) {
  // Chat-compatible servers can signal refusal separately from finish_reason.
  // Inspect only the flag; never display the response body.
  const body = result.response?.body;
  return result.finishReason === 'content-filter' ||
    result.providerMetadata?.anthropic?.stopReason === 'refusal' ||
    body?.stop_reason === 'refusal' ||
    Boolean(body?.choices?.[0]?.message?.refusal);
}

async function request(config, prompt, deadline, maxOutputTokens) {
  const controller = new AbortController();
  let timer;
  // Race bounds transports which fail to honor AbortSignal, too.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException('AI deadline exceeded', 'TimeoutError'));
    }, deadline);
  });
  try {
    return await Promise.race([generateText({ model: createModel(config), prompt,
      maxOutputTokens, maxRetries: 0, abortSignal: controller.signal,
      include: { responseBody: true } }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function parseMetadata(text) {
  if (typeof text !== 'string') throw new Error('Invalid metadata text');
  const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
  if (typeof parsed?.author !== 'string' || !parsed.author.trim() ||
      typeof parsed?.title !== 'string' || !parsed.title.trim()) throw new Error('Invalid metadata');
  return { author: parsed.author.trim(), title: parsed.title.trim() };
}

export async function normalizeViaAI(name, fallbackAuthor, fallbackTitle, log, parentDir = null, fileMetadata = null) {
  const config = resolveAIConfig();
  if (!config.usable) {
    log.warn(`AI ${label(config)}: ${config.keyVariable} not set; using heuristics`);
    return null;
  }
  const prompt = buildPrompt(name, parentDir, fileMetadata);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await reserveAttempt(config);
    try {
      const result = await request(config, prompt, 15000, 1024);
      if (refused(result)) {
        log.warn(`AI ${label(config)} refused; using heuristics`);
        return null;
      }
      const metadata = parseMetadata(result.text);
      log.info(`AI ${label(config)} normalization successful`);
      return metadata;
    } catch (error) {
      const { retryable, category } = failure(error);
      log.warn(`AI ${label(config)} normalization failed (${category}); ${retryable && attempt < 3 ? 'retrying' : 'using heuristics'}`);
      if (!retryable || attempt === 3) return null;
      await sleep(attempt * 2000);
    }
  }
  return null;
}

export async function validateAI(log) {
  const config = resolveAIConfig();
  if (!config.usable) {
    log.warn(`AI ${label(config)}: ${config.keyVariable} not set; using heuristics`);
    return false;
  }
  try {
    const result = await request(config, 'Return JSON {"ok": true} only.', 10000, 16);
    if (refused(result) || !result.text?.trim()) throw new Error('No probe text');
    log.info(`AI ${label(config)} validation successful`);
    return true;
  } catch (error) {
    log.warn(`AI ${label(config)} startup validation failed (${failure(error).category}); using heuristics`);
    return false;
  }
}

export function buildPrompt(name, parentDir, fileMetadata) {
  // Build metadata section if available
  let metadataSection = '';
  if (fileMetadata?.hasMetadata) {
    metadataSection = '\nEMBEDDED METADATA (from audio file tags):\n';
    if (fileMetadata.title) metadataSection += `- Title: "${fileMetadata.title}"\n`;
    if (fileMetadata.author) metadataSection += `- Author: "${fileMetadata.author}"\n`;
    if (fileMetadata.year) metadataSection += `- Year: "${fileMetadata.year}"\n`;
    if (fileMetadata.genre) metadataSection += `- Genre: "${fileMetadata.genre}"\n`;
    metadataSection += '\nThe embedded metadata above is extracted from the audio file\'s tags and is authoritative.\nUse it as the primary source for author and title. The year and genre provide additional\ncontext for disambiguation.\n';
  }

  const prompt = `You are an expert audiobook librarian helping organize a digital library. Extract author and title from the filename/path below.

CONTEXT: This is for the Dewey audiobook organizer that creates "[Author]/[Book Title]" directory structures. The file may be from a series, multi-part book, or have complex naming patterns.
${metadataSection}
GUIDELINES:
- Author should be the primary author's full name (e.g., "Stephen King", not "King, Stephen")
- Title should be the main book title without series info, part numbers, or file extensions
- For series: Include series name if it's part of the main title (e.g., "The Fellowship of the Ring" not just "Fellowship")
- Remove technical prefixes like [M4B], [MP3], quality indicators, narrator names in parentheses
- For multi-part files: Use the main title, ignore part numbers (001, 002, etc.)
- Handle common patterns: "Author - Title", "Title by Author", "Series Book# - Title"
- If uncertain, prefer keeping full descriptive titles over truncating
${fileMetadata?.hasMetadata ? '- Clean up the author name (format as "First Last"), normalize the title (proper capitalization, remove technical artifacts)' : ''}

FILENAME: ${name}
${parentDir ? `PARENT_DIR: ${path.basename(parentDir)}` : ''}

Return ONLY valid JSON: { "author": "Full Author Name", "title": "Clean Book Title" }`;

  return prompt;
}
