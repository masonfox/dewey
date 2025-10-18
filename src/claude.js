import axios from 'axios';
import path from 'node:path';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL, ANTHROPIC_API_URL } from './config.js';
import { ClaudeError, RetryableError } from './errors.js';

// Rate limiting for Claude API
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 45; // Leave some buffer under the 50/min limit

// Helper function to get cleaned API key
function getCleanApiKey() {
  // Trim and remove surrounding quotes if provided like '"sk-..."'
  return ANTHROPIC_API_KEY().trim().replace(/^['"]|['"]$/g, '');
}

function checkRateLimit(apiKey) {
  const now = Date.now();
  const key = apiKey.slice(0, 10); // Use partial key for rate limiting
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, []);
  }
  
  const requests = rateLimitMap.get(key);
  
  // Remove old requests outside the window
  const cutoff = now - RATE_LIMIT_WINDOW;
  const recentRequests = requests.filter(timestamp => timestamp > cutoff);
  rateLimitMap.set(key, recentRequests);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldestRequest = Math.min(...recentRequests);
    const waitTime = (oldestRequest + RATE_LIMIT_WINDOW) - now;
    return waitTime;
  }
  
  // Add current request
  recentRequests.push(now);
  return 0;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function normalizeViaClaude(name, fallbackAuthor, fallbackTitle, log, parentDir = null) {
  const API_KEY = getCleanApiKey();
  if (!API_KEY) {
    log.warn('⚠️  Claude API key not set; using heuristics.');
    return null;
  }
  
  const prompt = `You are an expert audiobook librarian helping organize a digital library. Extract author and title from the filename/path below.

CONTEXT: This is for the Dewey audiobook organizer that creates "[Author]/[Book Title]" directory structures. The file may be from a series, multi-part book, or have complex naming patterns.

GUIDELINES:
- Author should be the primary author's full name (e.g., "Stephen King", not "King, Stephen")
- Title should be the main book title without series info, part numbers, or file extensions
- For series: Include series name if it's part of the main title (e.g., "The Fellowship of the Ring" not just "Fellowship")
- Remove technical prefixes like [M4B], [MP3], quality indicators, narrator names in parentheses
- For multi-part files: Use the main title, ignore part numbers (001, 002, etc.)
- Handle common patterns: "Author - Title", "Title by Author", "Series Book# - Title"
- If uncertain, prefer keeping full descriptive titles over truncating

INPUT: ${name}
${parentDir ? `PARENT_DIR: ${path.basename(parentDir)}` : ''}

Return ONLY valid JSON: { "author": "Full Author Name", "title": "Clean Book Title" }`;
  
  // Check rate limit before making request
  const waitTime = checkRateLimit(API_KEY);
  if (waitTime > 0) {
    log.info(`⏳ Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s before Claude request...`);
    await sleep(waitTime);
  }
  
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post(`${ANTHROPIC_API_URL()}/v1/messages`, {
        model: CLAUDE_MODEL(),
        max_tokens: 1024,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 15000
      });
      const text = data?.content?.[0]?.text || '';
      const parsed = JSON.parse(text);
      if (!parsed?.author || !parsed?.title) throw new Error('missing fields');
      log.info(`🤖 Claude normalization successful: "${parsed.author}" - "${parsed.title}"`);
      return parsed;
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;

      // Handle rate limiting with exponential backoff
      if (status === 429 && attempt < maxRetries) {
        const backoffTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        log.warn(`⏳ Claude rate limited (${status}), retrying in ${backoffTime / 1000}s (attempt ${attempt}/${maxRetries})`);
        await sleep(backoffTime);
        continue;
      }

      // Handle other retryable errors
      if ((status >= 500 || status === 408) && attempt < maxRetries) {
        const backoffTime = attempt * 2000; // 2s, 4s, 6s
        log.warn(`🔄 Claude server error (${status}), retrying in ${backoffTime / 1000}s (attempt ${attempt}/${maxRetries})`);
        await sleep(backoffTime);
        continue;
      }

      // Final attempt failed - gracefully degrade to heuristics
      // We don't throw errors here; Claude is optional
      log.warn(`⚠️  Claude normalization failed (${status}): ${err?.message || 'Unknown error'} - using heuristics`);
      return null;
    }
  }
  
  return null;
}

export async function validateClaude(log) {
  const API_KEY = getCleanApiKey();
  if (!API_KEY) {
    log.warn('⚠️  Claude API key not set; using heuristics');
    return false;
  }
  try {
    const { data, status } = await axios.post(`${ANTHROPIC_API_URL()}/v1/messages`, {
      model: CLAUDE_MODEL(),
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: 'Return JSON {"ok": true} only.' }]
    }, {
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 10000,
      validateStatus: () => true
    });
    if (status >= 200 && status < 300) {
      log.info(`🤖 Claude API validation successful (${CLAUDE_MODEL()}) ✅`);
      return true;
    }
    const errText = data?.error?.message || data?.error || data || 'unknown error';
    log.warn(`⚠️  Claude API validation failed (${status}): ${errText}. Using heuristics instead.`);
    return false;
  } catch (err) {
    const status = err?.response?.status;
    log.warn(`⚠️  Claude API validation exception (${status}): ${err?.message || 'Unknown error'}. Using heuristics instead.`);
    return false;
  }
}


