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
  // A retryable SDK error with a 2xx status is a broken response body, not an HTTP failure.
  const network = APICallError.isInstance(error) ? error.isRetryable && (!status || (status >= 200 && status < 300))
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

function parseJSON(text) {
  if (typeof text !== 'string') throw new Error('Invalid response text');
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
}

export function parseMetadata(text) {
  const parsed = parseJSON(text);
  if (typeof parsed?.author !== 'string' || !parsed.author.trim() ||
      typeof parsed?.title !== 'string' || !parsed.title.trim()) throw new Error('Invalid metadata');
  return { author: parsed.author.trim(), title: parsed.title.trim() };
}

/** @param {string[]|null} [formats] unit formats ('audio'|'epub'); omitted keeps the audio prompt. */
export async function normalizeViaAI(name, fallbackAuthor, fallbackTitle, log, parentDir = null, fileMetadata = null, formats = null) {
  const config = resolveAIConfig();
  if (!config.usable) {
    log.warn(`AI ${label(config)}: ${config.keyVariable} not set; using heuristics`);
    return null;
  }
  const prompt = buildPrompt(name, parentDir, fileMetadata, formats);
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

/**
 * Parses a match response; returns { index, distinct, reason } with index set only when accepted and
 * distinct only for a high-confidence null. `match` is the 1-based number shown in the prompt.
 */
export function parseMatch(text, count) {
  const parsed = parseJSON(text);
  if (!parsed || typeof parsed !== 'object' || !('match' in parsed) ||
      (parsed.match !== null && !Number.isInteger(parsed.match)) ||
      // sameEdition is irrelevant when no candidate is named.
      (parsed.match !== null && typeof parsed.sameEdition !== 'boolean') ||
      !['high', 'medium', 'low'].includes(parsed.confidence)) throw new Error('Invalid match');
  if (parsed.match === null) {
    return parsed.confidence === 'high'
      ? { index: null, distinct: true, reason: 'AI ruled out every candidate with high confidence' }
      : { index: null, reason: `AI found no matching candidate (confidence ${parsed.confidence})` };
  }
  if (parsed.match < 1 || parsed.match > count) return { index: null, reason: 'AI named an unlisted candidate' };
  if (!parsed.sameEdition) return { index: null, reason: 'AI reported a different edition' };
  if (parsed.confidence !== 'high') return { index: null, reason: `AI confidence ${parsed.confidence}` };
  return { index: parsed.match - 1, reason: 'AI confirmed same edition with high confidence' };
}

/**
 * Asks the configured provider whether a unit is one of at most five library candidates (D5).
 * @param {{ displayName: string, formats: string[], metadata: { title?: string, author?: string,
 *   language?: string, identifiers?: Set<string>|string[]|Object<string, string|string[]> } }} unit
 * @param {Array<{ folder: string, title?: string, author?: string, language?: string, formats?: string[] }>} candidates
 * @returns {Promise<{ matched: object|null, index: number|null, distinct: boolean, reason: string }>}
 *   index is into `candidates`; distinct is true only when AI stated with high confidence that no
 *   candidate is the same work (new book). No match with distinct false means ambiguous.
 */
export async function resolveMatchViaAI(unit, candidates, log) {
  const none = (reason, distinct = false) => ({ matched: null, index: null, distinct, reason });
  const listed = (candidates || []).slice(0, 5);
  if (!listed.length) return none('no candidates');
  const config = resolveAIConfig();
  if (!config.usable) {
    log.warn(`AI ${label(config)}: ${config.keyVariable} not set; match left ambiguous`);
    return none('AI unavailable');
  }
  const prompt = buildMatchPrompt(unit, listed);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await reserveAttempt(config);
    try {
      const result = await request(config, prompt, 15000, 256);
      if (refused(result)) {
        log.warn(`AI ${label(config)} refused match resolution; match left ambiguous`);
        return none('AI refused');
      }
      const { index, distinct, reason } = parseMatch(result.text, listed.length);
      log.info(`AI ${label(config)} match resolution: ${reason}`);
      return index === null ? none(reason, Boolean(distinct)) : { matched: listed[index], index, distinct: false, reason };
    } catch (error) {
      const { retryable, category } = failure(error);
      log.warn(`AI ${label(config)} match resolution failed (${category}); ${retryable && attempt < 3 ? 'retrying' : 'match left ambiguous'}`);
      if (!retryable || attempt === 3) return none(`AI request failed (${category})`);
      await sleep(attempt * 2000);
    }
  }
  return none('AI request failed');
}

function describeIdentifiers(identifiers) {
  if (!identifiers) return '';
  const values = identifiers instanceof Set || Array.isArray(identifiers) ? [...identifiers]
    : Object.entries(identifiers).flatMap(([kind, value]) => [].concat(value ?? []).map(id => `${kind}:${id}`));
  return values.map(String).join(', ');
}

