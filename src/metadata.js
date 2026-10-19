import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import yauzl from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { bookFileKind, isSupportedBook } from './utils.js';

const execFileAsync = promisify(execFile);

// Track if ffprobe is available (checked once)
let ffprobeAvailable = null;
let ffprobeWarningShown = false;

/**
 * Check if ffprobe is available on the system
 * @returns {Promise<boolean>}
 */
async function checkFfprobeAvailable() {
  if (ffprobeAvailable !== null) {
    return ffprobeAvailable;
  }
  
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
    return true;
  } catch (error) {
    ffprobeAvailable = false;
    return false;
  }
}

/**
 * Clean metadata value - trim whitespace and handle empty/placeholder values
 * @param {string|undefined} value - Raw metadata value
 * @returns {string|null}
 */
function cleanMetadataValue(value) {
  if (!value) return null;
  
  const cleaned = value.trim();
  if (!cleaned) return null;
  
  // Handle common placeholder values
  const lowerCleaned = cleaned.toLowerCase();
  if (lowerCleaned === 'unknown' || 
      lowerCleaned === 'unknown artist' || 
      lowerCleaned === 'unknown album' ||
      lowerCleaned === 'n/a') {
    return null;
  }
  
  return cleaned;
}

/**
 * Normalize an ISBN-10 or ISBN-13 (hyphens/spaces allowed) to a checksum-valid ISBN-13
 * @param {string|null|undefined} value
 * @returns {string|null} 13-digit ISBN, or null when invalid
 */
export function normalizeIsbn(value) {
  if (!value) return null;
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  const isbn13Check = (d12) => {
    const sum = [...d12].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
    return String((10 - (sum % 10)) % 10);
  };
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11 !== 0) return null;
    const d12 = '978' + s.slice(0, 9);
    return d12 + isbn13Check(d12);
  }
  if (/^97[89]\d{10}$/.test(s)) {
    return isbn13Check(s.slice(0, 12)) === s[12] ? s : null;
  }
  return null;
}

/**
 * Normalize an ASIN (10 alphanumerics) to upper case
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function normalizeAsin(value) {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : null;
}

/**
 * @typedef {Object} BookIdentifier
 * @property {'isbn'|'asin'|'other'} type - Matching class; ISBN values are ISBN-13
 * @property {string} value
 * @property {string|null} scheme - Declared or inferred scheme ('isbn', 'asin', 'uuid', ...)
 */

const ISBN_SCHEMES = new Set(['isbn', 'isbn10', 'isbn-10', 'isbn13', 'isbn-13', '02', '15']); // 02/15: ONIX codelist 5
const ASIN_SCHEMES = new Set(['asin', 'mobi-asin', 'amazon', 'amzn']);

/**
 * Classify a raw identifier string as ISBN, ASIN, or other
 * @param {string} raw - Identifier text, e.g. "urn:isbn:0441013597"
 * @param {string|null} [schemeHint] - opf:scheme or refined identifier-type
 * @returns {BookIdentifier|null}
 */
export function classifyIdentifier(raw, schemeHint = null) {
  const text = (raw ?? '').toString().trim();
  if (!text) return null;
  let scheme = schemeHint ? String(schemeHint).trim().toLowerCase() : null;
  let value = text;
  const prefixed = text.match(/^(?:urn:)?([a-z][\w.-]*):(?!\/\/)(.+)$/i);
  if (prefixed) {
    scheme = scheme || prefixed[1].toLowerCase();
    value = prefixed[2].trim();
  }
  if (scheme && ISBN_SCHEMES.has(scheme)) {
    const isbn = normalizeIsbn(value);
    return isbn ? { type: 'isbn', value: isbn, scheme: 'isbn' } : { type: 'other', value, scheme: 'isbn' };
  }
  if (scheme && ASIN_SCHEMES.has(scheme)) {
    const asin = normalizeAsin(value);
    return asin ? { type: 'asin', value: asin, scheme: 'asin' } : { type: 'other', value, scheme };
  }
  if (!scheme) {
    const isbn = normalizeIsbn(value);
    if (isbn) return { type: 'isbn', value: isbn, scheme: 'isbn' };
    if (/^B0[A-Z0-9]{8}$/i.test(value)) return { type: 'asin', value: value.toUpperCase(), scheme: 'asin' };
  }
  return { type: 'other', value, scheme };
}

