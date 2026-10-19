/**
 * Library layout strategies (D6): pure mappings from a resolved book and its
 * files to destination names. Layout never inspects metadata beyond the
 * resolved title and file flags, and never imports matching.
 */

import path from 'node:path';
import { LIBRARY_LAYOUT } from './config.js';
import { ConfigError } from './errors.js';
import { sanitizeSegment } from './utils.js';

const READALOUD_SUFFIX = ' (readaloud)';

const baseName = file => file.name ?? path.basename(file.path);

/** New book folder: DEST_DIR/[Author]/[Title], sanitized. */
function bookDir(destRoot, author, title) {
  return path.join(destRoot, sanitizeSegment(author), sanitizeSegment(title));
}

const withSuffix = name => {
  const ext = path.extname(name);
  return name.slice(0, name.length - ext.length) + READALOUD_SUFFIX + ext;
};

/**
 * existingNames: names already in (or planned for) the book folder.
 * readaloudNames: the subset known to be read-aloud EPUBs; any other
 * same-named EPUB is treated as the non-read-aloud original.
 */
function collidesWithOriginal(name, { existingNames = [], readaloudNames = [] } = {}) {
  const lower = name.toLowerCase();
  const isName = n => n.toLowerCase() === lower;
  return [...existingNames].some(isName) && ![...readaloudNames].some(isName);
}

export const audiobookshelf = {
  name: 'audiobookshelf',
  bookDir,
  /** Original name; a read-aloud EPUB colliding with the original gets ' (readaloud)'. */
  fileName(file, context = {}) {
    const name = baseName(file);
    if (file.kind === 'epub' && file.readaloud && collidesWithOriginal(name, context)) {
      return withSuffix(name);
    }
    return name;
  }
};

export const bookorbit = {
  name: 'bookorbit',
  bookDir,
  /** '<Title>.epub' / '<Title> (readaloud).epub'; audio keeps its name. */
  fileName(file, { title } = {}) {
    if (file.kind !== 'epub') return baseName(file);
    return `${title}${file.readaloud ? READALOUD_SUFFIX : ''}.epub`;
  }
};

export const LAYOUTS = { audiobookshelf, bookorbit };

/** Strategy for LIBRARY_LAYOUT (or an explicit name), case-insensitive. */
export function getLayout(name = LIBRARY_LAYOUT()) {
  const key = (name || '').trim().toLowerCase() || 'audiobookshelf';
  if (!Object.hasOwn(LAYOUTS, key)) {
    throw new ConfigError(`LIBRARY_LAYOUT must be one of: ${Object.keys(LAYOUTS).join(', ')} (got: "${name}")`, ['LIBRARY_LAYOUT']);
  }
  return LAYOUTS[key];
}
