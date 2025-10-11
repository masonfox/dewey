import path from 'node:path';

export function isAudio(p) {
  return /\.(mp3|m4b)$/i.test(p);
}

export function sanitizeSegment(s) {
  // Stricter normalization: replace all non-alphanumeric chars with a space, collapse spaces, trim
  let result = (s || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown';
  
  // Remove duplicate words (case-insensitive)
  const words = result.split(' ');
  const uniqueWords = [];
  const seen = new Set();
  
  for (const word of words) {
    const lowerWord = word.toLowerCase();
    if (!seen.has(lowerWord)) {
      seen.add(lowerWord);
      uniqueWords.push(word);
    }
  }
  
  return uniqueWords.join(' ') || 'Unknown';
}

export function heuristicsFromName(name, parentDir) {
  const stem = name.replace(/\.[^.]+$/, '');
  let author = 'Unknown';
  let title = stem;

  // Case-insensitive pattern matching
  const lowerStem = stem.toLowerCase();

  // Pattern 1: "Title by Author" or "Title By Author"
  const byMatch = lowerStem.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    title = stem.slice(0, byMatch[1].length).trim();
    author = stem.slice(stem.length - byMatch[2].length).trim();
    return { author, title };
  }

  // Pattern 2: Handle series with dashes - look for patterns like "Series Book # - Title"
  const dashMatch = stem.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) {
    const leftPart = dashMatch[1].trim();
    const rightPart = dashMatch[2].trim();
    
    // Remove common prefixes like [M4B], [MP3], etc. before checking for series patterns
    const cleanLeftPart = leftPart.replace(/^\[[^\]]+\]\s*/, '').trim();
    
    // If clean left part looks like a series (contains numbers, "Book", "Vol", etc), treat it as part of title
    // But only if it doesn't look like an author name (has multiple words with proper capitalization)
    const isSeriesPattern = /(?:book|vol|volume|part|chapter|\d+)/i.test(cleanLeftPart);
    const looksLikeAuthor = cleanLeftPart.includes(' ') && !/^\d/.test(cleanLeftPart);
    
    if (isSeriesPattern && !looksLikeAuthor) {
      title = stem; // Keep the whole thing as title
      // Try to extract author from parent directory if available
      if (parentDir) {
        const parentName = path.basename(parentDir);
        // If parent looks like an author name (has space), use it
        if (parentName.includes(' ') && !/book|vol|volume|series/i.test(parentName)) {
          author = parentName;
        }
      }
    } else {
      // Traditional "Author - Title" pattern (use cleaned left part as author)
      author = cleanLeftPart || leftPart;
      title = rightPart;
    }
    return { author, title };
  }

  // Pattern 3: Handle numbered files like "01 - Title" or "1. Title"
  const numberedMatch = stem.match(/^\d+[\.\-\s]+(.+)$/);
  if (numberedMatch) {
    title = numberedMatch[1].trim();
    // Use parent directory as author if available
    if (parentDir) {
      const parentName = path.basename(parentDir);
      if (parentName.includes(' ') && !/book|vol|volume|series/i.test(parentName)) {
        author = parentName;
      }
    }
    return { author, title };
  }

  // Pattern 4: Remove common publisher/edition info in parentheses
  const cleanTitle = stem.replace(/\s*\([^)]*(?:edition|unabridged|audiobook|publisher)\)[^)]*$/i, '').trim();
  if (cleanTitle !== stem) {
    title = cleanTitle;
  }

  // Fallback: Use parent directory as title if current name seems like a generic filename
  if (parentDir && (/^(audiobook|book|file|\d+)$/i.test(stem) || stem.length < 3)) {
    title = path.basename(parentDir);
  } else if (parentDir && !title.includes(' ') && path.basename(parentDir).includes(' ')) {
    // If filename has no spaces but parent dir does, prefer parent dir as title
    title = path.basename(parentDir);
  }

  // Final fallback: If we still don't have an author and we have a parent directory,
  // try to extract author from the parent directory name
  if (author === 'Unknown' && parentDir) {
    const parentName = path.basename(parentDir);
    const parentHeuristics = heuristicsFromName(parentName, null);
    if (parentHeuristics.author !== 'Unknown') {
      author = parentHeuristics.author;
    }
  }

  return { author, title };
}