/**
 * Extract metadata from audio file using ffprobe
 * @param {string} filePath - Path to audio file (.mp3, .m4b, .m4a)
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} `{ title, author, year, genre, hasMetadata: true, source: 'file' }`
 *   (null fields when untagged), plus `isbn` (ISBN-13), `asin`, and `language` only when tagged;
 *   null when nothing useful is tagged or ffprobe fails
 */
export async function extractAudioMetadata(filePath, log) {
  // Check if ffprobe is available
  if (!(await checkFfprobeAvailable())) {
    if (!ffprobeWarningShown) {
      log.warn('⚠️  ffprobe not available or failed, metadata extraction disabled. Install ffmpeg for enhanced accuracy.');
      ffprobeWarningShown = true;
    }
    return null;
  }
  
  try {
    // Request every format tag (D3); key case varies between containers
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format_tags',
      '-of', 'json',
      filePath
    ], {
      timeout: 10000, // 10 second timeout
      maxBuffer: 1024 * 1024 // 1MB buffer for output
    });

    // Parse JSON output, lowercasing keys (first spelling wins)
    const result = JSON.parse(stdout);
    const tags = {};
    for (const [key, value] of Object.entries(result?.format?.tags || {})) {
      const lowerKey = key.toLowerCase();
      if (!(lowerKey in tags) && typeof value === 'string') tags[lowerKey] = value;
    }

    // Extract and clean fields
    const title = cleanMetadataValue(tags.title);
    const artist = cleanMetadataValue(tags.artist);
    const albumArtist = cleanMetadataValue(tags.album_artist);
    const year = cleanMetadataValue(tags.date);
    const genre = cleanMetadataValue(tags.genre);
    const isbn = normalizeIsbn(cleanMetadataValue(tags.isbn));
    const asin = normalizeAsin(cleanMetadataValue(tags.asin) || cleanMetadataValue(tags.audible_asin));
    const language = cleanMetadataValue(tags.language);

    // Prefer artist over album_artist, fallback to album_artist if artist is missing
    const author = artist || albumArtist;

    // Check if we have any useful metadata
    const hasMetadata = !!(title || author || year || genre || isbn || asin);

    if (!hasMetadata) {
      log.debug(`🔍 No embedded metadata found in ${path.basename(filePath)}`);
      return null;
    }

    const metadata = {
      title,
      author,
      year,
      genre,
      hasMetadata: true,
      source: 'file'
    };
    // Optional fields appear only when tagged, so untagged files keep the original shape
    if (isbn) metadata.isbn = isbn;
    if (asin) metadata.asin = asin;
    if (language) metadata.language = language;

    log.debug(`📊 Extracted metadata from ${path.basename(filePath)}:`, metadata);
    
    return metadata;
    
  } catch (error) {
    // ffprobe errors are non-fatal - just log and continue without metadata
    if (error.code === 'ENOENT') {
      if (!ffprobeWarningShown) {
        log.warn('⚠️  ffprobe command not found. Install ffmpeg for enhanced metadata extraction.');
        ffprobeWarningShown = true;
      }
    } else {
      log.debug(`⚠️  Failed to extract metadata from ${path.basename(filePath)}: ${error.message}`);
    }
    return null;
  }
}

// OPF and container.xml are small; anything larger is not a sane package document
const MAX_EPUB_ENTRY_BYTES = 4 * 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, jPath, isLeaf, isAttribute) => !isAttribute &&
    ['rootfile', 'title', 'creator', 'language', 'identifier', 'date', 'subject', 'meta', 'item'].includes(name)
});

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => err ? reject(err) : resolve(zip));
  });
}

