/**
 * Cross-format matching (D4). Pure key helpers come first; candidate search
 * and resolution build on them. Matching never imports layout.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DEST_DIR } from './config.js';
import { isSupportedBook, bookFileKind, sanitizeSegment } from './utils.js';
import { extractEpubMetadata, extractAudioMetadata } from './metadata.js';
import { resolveMatchViaAI } from './ai.js';

/** Format/edition noise dropped from title keys when bracketed, leading, or trailing. */
export const TITLE_NOISE_WORDS = [
  'unabridged', 'abridged', 'audiobook', 'audiobooks', 'ebook', 'epub',
  'm4b', 'm4a', 'mp3', 'retail', 'audible', 'readaloud'
];

const LEADING_ARTICLES = ['the', 'a', 'an'];

// Surname particles that make a multi-word "Last" in "Last, First"
const SURNAME_PARTICLES = ['le', 'la', 'de', 'du', 'des', 'da', 'di', 'del', 'della', 'van', 'von', 'der', 'den', 'st', 'saint', 'mac', 'mc', 'o'];

const NOISE = new Set(TITLE_NOISE_WORDS);

/** Words with case, diacritics, punctuation, and whitespace folded. */
function words(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** "Last, First" -> "First Last" when the left side looks like a surname. */
function reorderName(name) {
  const parts = name.split(',').map(p => p.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return name;
  const last = words(parts[0]);
  if (last.length === 1 || (last.length > 1 && SURNAME_PARTICLES.includes(last[0]))) {
    return `${parts[1]} ${parts[0]}`;
  }
  return name;
}

/** Normalized author key; multiple authors split on '&', 'and', or ';'. */
export function authorKey(author) {
  return (author || '')
    .split(/\s*(?:&|;|\band\b)\s*/i)
    .flatMap(name => words(reorderName(name)))
    .join(' ');
}

/** Normalized title key: folded, leading article and format noise dropped. */
export function titleKey(title) {
  const unbracketed = (title || '').replace(/[[(]([^\])]*)[\])]/g, (group, inner) => {
    const w = words(inner);
    return w.every(x => NOISE.has(x)) ? ' ' : ` ${inner} `;
  });
  const w = words(unbracketed);
  while (w.length > 1 && NOISE.has(w[0])) w.shift();
  while (w.length > 1 && NOISE.has(w.at(-1))) w.pop();
  if (w.length > 1 && LEADING_ARTICLES.includes(w[0])) w.shift();
  return w.join(' ');
}

/** True when a name marks an abridged edition ("Unabridged" is not abridged). */
export function isAbridged(name) {
  return words(name).includes('abridged');
}

export function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Near (not equal) title keys: one is a word-boundary prefix of the other,
 * or Levenshtein <= 2 with both keys >= 6 characters.
 */
export function isNearTitleKey(a, b) {
  if (!a || !b || a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.startsWith(short + ' ')) return true;
  return short.length >= 6 && levenshtein(a, b) <= 2;
}

/** Near match between two { author, title } records: same author key, near title keys. */
export function isNearMatch(a, b) {
  const author = authorKey(a.author);
  return Boolean(author) && author === authorKey(b.author) && isNearTitleKey(titleKey(a.title), titleKey(b.title));
}

// ---------------------------------------------------------------------------
// Candidate search (D4)

/**
 * @typedef {Object} MatchUnit
 * @property {string} author - Resolved author (after AI/heuristic normalization)
 * @property {string} title - Resolved title
 * @property {string} [displayName] - Source file or folder name
 * @property {string[]} [formats] - 'audio'|'epub'; derived from `files` when omitted
 * @property {Array<{ path: string, kind: 'audio'|'epub', readaloud?: boolean, metadata?: Object|null }>} [files]
 * @property {{ title?: string, author?: string, language?: string|null,
 *   identifiers?: import('./metadata.js').BookIdentifier[] }|null} [metadata] - extractUnitMetadata result
 */

/**
 * @typedef {Object} MatchCandidate
 * @property {string} folder - `Author/Title` relative to DEST_DIR
 * @property {string} path - Absolute book folder path
 * @property {string} author - Library author folder name (kept on placement)
 * @property {string} title - Library book folder name (kept on placement)
 * @property {Array<{ path: string, name: string, kind: 'audio'|'epub' }>} files - Direct supported files
 * @property {string[]} formats
 * @property {'equal'|'near'|'unrelated'} relation - Title relation to the unit
 * @property {boolean} detailed - Details below were loaded (equal/near only)
 * @property {import('./metadata.js').BookIdentifier[]} identifiers - ISBN/ASIN from EPUB OPFs and one audio file
 * @property {string[]} editionIsbns - ISBNs of non-read-aloud EPUBs
 * @property {string|null} language - First known language (normalized)
 * @property {string[]} languages - Every known language (normalized)
 * @property {boolean} abridged - Abridged marker in folder, file names, or embedded titles
 */

