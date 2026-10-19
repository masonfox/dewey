import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { isAudio, isEbook, isSupportedBook, bookFileKind, isPathWithin, isWithinReviewDir, sanitizeSegment, heuristicsFromName } from '../src/utils.js';

describe('utils', () => {
  describe('isAudio', () => {
    test('should identify mp3 files as audio', () => {
      expect(isAudio('test.mp3')).toBe(true);
      expect(isAudio('/path/to/test.mp3')).toBe(true);
      expect(isAudio('TEST.MP3')).toBe(true);
    });

    test('should identify m4b files as audio', () => {
      expect(isAudio('test.m4b')).toBe(true);
      expect(isAudio('/path/to/test.m4b')).toBe(true);
      expect(isAudio('TEST.M4B')).toBe(true);
    });

    test('should reject non-audio files', () => {
      expect(isAudio('test.txt')).toBe(false);
      expect(isAudio('test.jpg')).toBe(false);
      expect(isAudio('test.png')).toBe(false);
      expect(isAudio('test.pdf')).toBe(false);
      expect(isAudio('test.nfo')).toBe(false);
      expect(isAudio('test.cue')).toBe(false);
    });

    test('should handle edge cases', () => {
      expect(isAudio('')).toBe(false);
      expect(isAudio('noextension')).toBe(false);
      expect(isAudio('.mp3')).toBe(true);
      expect(isAudio('test.mp3.txt')).toBe(false);
    });
  });

  describe('sanitizeSegment', () => {
    test('should remove unsafe characters', () => {
      expect(sanitizeSegment('Test/Book')).toBe('Test Book');
      expect(sanitizeSegment('Test\\Book')).toBe('Test Book');
      expect(sanitizeSegment('Test:Book')).toBe('Test Book');
      expect(sanitizeSegment('Test*Book')).toBe('Test Book');
      expect(sanitizeSegment('Test?Book')).toBe('Test Book');
      expect(sanitizeSegment('Test"Book')).toBe('Test Book');
      expect(sanitizeSegment('Test<Book>')).toBe('Test Book');
      expect(sanitizeSegment('Test|Book')).toBe('Test Book');
    });

    test('should handle multiple consecutive spaces', () => {
      expect(sanitizeSegment('Test    Book')).toBe('Test Book');
      expect(sanitizeSegment('  Test  Book  ')).toBe('Test Book');
    });

    test('should convert non-alphanumeric to spaces', () => {
      expect(sanitizeSegment('Test Book - Chapter 1')).toBe('Test Book Chapter 1');
      expect(sanitizeSegment("Test Book's Adventures")).toBe('Test Book s Adventures');
    });
  });

  describe('heuristicsFromName', () => {
    test('should extract author and title from filename', () => {
      const result = heuristicsFromName('Stephen King - The Shining.m4b');
      expect(result.author).toBe('Stephen King');
      expect(result.title).toBe('The Shining');
    });

    test('should handle author - title format', () => {
      const result = heuristicsFromName('J.K. Rowling - Harry Potter.m4b');
      expect(result.author).toBe('J.K. Rowling');
      expect(result.title).toBe('Harry Potter');
    });

    test('should handle title only', () => {
      const result = heuristicsFromName('Some Book Title.m4b');
      expect(result.author).toBe('Unknown');
      expect(result.title).toBe('Some Book Title');
    });

    test('should handle directory names', () => {
      const result = heuristicsFromName('Brandon Sanderson - Mistborn Series');
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('Mistborn Series');
    });

    test('should clean file extensions', () => {
      const result = heuristicsFromName('Author - Title.m4b');
      expect(result.title).toBe('Title');
    });
  });

  describe('book format classification', () => {
    afterEach(() => {
      delete process.env.INGEST_EBOOKS;
    });

    test('identifies epub files case-insensitively', () => {
      expect(isEbook('Dune.epub')).toBe(true);
      expect(isEbook('/path/to/DUNE.EPUB')).toBe(true);
      expect(bookFileKind('Dune.EPUB')).toBe('epub');
    });

    test('classifies audio extensions as audio', () => {
      for (const name of ['a.mp3', 'a.M4B', 'a.m4a']) {
        expect(isSupportedBook(name)).toBe(true);
        expect(bookFileKind(name)).toBe('audio');
        expect(isEbook(name)).toBe(false);
      }
    });

    test('rejects unsupported files', () => {
      for (const name of ['a.pdf', 'a.mobi', 'cover.jpg', 'a.epub.txt', 'noextension']) {
        expect(isSupportedBook(name)).toBe(false);
        expect(bookFileKind(name)).toBe(null);
      }
    });

    test('treats epub as unsupported when INGEST_EBOOKS=false', () => {
      process.env.INGEST_EBOOKS = 'false';
      expect(isEbook('Dune.epub')).toBe(false);
      expect(isSupportedBook('Dune.epub')).toBe(false);
      expect(bookFileKind('Dune.epub')).toBe(null);
      expect(isSupportedBook('Dune.m4b')).toBe(true);
    });
  });
});