/** Walk the central directory only; no entry data is read */
function listZipEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on('entry', (entry) => {
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function findZipEntry(entries, name) {
  if (entries.has(name)) return entries.get(name);
  const lower = name.toLowerCase();
  for (const [fileName, entry] of entries) {
    if (fileName.toLowerCase() === lower) return entry;
  }
  return null;
}

function readZipEntryText(zip, entry) {
  if (entry.uncompressedSize > MAX_EPUB_ENTRY_BYTES) {
    return Promise.reject(new Error(`${entry.fileName} exceeds ${MAX_EPUB_ENTRY_BYTES} bytes`));
  }
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_EPUB_ENTRY_BYTES) {
          stream.destroy(new Error(`${entry.fileName} exceeds ${MAX_EPUB_ENTRY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '')));
      stream.on('error', reject);
    });
  });
}

function nodeText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return typeof node['#text'] === 'string' ? node['#text'] : '';
}

function cleanText(node) {
  return cleanMetadataValue(nodeText(node).replace(/\s+/g, ' '));
}

/**
 * Extract package metadata from an EPUB (D2). Reads only the ZIP central directory,
 * META-INF/container.xml, and the OPF entry, so large read-aloud EPUBs stay cheap.
 * @param {string} filePath - Path to .epub file
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} `{ title, author, year, genre, language, identifiers: BookIdentifier[],
 *   readaloud: boolean, hasMetadata, source: 'epub' }` (null fields when absent; hasMetadata means
 *   title or author is present); null with a warning when the archive, container, or OPF is unreadable
 */
export async function extractEpubMetadata(filePath, log) {
  let zip;
  try {
    zip = await openZip(filePath);
    const entries = await listZipEntries(zip);

    const containerEntry = findZipEntry(entries, 'META-INF/container.xml');
    if (!containerEntry) throw new Error('missing META-INF/container.xml');
    const container = xmlParser.parse(await readZipEntryText(zip, containerEntry));
    const rootfiles = container?.container?.rootfiles?.rootfile || [];
    const rootfile = rootfiles.find(r => /oebps-package/i.test(r?.['@_media-type'] || '')) || rootfiles[0];
    let opfPath = rootfile?.['@_full-path'];
    if (!opfPath) throw new Error('container.xml names no OPF package');
    try { opfPath = decodeURIComponent(opfPath); } catch { /* keep raw path */ }

    const opfEntry = findZipEntry(entries, opfPath.replace(/^\/+/, ''));
    if (!opfEntry) throw new Error(`missing OPF package ${opfPath}`);
    const pkg = xmlParser.parse(await readZipEntryText(zip, opfEntry))?.package;
    if (!pkg) throw new Error(`${opfPath} is not an OPF package`);

    // EPUB 2 files sometimes nest Dublin Core under <dc-metadata>/<x-metadata>
    const rawMetadata = pkg.metadata || {};
    const md = { ...rawMetadata, ...(rawMetadata['dc-metadata'] || {}) };
    const metas = [...(rawMetadata.meta || []), ...(rawMetadata['x-metadata']?.meta || [])];

    // EPUB 3 <meta refines="#id" property="..."> values, keyed by id then property
    const refinements = new Map();
    for (const meta of metas) {
      const id = meta?.['@_refines']?.replace(/^#/, '');
      const property = meta?.['@_property']?.toLowerCase();
      if (!id || !property) continue;
      if (!refinements.has(id)) refinements.set(id, {});
      const props = refinements.get(id);
      if (!(property in props)) props[property] = nodeText(meta).trim().toLowerCase();
    }
    const refined = (node, property) => refinements.get(node?.['@_id'])?.[property] || null;

    const titles = md.title || [];
    const title = cleanText(titles.find(t => refined(t, 'title-type') === 'main') || titles[0]);

    const creators = (md.creator || [])
      .map(c => ({ name: cleanText(c), role: (c?.['@_role'] || refined(c, 'role') || '').trim().toLowerCase() || null }))
      .filter(c => c.name);
    const primary = creators.find(c => c.role === 'aut') || creators.find(c => !c.role) || creators[0];
    const author = primary?.name || null;

    const language = cleanText((md.language || [])[0]);
    const year = (md.date || []).map(nodeText).map(d => d.match(/\b\d{4}\b/)?.[0]).find(Boolean) || null;
    const genre = cleanText((md.subject || [])[0]);

    const identifiers = [];
    for (const node of md.identifier || []) {
      const id = classifyIdentifier(nodeText(node), node?.['@_scheme'] || refined(node, 'identifier-type'));
      if (id && !identifiers.some(i => i.type === id.type && i.value === id.value)) identifiers.push(id);
    }

    const readaloud = (pkg.manifest?.item || []).some(item =>
      !!item?.['@_media-overlay'] || (item?.['@_media-type'] || '').toLowerCase() === 'application/smil+xml');

    const metadata = {
      title,
      author,
      year,
      genre,
      language,
      identifiers,
      readaloud,
      hasMetadata: !!(title || author),
      source: 'epub'
    };
    log.debug(`📖 Extracted EPUB metadata from ${path.basename(filePath)}:`, metadata);
    return metadata;
  } catch (error) {
    log.warn(`⚠️  Could not read EPUB metadata from ${path.basename(filePath)}: ${error.message}`);
    return null;
  } finally {
    zip?.close();
  }
}

// D10 precedence for the primary author/title source, indexed by tier
const UNIT_SOURCE_LABELS = ['M4B', 'EPUB', 'MP3/M4A', 'READALOUD EPUB'];

function identifiersFrom(metadata) {
  if (!metadata) return [];
  if (metadata.source === 'epub') return metadata.identifiers || [];
  const ids = [];
  if (metadata.isbn) ids.push({ type: 'isbn', value: metadata.isbn, scheme: 'isbn' });
  if (metadata.asin) ids.push({ type: 'asin', value: metadata.asin, scheme: 'asin' });
  return ids;
}

/**
 * Describe a migration unit (D10). Author/title/year/genre come from the first file with embedded
 * metadata in the order .m4b → non-read-aloud EPUB → .mp3/.m4a → read-aloud EPUB (alphabetical
 * within a tier). Identifiers are merged across the unit and language is the primary's, else the
 * first found in that order. Every EPUB and .m4b is read; of .mp3/.m4a tracks only the first
 * (sorted) is probed, since tracks of one recording share tags.
 * @param {Array<string|{path: string}>} files - Unit files; unsupported paths are ignored
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} `{ title, author, year, genre, language, identifiers: BookIdentifier[],
 *   hasMetadata, source: 'file'|'epub'|null, primaryFile: string|null,
 *   files: [{ path, kind: 'audio'|'epub', readaloud: boolean, metadata: Object|null }] }`;
 *   `files` lists every supported file (metadata null when not probed or unreadable);
 *   null when the unit has no supported files or nothing embedded at all
 */
export async function extractUnitMetadata(files, log) {
  const paths = [...new Set((files || []).map(f => typeof f === 'string' ? f : f?.path))]
    .filter(p => p && bookFileKind(p))
    .sort();
  if (paths.length === 0) return null;

  let probedTrack = false;
  const described = [];
  for (const filePath of paths) {
    const kind = bookFileKind(filePath);
    let metadata = null;
    let tier;
    if (kind === 'epub') {
      metadata = await extractEpubMetadata(filePath, log);
      tier = metadata?.readaloud ? 3 : 1;
    } else if (/\.m4b$/i.test(filePath)) {
      metadata = await extractAudioMetadata(filePath, log);
      tier = 0;
    } else {
      if (!probedTrack) metadata = await extractAudioMetadata(filePath, log);
      probedTrack = true;
      tier = 2;
    }
    described.push({ path: filePath, kind, readaloud: !!metadata?.readaloud, metadata, tier });
  }

  const ordered = [...described].sort((a, b) => a.tier - b.tier);
  const primary = ordered.find(f => f.metadata?.hasMetadata) || null;
  const identifiers = [];
  for (const f of ordered) {
    for (const id of identifiersFrom(f.metadata)) {
      if (!identifiers.some(i => i.type === id.type && i.value === id.value)) identifiers.push(id);
    }
  }
  const language = primary?.metadata.language || ordered.map(f => f.metadata?.language).find(Boolean) || null;

  if (!primary && identifiers.length === 0 && !language) {
    log.debug(`🔍 No embedded metadata found in ${paths.length} unit file(s)`);
    return null;
  }
  if (primary) {
    log.debug(`📁 Extracting unit metadata using ${UNIT_SOURCE_LABELS[primary.tier]} file: ${path.basename(primary.path)}`);
  }

  const m = primary?.metadata || {};
  return {
    title: m.title || null,
    author: m.author || null,
    year: m.year || null,
    genre: m.genre || null,
    language,
    identifiers,
    hasMetadata: !!primary,
    source: m.source || null,
    primaryFile: primary?.path || null,
    files: described.map(({ tier, ...f }) => f)
  };
}

/**
 * Extract metadata from a directory's direct supported files via extractUnitMetadata.
 * Audio-only directories still prefer the first .m4b, then .mp3.
 * @param {string} dirPath - Path to directory containing book files
 * @param {Object} log - Logger instance
 * @returns {Promise<Object|null>} Unit metadata (see extractUnitMetadata) or null
 */
export async function extractDirectoryMetadata(dirPath, log) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter(entry => !entry.isDirectory())
      .map(entry => path.join(dirPath, entry.name))
      .filter(isSupportedBook);

    if (files.length === 0) {
      log.debug(`🔍 No book files found in ${path.basename(dirPath)}`);
      return null;
    }

    return await extractUnitMetadata(files, log);

  } catch (error) {
    log.debug(`⚠️  Failed to extract directory metadata from ${path.basename(dirPath)}: ${error.message}`);
    return null;
  }
}
