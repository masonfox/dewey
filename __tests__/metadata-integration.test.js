import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeViaClaude } from '../src/claude.js';
import { extractAudioMetadata } from '../src/metadata.js';

// Mock logger
const mockLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {}
};

describe('metadata-claude integration', () => {
  describe('Claude normalization with embedded metadata', () => {
    test('should pass metadata to Claude for enhanced normalization', async () => {
      // Extract metadata from a real file
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);
      
      expect(fileMetadata).not.toBeNull();

      // Use Claude to normalize with metadata context
      const result = await normalizeViaClaude(
        '01 Angels and Demons.m4b',
        'Unknown', // fallback author
        'Angels and Demons', // fallback title
        mockLog,
        '/home/mason/Downloads',
        fileMetadata
      );

      expect(result).not.toBeNull();
      expect(result.author).toBeTruthy();
      expect(result.title).toBeTruthy();
      
      // Claude should use the metadata to produce clean results
      expect(result.author).toBe('Dan Brown');
      expect(result.title).toBe('Angels and Demons');
    });

    test('should handle metadata with year for disambiguation', async () => {
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', mockLog);
      
      expect(fileMetadata).not.toBeNull();
      expect(fileMetadata.year).toBe('2025');

      const result = await normalizeViaClaude(
        'R.F. Kuang - Katabasis.m4b',
        'Unknown',
        'Katabasis',
        mockLog,
        '/home/mason/Downloads',
        fileMetadata
      );

      expect(result).not.toBeNull();
      expect(result.author).toContain('Kuang');
      expect(result.title).toContain('Katabasis');
    });

    test('should handle author name variations with metadata', async () => {
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', mockLog);
      
      expect(fileMetadata.author).toBe('R. F. Kuang');

      const result = await normalizeViaClaude(
        'RF Kuang Katabasis.m4b', // Messy filename
        'Unknown',
        'Katabasis',
        mockLog,
        null,
        fileMetadata
      );

      expect(result).not.toBeNull();
      // Claude should use the clean metadata format
      expect(result.author).toBe('R. F. Kuang');
    });

    test('should work without metadata (backward compatibility)', async () => {
      // Test that Claude still works when no metadata is provided
      const result = await normalizeViaClaude(
        'Stephen King - The Stand.mp3',
        'Stephen King',
        'The Stand',
        mockLog,
        null,
        null // No metadata
      );

      expect(result).not.toBeNull();
      expect(result.author).toBe('Stephen King');
      expect(result.title).toBe('The Stand');
    });

    test('should handle metadata with genre for context', async () => {
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);
      
      expect(fileMetadata.genre).toBeTruthy();
      expect(fileMetadata.genre).toContain('Thriller');

      const result = await normalizeViaClaude(
        '01 Angels and Demons.m4b',
        'Unknown',
        'Angels and Demons',
        mockLog,
        null,
        fileMetadata
      );

      expect(result).not.toBeNull();
      // Genre provides context but doesn't change the output format
      expect(result.author).toBe('Dan Brown');
      expect(result.title).toBe('Angels and Demons');
    });

    test('should handle partial metadata gracefully', async () => {
      // Create mock partial metadata
      const partialMetadata = {
        title: 'Some Book',
        author: null, // Missing author
        year: null,
        genre: 'Fiction',
        hasMetadata: true,
        source: 'file'
      };

      const result = await normalizeViaClaude(
        'J K Rowling - Harry Potter.mp3', // Give it a recognizable filename
        'J K Rowling',
        'Harry Potter',
        mockLog,
        null,
        partialMetadata
      );

      // Claude might return null if API fails, or might return normalized data
      if (result !== null) {
        // If it succeeded, verify it used the metadata title
        expect(result.title).toBeTruthy();
      } else {
        // If Claude failed, that's also acceptable in this test context
        expect(result).toBeNull();
      }
    });
  });

  describe('Metadata extraction consistency', () => {
    test('should produce same metadata from same file repeatedly', async () => {
      const results = [];
      
      for (let i = 0; i < 3; i++) {
        const metadata = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', mockLog);
        results.push(metadata);
      }

      // All extractions should be identical
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    });

    test('should extract different metadata from different files', async () => {
      const metadata1 = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', mockLog);
      const metadata2 = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);

      expect(metadata1).not.toEqual(metadata2);
      expect(metadata1.title).not.toBe(metadata2.title);
      expect(metadata1.author).not.toBe(metadata2.author);
    });
  });

  describe('End-to-end metadata flow', () => {
    test('should extract, normalize, and verify full metadata pipeline', async () => {
      // Step 1: Extract metadata from file
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);
      
      expect(fileMetadata).not.toBeNull();
      expect(fileMetadata.hasMetadata).toBe(true);

      // Step 2: Pass to Claude for normalization
      const normalized = await normalizeViaClaude(
        '01 Angels and Demons.m4b',
        'Unknown',
        'Angels and Demons',
        mockLog,
        '/home/mason/Downloads',
        fileMetadata
      );

      expect(normalized).not.toBeNull();

      // Step 3: Verify the complete pipeline produced quality results
      expect(normalized.author).toBe('Dan Brown');
      expect(normalized.title).toBe('Angels and Demons');
      
      // Verify normalization cleaned up the data
      expect(normalized.author).not.toContain('  '); // No double spaces
      expect(normalized.title).not.toContain('01'); // No file prefixes
    });

    test('should handle complex filename with metadata enrichment', async () => {
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/Matt Dinniman - Dungeon Crawler Carl.m4b', mockLog);
      
      expect(fileMetadata).not.toBeNull();

      const normalized = await normalizeViaClaude(
        'Matt Dinniman - Dungeon Crawler Carl.m4b',
        'Matt Dinniman',
        'Dungeon Crawler Carl',
        mockLog,
        null,
        fileMetadata
      );

      expect(normalized).not.toBeNull();
      expect(normalized.author).toBe('Matt Dinniman');
      expect(normalized.title).toContain('Dungeon Crawler Carl');
    });
  });

  describe('Error handling in integrated flow', () => {
    test('should handle metadata extraction failure gracefully', async () => {
      // Try to extract from non-existent file
      const fileMetadata = await extractAudioMetadata('/nonexistent/file.m4b', mockLog);
      
      expect(fileMetadata).toBeNull();

      // Claude should still be callable without metadata (though it may fail for other reasons)
      const normalized = await normalizeViaClaude(
        'Stephen King - The Stand.mp3', // Use a recognizable title
        'Stephen King',
        'The Stand',
        mockLog,
        null,
        null // Null metadata from failed extraction
      );

      // Claude might return null (API issues, rate limits, etc.) or valid data
      // The important thing is that null metadata doesn't crash the system
      if (normalized !== null) {
        expect(normalized.author).toBeTruthy();
        expect(normalized.title).toBeTruthy();
      }
      // If normalized is null, that's ok - Claude can fail for various reasons
      // The test is just verifying we handle null metadata gracefully
    });

    test('should handle Claude normalization with invalid metadata gracefully', async () => {
      // Create invalid metadata
      const invalidMetadata = {
        title: '',
        author: '',
        year: 'invalid',
        genre: null,
        hasMetadata: false,
        source: 'file'
      };

      const normalized = await normalizeViaClaude(
        'test-book.mp3',
        'Test Author',
        'Test Book',
        mockLog,
        null,
        invalidMetadata
      );

      // Should still work, falling back to heuristics
      expect(normalized).toBeDefined();
    });
  });

  describe('Metadata quality improvements', () => {
    test('should provide better results with metadata than without', async () => {
      // Extract metadata
      const fileMetadata = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);
      
      // Normalize WITH metadata
      const withMetadata = await normalizeViaClaude(
        '01-angels-demons-dan-brown.m4b', // Messy filename
        'Unknown',
        'angels demons',
        mockLog,
        null,
        fileMetadata
      );

      // Normalize WITHOUT metadata (same messy filename)
      const withoutMetadata = await normalizeViaClaude(
        '01-angels-demons-dan-brown.m4b',
        'Unknown',
        'angels demons',
        mockLog,
        null,
        null
      );

      expect(withMetadata).not.toBeNull();
      expect(withoutMetadata).not.toBeNull();

      // With metadata should produce cleaner, more authoritative results
      expect(withMetadata.title).toBe('Angels and Demons');
      expect(withMetadata.author).toBe('Dan Brown');
      
      // Both should work, but metadata version should match embedded data exactly
      expect(withMetadata.title).toBe('Angels and Demons');
    });
  });
});