export function buildMatchPrompt(unit, candidates) {
  const quote = value => JSON.stringify(value ?? 'unknown');
  const metadata = unit.metadata || {};
  const identifiers = describeIdentifiers(metadata.identifiers);
  const list = candidates.map((candidate, i) => `${i + 1}. folder=${quote(candidate.folder)} title=${quote(candidate.title)} ` +
    `author=${quote(candidate.author)} language=${quote(candidate.language)} formats=${describeFormats(candidate.formats)}`).join('\n');

  return `You are an expert book librarian deciding whether an incoming item belongs to a book already in the library. Audiobook and ebook editions of the same work belong together; abridged versus unabridged versions, different languages, and different works do not.

INCOMING ITEM:
- Name: ${quote(unit.displayName)}
- Formats: ${describeFormats(unit.formats)}
- Title: ${quote(metadata.title)}
- Author: ${quote(metadata.author)}
- Language: ${quote(metadata.language)}
${identifiers ? `- Identifiers: ${identifiers}\n` : ''}
LIBRARY CANDIDATES:
${list}

Answer with the number of the candidate that is the same work and an edition-compatible version, or null if none is. Set "sameEdition" to false when the versions differ (abridgement, language, translation). A sequel, prequel, or other book in the same series is a different work: answer null. Use "high" confidence only when you are certain, whether you name a candidate or answer null because none is the same work.

Return ONLY valid JSON: { "match": <candidate number or null>, "sameEdition": true|false, "confidence": "high"|"medium"|"low" }`;
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
    log.info(`🤖 AI ${label(config)} validation successful`);
    return true;
  } catch (error) {
    log.warn(`AI ${label(config)} startup validation failed (${failure(error).category}); using heuristics`);
    return false;
  }
}

const FORMAT_LABELS = { audio: 'audiobook', epub: 'ebook (EPUB)' };

function describeFormats(formats) {
  const labels = [...new Set((formats || []).map(format => FORMAT_LABELS[format] || String(format)))];
  return labels.length ? labels.join(', ') : 'unknown';
}

/**
 * @param {object|null} fileMetadata audio tags or EPUB OPF metadata; `source: 'epub'|'audio'` labels it,
 *   otherwise an epub-only unit is assumed to carry OPF metadata.
 * @param {string[]|null} [formats] unit formats ('audio'|'epub'); omitted keeps the audio prompt.
 */
export function buildPrompt(name, parentDir, fileMetadata, formats = null) {
  const opf = fileMetadata?.source ? fileMetadata.source === 'epub'
    : Boolean(formats?.includes('epub') && !formats.includes('audio'));
  const hasMetadata = fileMetadata?.hasMetadata ?? Boolean(fileMetadata?.title || fileMetadata?.author);

  // Build metadata section if available
  let metadataSection = '';
  if (hasMetadata) {
    metadataSection = `\nEMBEDDED METADATA (${opf ? 'from the EPUB OPF package' : 'from audio file tags'}):\n`;
    if (fileMetadata.title) metadataSection += `- Title: "${fileMetadata.title}"\n`;
    if (fileMetadata.author) metadataSection += `- Author: "${fileMetadata.author}"\n`;
    if (fileMetadata.language) metadataSection += `- Language: "${fileMetadata.language}"\n`;
    if (fileMetadata.year) metadataSection += `- Year: "${fileMetadata.year}"\n`;
    if (fileMetadata.genre) metadataSection += `- Genre: "${fileMetadata.genre}"\n`;
    metadataSection += opf
      ? '\nThe embedded metadata above is extracted from the ebook\'s OPF package and is authoritative.\nUse it as the primary source for author and title. The language provides additional\ncontext for disambiguation.\n'
      : '\nThe embedded metadata above is extracted from the audio file\'s tags and is authoritative.\nUse it as the primary source for author and title. The year and genre provide additional\ncontext for disambiguation.\n';
  }

  const prompt = `You are an expert book librarian helping organize a digital library of audiobooks and ebooks. Extract author and title from the filename/path below.

CONTEXT: This is for the Dewey book organizer that creates "[Author]/[Book Title]" directory structures. The file may be from a series, multi-part book, or have complex naming patterns.
${formats?.length ? `FORMATS: ${describeFormats(formats)}\n` : ''}${metadataSection}
GUIDELINES:
- Author should be the primary author's full name (e.g., "Stephen King", not "King, Stephen")
- Title should be the main book title without series info, part numbers, or file extensions
- For series: Include series name if it's part of the main title (e.g., "The Fellowship of the Ring" not just "Fellowship")
- Remove technical prefixes like [M4B], [MP3], [EPUB], quality indicators, narrator names in parentheses
- For multi-part files: Use the main title, ignore part numbers (001, 002, etc.)
- Handle common patterns: "Author - Title", "Title by Author", "Series Book# - Title"
- If uncertain, prefer keeping full descriptive titles over truncating
${hasMetadata ? '- Clean up the author name (format as "First Last"), normalize the title (proper capitalization, remove technical artifacts)' : ''}

FILENAME: ${name}
${parentDir ? `PARENT_DIR: ${path.basename(parentDir)}` : ''}

Return ONLY valid JSON: { "author": "Full Author Name", "title": "Clean Book Title" }`;

  return prompt;
}
