import { describe, test, expect, afterEach } from 'vitest';
import { isAudio, isEbook, isSupportedBook, bookFileKind, sanitizeSegment, heuristicsFromName } from '../src/utils.js';

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