describe('review directory predicate', () => {
  const saved = {};
  for (const key of ['REVIEW_DIR', 'SOURCE_DIR']) saved[key] = process.env[key];

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('isPathWithin matches the dir and descendants but not sibling prefixes (POSIX)', () => {
    const p = path.posix;
    expect(isPathWithin('/in/.dewey-review', '/in/.dewey-review', p)).toBe(true);
    expect(isPathWithin('/in/.dewey-review/123-Dune/Dune.epub', '/in/.dewey-review', p)).toBe(true);
    expect(isPathWithin('/in/.dewey-review/', '/in/.dewey-review', p)).toBe(true);
    expect(isPathWithin('/in/.dewey-review2', '/in/.dewey-review', p)).toBe(false);
    expect(isPathWithin('/in/.dewey-review2/Dune.epub', '/in/.dewey-review', p)).toBe(false);
    expect(isPathWithin('/in', '/in/.dewey-review', p)).toBe(false);
    expect(isPathWithin('/in/Dune/Dune.m4b', '/in/.dewey-review', p)).toBe(false);
    expect(isPathWithin('/in/.dewey-review/../Dune', '/in/.dewey-review', p)).toBe(false);
  });

  test('isPathWithin handles Windows separators, drives, and case', () => {
    const w = path.win32;
    expect(isPathWithin('C:\\in\\.dewey-review\\x\\Dune.epub', 'C:\\in\\.dewey-review', w)).toBe(true);
    expect(isPathWithin('c:/IN/.Dewey-Review/x', 'C:\\in\\.dewey-review', w)).toBe(true);
    expect(isPathWithin('C:\\in\\.dewey-review2\\x', 'C:\\in\\.dewey-review', w)).toBe(false);
    expect(isPathWithin('D:\\in\\.dewey-review\\x', 'C:\\in\\.dewey-review', w)).toBe(false);
  });

  test('isWithinReviewDir defaults to SOURCE_DIR/.dewey-review', () => {
    delete process.env.REVIEW_DIR;
    const src = path.resolve('review-test-incoming');
    process.env.SOURCE_DIR = src;
    expect(isWithinReviewDir(path.join(src, '.dewey-review'))).toBe(true);
    expect(isWithinReviewDir(path.join(src, '.dewey-review', 'unit', 'Dune.epub'))).toBe(true);
    expect(isWithinReviewDir(path.join(src, '.dewey-review2', 'Dune.epub'))).toBe(false);
    expect(isWithinReviewDir(path.join(src, 'Dune', 'Dune.m4b'))).toBe(false);
    expect(isWithinReviewDir(src)).toBe(false);
  });

  test('isWithinReviewDir honors an explicit REVIEW_DIR', () => {
    const review = path.resolve('custom-review');
    process.env.REVIEW_DIR = review;
    expect(isWithinReviewDir(path.join(review, 'a.epub'))).toBe(true);
    expect(isWithinReviewDir(review + '-old')).toBe(false);
  });
});