// Common ISO 639-2 codes and English names seen in audio tags, folded to ISO 639-1
const LANGUAGE_ALIASES = {
  eng: 'en', english: 'en', deu: 'de', ger: 'de', german: 'de', fra: 'fr', fre: 'fr', french: 'fr',
  spa: 'es', spanish: 'es', ita: 'it', italian: 'it', nld: 'nl', dut: 'nl', dutch: 'nl',
  por: 'pt', portuguese: 'pt', rus: 'ru', russian: 'ru', jpn: 'ja', japanese: 'ja',
  zho: 'zh', chi: 'zh', chinese: 'zh', pol: 'pl', polish: 'pl', swe: 'sv', swedish: 'sv'
};

/** Primary language subtag, lower case; null when unknown */
export function languageKey(language) {
  const primary = String(language || '').trim().toLowerCase().split(/[-_\s]/)[0];
  if (!primary || primary === 'und' || primary === 'unknown') return null;
  return LANGUAGE_ALIASES[primary] || primary;
}

/** Keys of a name as given and as sanitizeSegment wrote it into the library */
function keyVariants(value, keyFn) {
  if (!value) return [];
  return [...new Set([keyFn(value), keyFn(sanitizeSegment(value))])].filter(Boolean);
}

function titleRelation(unitTitleKeys, folderTitle) {
  const key = titleKey(folderTitle);
  if (!key) return 'unrelated';
  if (unitTitleKeys.includes(key)) return 'equal';
  return unitTitleKeys.some(k => isNearTitleKey(k, key)) ? 'near' : 'unrelated';
}

async function readDirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function readBookFiles(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.name.startsWith('.') && isSupportedBook(entry.name))
      .map(entry => ({ path: path.join(dir, entry.name), name: entry.name, kind: bookFileKind(entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function idKey(id) {
  return `${id.type}:${id.value}`;
}

/** ISBN/ASIN identifiers only; 'other' identifiers (UUIDs etc.) never match across files */
function matchableIds(ids) {
  return (ids || []).filter(id => id && (id.type === 'isbn' || id.type === 'asin'));
}

function audioIds(metadata) {
  const ids = [];
  if (metadata?.isbn) ids.push({ type: 'isbn', value: metadata.isbn, scheme: 'isbn' });
  if (metadata?.asin) ids.push({ type: 'asin', value: metadata.asin, scheme: 'asin' });
  return ids;
}

/** Read OPF metadata of every EPUB and tags of one audio file (.m4b first) in a candidate */
async function loadCandidateDetails(candidate, log) {
  const identifiers = [];
  const editionIsbns = [];
  const languages = [];
  let abridged = isAbridged(candidate.title) || candidate.files.some(f => isAbridged(f.name));
  const add = (ids) => {
    for (const id of matchableIds(ids)) {
      if (!identifiers.some(i => idKey(i) === idKey(id))) identifiers.push(id);
    }
  };
  const addLanguage = (language) => {
    const key = languageKey(language);
    if (key && !languages.includes(key)) languages.push(key);
  };

  for (const file of candidate.files.filter(f => f.kind === 'epub')) {
    const metadata = await extractEpubMetadata(file.path, log);
    if (!metadata) continue;
    add(metadata.identifiers);
    if (!metadata.readaloud) {
      for (const id of matchableIds(metadata.identifiers)) {
        if (id.type === 'isbn' && !editionIsbns.includes(id.value)) editionIsbns.push(id.value);
      }
    }
    addLanguage(metadata.language);
    abridged ||= isAbridged(metadata.title);
  }

  const audio = candidate.files.filter(f => f.kind === 'audio');
  const probe = audio.find(f => /\.m4b$/i.test(f.name)) || audio[0];
  if (probe) {
    const metadata = await extractAudioMetadata(probe.path, log);
    add(audioIds(metadata));
    addLanguage(metadata?.language);
    abridged ||= isAbridged(metadata?.title);
  }

  Object.assign(candidate, {
    detailed: true, identifiers, editionIsbns, languages, language: languages[0] || null, abridged
  });
}

/**
 * List library book folders that could hold the unit's book (D4). DEST_DIR is read fresh on every
 * call, so earlier placements and books added by other tools are visible. Author folders are kept
 * when their author key equals the unit's (as given or as sanitizeSegment wrote it), then book
 * folders with at least one direct supported file. Details (identifiers, language, abridged
 * markers) are loaded only for candidates whose title is equal or near.
 * @param {MatchUnit} unit
 * @param {Object} log - Logger instance
 * @returns {Promise<MatchCandidate[]>} Every same-author book folder, sorted by folder
 */
export async function findCandidates(unit, log) {
  const authorKeys = keyVariants(unit.author, authorKey);
  const unitTitleKeys = keyVariants(unit.title, titleKey);
  if (!authorKeys.length) return [];

  const destRoot = DEST_DIR();
  const candidates = [];
  for (const authorFolder of await readDirs(destRoot)) {
    if (!authorKeys.includes(authorKey(authorFolder))) continue;
    const authorPath = path.join(destRoot, authorFolder);
    for (const titleFolder of await readDirs(authorPath)) {
      const bookPath = path.join(authorPath, titleFolder);
      const files = await readBookFiles(bookPath);
      if (!files.length) continue;
      candidates.push({
        folder: `${authorFolder}/${titleFolder}`,
        path: bookPath,
        author: authorFolder,
        title: titleFolder,
        files,
        formats: [...new Set(files.map(f => f.kind))],
        relation: titleRelation(unitTitleKeys, titleFolder),
        detailed: false,
        identifiers: [],
        editionIsbns: [],
        language: null,
        languages: [],
        abridged: isAbridged(titleFolder)
      });
    }
  }

  for (const candidate of candidates) {
    if (candidate.relation !== 'unrelated') await loadCandidateDetails(candidate, log);
  }
  log.debug(`🔎 ${candidates.length} same-author library folder(s) for "${unit.title}" by ${unit.author}` +
    (candidates.length ? `: ${candidates.map(c => `${c.folder} [${c.relation}]`).join(', ')}` : ''));
  return candidates;
}

// ---------------------------------------------------------------------------
// Match resolution (D4/D5)

/**
 * @typedef {Object} MatchDecision
 * @property {'identifier'|'deterministic'|'ai'|'new'|'ambiguous'} outcome
 * @property {MatchCandidate|null} candidate - Book folder to place into (identifier/deterministic/ai)
 * @property {MatchCandidate[]} candidates - Candidates that decided or blocked the outcome
 * @property {string} signal - Deciding signal, e.g. 'isbn:9780441013593' or 'language de != en'
 * @property {string} reason - Human-readable explanation (no raw AI bodies)
 */

function unitFacts(unit) {
  const files = unit.files || [];
  const ids = [...matchableIds(unit.metadata?.identifiers)];
  const editionIsbns = [];
  for (const file of files) {
    const metadata = file.metadata;
    const fileIds = file.kind === 'epub' ? matchableIds(metadata?.identifiers) : audioIds(metadata);
    for (const id of fileIds) {
      if (!ids.some(i => idKey(i) === idKey(id))) ids.push(id);
    }
    if (file.kind === 'epub' && !(file.readaloud || metadata?.readaloud)) {
      for (const id of fileIds) {
        if (id.type === 'isbn' && !editionIsbns.includes(id.value)) editionIsbns.push(id.value);
      }
    }
  }
  const language = languageKey(unit.metadata?.language) ||
    files.map(f => languageKey(f.metadata?.language)).find(Boolean) || null;
  const names = [unit.title, unit.displayName, unit.metadata?.title,
    ...files.map(f => path.basename(f.path)), ...files.map(f => f.metadata?.title)];
  return {
    ids,
    editionIsbns,
    language,
    abridged: names.some(name => name && isAbridged(name)),
    formats: unit.formats || [...new Set(files.map(f => f.kind).filter(Boolean))]
  };
}

/** Edition conflict that blocks placing the unit into a candidate; null when compatible */
function editionConflict(facts, candidate) {
  if (facts.editionIsbns.length && candidate.editionIsbns.length &&
      !facts.editionIsbns.some(isbn => candidate.editionIsbns.includes(isbn))) {
    return {
      signal: `EPUB isbn ${facts.editionIsbns.join('/')} != ${candidate.editionIsbns.join('/')}`,
      reason: 'a different ebook edition is already in the library book'
    };
  }
  if (facts.abridged !== candidate.abridged) {
    return {
      signal: `abridged ${facts.abridged ? 'unit' : 'library book'} vs unabridged ${facts.abridged ? 'library book' : 'unit'}`,
      reason: 'one side is abridged and the other is not'
    };
  }
  if (facts.language && candidate.languages.length && !candidate.languages.includes(facts.language)) {
    return {
      signal: `language ${facts.language} != ${candidate.languages.join('/')}`,
      reason: 'the languages differ'
    };
  }
  return null;
}

function titleDistance(unit, candidate) {
  const key = titleKey(candidate.title);
  return Math.min(...keyVariants(unit.title, titleKey).map(k => levenshtein(k, key)));
}

/** AI info lines drop to debug so the decision line stays the unit's single info line (5.6) */
function quietLog(log) {
  return {
    debug: (...args) => log.debug(...args),
    info: (...args) => log.debug(...args),
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args)
  };
}

async function decide(unit, candidates, log) {
  const facts = unitFacts(unit);
  const decision = (outcome, candidate, related, signal, reason) =>
    ({ outcome, candidate, candidates: related, signal, reason });

  // 1. Identifier: a shared ISBN/ASIN with exactly one candidate wins outright
  if (facts.ids.length) {
    const unitIds = facts.ids.map(idKey);
    const sharing = candidates
      .filter(c => c.detailed)
      .map(c => ({ c, shared: c.identifiers.map(idKey).filter(k => unitIds.includes(k)) }))
      .filter(x => x.shared.length);
    if (sharing.length === 1) {
      return decision('identifier', sharing[0].c, [sharing[0].c], sharing[0].shared[0], 'shared identifier');
    }
    if (sharing.length > 1) {
      return decision('ambiguous', null, sharing.map(x => x.c), `${sharing[0].shared[0]} in ${sharing.length} books`,
        'the same identifier is in more than one library book');
    }
  }

  // 2. Exact author/title keys
  const equal = candidates.filter(c => c.relation === 'equal');
  if (equal.length > 1) {
    return decision('ambiguous', null, equal, `${equal.length} equal candidates`, 'more than one library book matches equally');
  }
  if (equal.length === 1) {
    const conflict = editionConflict(facts, equal[0]);
    return conflict
      ? decision('ambiguous', null, equal, conflict.signal, conflict.reason)
      : decision('deterministic', equal[0], equal, 'equal author/title keys', 'normalized author and title keys are equal');
  }

  // 3. Near matches go to AI (at most five); nothing related means a new book
  const near = candidates.filter(c => c.relation === 'near')
    .sort((a, b) => titleDistance(unit, a) - titleDistance(unit, b) || a.folder.localeCompare(b.folder))
    .slice(0, 5);
  if (!near.length) {
    return decision('new', null, [], 'no equal or near candidate', 'no related book in the library');
  }

  const aiUnit = {
    displayName: unit.displayName || unit.title,
    formats: facts.formats,
    metadata: { title: unit.title, author: unit.author, language: facts.language, identifiers: facts.ids.map(idKey) }
  };
  const result = await resolveMatchViaAI(aiUnit, near, quietLog(log));
  if (result.matched) {
    const conflict = editionConflict(facts, result.matched);
    return conflict
      ? decision('ambiguous', null, [result.matched], conflict.signal, conflict.reason)
      : decision('ai', result.matched, near, 'AI confirmed near match', result.reason);
  }
  if (result.distinct) {
    return decision('new', null, near, 'AI ruled out near matches', result.reason);
  }
  return decision('ambiguous', null, near, 'near match unconfirmed by AI', result.reason);
}

const OUTCOME_LABELS = {
  identifier: 'identifier match', deterministic: 'deterministic match', ai: 'AI match', new: 'new book', ambiguous: 'ambiguous'
};

/**
 * Decide where a unit belongs (D4): identifier → exact keys → near match via AI → new book. The unit
 * is ambiguous when a decision is uncertain: several equal candidates or identifier holders, an
 * abridged mismatch, differing known languages, differing non-read-aloud EPUB ISBNs, or a near
 * match AI did not settle. Logs exactly one info line with the outcome, folders, and signal.
 * @param {MatchUnit} unit
 * @param {MatchCandidate[]} candidates - From findCandidates
 * @param {Object} log - Logger instance
 * @returns {Promise<MatchDecision>}
 */
export async function resolveMatch(unit, candidates, log) {
  const result = await decide(unit, candidates || [], log);
  const folders = result.candidate ? `book ${result.candidate.folder}`
    : result.candidates.length ? `candidates ${result.candidates.map(c => c.folder).join(', ')}` : 'no candidates';
  log.info(`🔗 Match ${OUTCOME_LABELS[result.outcome]} for "${unit.displayName || unit.title}": ` +
    `${folders}; signal: ${result.signal}; ${result.reason}`);
  return result;
}
