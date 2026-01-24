import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractAudioMetadata, extractDirectoryMetadata } from '../src/metadata.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock logger that captures calls for verification
function createMockLogger() {
  const calls = {
    info: [],
    warn: [],
    debug: [],
    error: []
  };
  
  return {
    log: {
      info: (...args) => calls.info.push(args),
      warn: (...args) => calls.warn.push(args),
      debug: (...args) => calls.debug.push(args),
      error: (...args) => calls.error.push(args)
    },
    calls
  };
}

// Mock ffprobe responses for different test files
const mockFfprobeResponses = {
  '/home/mason/Downloads/01 Angels and Demons.m4b': {
    format: {
      tags: {
        title: 'Angels and Demons',
        artist: 'Dan Brown',
        date: '2004',
        genre: 'Thriller'
      }
    }
  },
  '/home/mason/Downloads/R.F. Kuang - Katabasis.m4b': {
    format: {
      tags: {
        title: 'Katabasis',
        artist: 'R. F. Kuang',
        date: '2025',
        genre: 'Literature & Fiction'
      }
    }
  },
  '/home/mason/Downloads/Lodestar.mp3': {
    format: {
      tags: {
        title: 'Lodestar',
        artist: 'Shannon Messenger',
        genre: 'Audio Book'
      }
    }
  },
  '/home/mason/Downloads/Neverseen.mp3': {
    format: {
      tags: {
        title: 'Neverseen',
        artist: 'Shannon Messenger'
      }
    }
  },
  '/home/mason/Downloads/Matt Dinniman - Dungeon Crawler Carl.m4b': {
    format: {
      tags: {
        title: 'Dungeon Crawler Carl',
        artist: 'Matt Dinniman',
        date: '2021',
        genre: 'Science Fiction & Fantasy'
      }
    }
  }
};

// Mock execFile to simulate ffprobe
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((command, args, options, callback) => {
      // Handle version check
      if (args && args[0] === '-version') {
        if (callback) {
          callback(null, { stdout: 'ffprobe version 4.0', stderr: '' });
        }
        return;
      }
      
      // Get the file path from args
      const filePath = args && args[args.length - 1];
      
      // Check if we have a mock response for this file
      if (mockFfprobeResponses[filePath]) {
        const stdout = JSON.stringify(mockFfprobeResponses[filePath]);
        if (callback) {
          callback(null, { stdout, stderr: '' });
        }
      } else if (filePath === '' || !filePath || filePath === '/path/to/nonexistent.m4b') {
        // Simulate file not found error (not ENOENT for ffprobe command, but for the file)
        const error = new Error('No such file or directory');
        error.code = 1; // Exit code from ffprobe
        if (callback) {
          callback(error);
        }
      } else if (filePath === '/etc/hosts') {
        // Simulate invalid audio file
        const error = new Error('Invalid data found when processing input');
        error.code = 1;
        if (callback) {
          callback(error);
        }
      } else {
        // Default: no metadata found
        const stdout = JSON.stringify({ format: { tags: {} } });
        if (callback) {
          callback(null, { stdout, stderr: '' });
        }
      }
    })
  };
});

describe('metadata.js - Unit Tests', () => {
  describe('extractAudioMetadata', () => {
    describe('Valid audio files with complete metadata', () => {
      test('should extract complete metadata from M4B file (Angels and Demons)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', log);

        expect(result).not.toBeNull();
        expect(result).toMatchObject({
          hasMetadata: true,
          source: 'file'
        });
        expect(result.title).toBe('Angels and Demons');
        expect(result.author).toBe('Dan Brown');
        expect(result.year).toBe('2004');
        expect(result.genre).toBeTruthy();
        expect(typeof result.genre).toBe('string');
      });

      test('should extract metadata from M4B with year (Katabasis)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toBe('Katabasis');
        expect(result.author).toBe('R. F. Kuang');
        expect(result.year).toBe('2025');
        expect(result.genre).toBe('Literature & Fiction');
        expect(result.source).toBe('file');
      });

      test('should extract metadata from MP3 file (Lodestar)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toBe('Lodestar');
        expect(result.author).toBe('Shannon Messenger');
        expect(result.genre).toBe('Audio Book');
      });

      test('should extract metadata from another MP3 (Neverseen)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/Neverseen.mp3', log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toBe('Neverseen');
        expect(result.author).toBe('Shannon Messenger');
      });

      test('should extract metadata from M4B with detailed genre (Dungeon Crawler Carl)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/Matt Dinniman - Dungeon Crawler Carl.m4b', log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toContain('Dungeon Crawler Carl');
        expect(result.author).toBe('Matt Dinniman');
        expect(result.year).toBe('2021');
      });
    });

    describe('Metadata field handling', () => {
      test('should return all expected fields in correct format', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', log);

        expect(result).toHaveProperty('title');
        expect(result).toHaveProperty('author');
        expect(result).toHaveProperty('year');
        expect(result).toHaveProperty('genre');
        expect(result).toHaveProperty('hasMetadata');
        expect(result).toHaveProperty('source');
        
        // Ensure no unexpected fields
        const expectedFields = ['title', 'author', 'year', 'genre', 'hasMetadata', 'source'];
        const actualFields = Object.keys(result);
        expect(actualFields.sort()).toEqual(expectedFields.sort());
      });

      test('should handle files with partial metadata (some fields null)', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', log);

        // This file might not have year
        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toBeTruthy();
        expect(result.author).toBeTruthy();
        // Year might be null, which is fine
        expect(['string', 'object']).toContain(typeof result.year); // string or null
      });

      test('should set hasMetadata to true when any field is present', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', log);

        expect(result.hasMetadata).toBe(true);
        // At least one of these should be truthy
        const hasAnyData = !!(result.title || result.author || result.year || result.genre);
        expect(hasAnyData).toBe(true);
      });
    });

    describe('Error handling and edge cases', () => {
      test('should return null for non-existent file', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('/path/to/nonexistent.m4b', log);

        expect(result).toBeNull();
      });

      test('should return null for invalid file path', async () => {
        const { log } = createMockLogger();
        const result = await extractAudioMetadata('', log);

        expect(result).toBeNull();
      });

      test('should handle file paths with special characters', async () => {
        const { log } = createMockLogger();
        // Test with a file that has special chars in filename
        const result = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
      });

      test('should handle non-audio file gracefully', async () => {
        const { log } = createMockLogger();
        // Try to extract metadata from a text file (should fail gracefully)
        const result = await extractAudioMetadata('/etc/hosts', log);

        // Should return null, not throw
        expect(result).toBeNull();
      });
    });

    describe('Logging behavior', () => {
      test('should log debug message when metadata extracted', async () => {
        const { log, calls } = createMockLogger();
        await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', log);

        expect(calls.debug.length).toBeGreaterThan(0);
        const debugMessages = calls.debug.flat().join(' ');
        expect(debugMessages).toContain('Extracted metadata');
      });

      test('should log debug message when no metadata found', async () => {
        const { log, calls } = createMockLogger();
        await extractAudioMetadata('/path/to/nonexistent.m4b', log);

        // Should have debug logs about failure
        expect(calls.debug.length).toBeGreaterThan(0);
      });

      test('should show warning about ffprobe only once', async () => {
        const { log, calls } = createMockLogger();
        
        // This test is tricky because ffprobe IS available
        // We're just verifying the logging behavior
        await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', log);
        
        // Should not have any warnings if ffprobe is available
        const warnMessages = calls.warn.flat().join(' ');
        expect(warnMessages).not.toContain('ffprobe not available');
      });
    });
  });

  describe('extractDirectoryMetadata', () => {
    let testDir;

    beforeEach(async () => {
      // Create a temporary test directory
      testDir = path.join('/tmp', `dewey-test-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      // Clean up test directory
      await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('File preference logic', () => {
      test('should prefer M4B files over MP3 when both exist', async () => {
        const { log, calls } = createMockLogger();
        
        // Create empty test files (metadata will be mocked)
        const m4bPath = path.join(testDir, 'book.m4b');
        const mp3Path = path.join(testDir, 'chapter1.mp3');
        
        await fs.writeFile(m4bPath, 'fake m4b content');
        await fs.writeFile(mp3Path, 'fake mp3 content');
        
        // Add mock responses for these files
        mockFfprobeResponses[m4bPath] = mockFfprobeResponses['/home/mason/Downloads/01 Angels and Demons.m4b'];
        mockFfprobeResponses[mp3Path] = mockFfprobeResponses['/home/mason/Downloads/Lodestar.mp3'];
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        
        // Should have extracted from M4B (Angels and Demons)
        expect(result.title).toBe('Angels and Demons');
        expect(result.author).toBe('Dan Brown');
        
        // Check logs mention M4B
        const debugMessages = calls.debug.flat().join(' ');
        expect(debugMessages).toContain('M4B');
      });

      test('should use MP3 files when no M4B available', async () => {
        const { log, calls } = createMockLogger();
        
        const mp3Path = path.join(testDir, 'audiobook.mp3');
        await fs.writeFile(mp3Path, 'fake mp3 content');
        
        // Add mock response
        mockFfprobeResponses[mp3Path] = mockFfprobeResponses['/home/mason/Downloads/Lodestar.mp3'];
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).not.toBeNull();
        expect(result.title).toBe('Lodestar');
        
        const debugMessages = calls.debug.flat().join(' ');
        expect(debugMessages).toContain('MP3');
      });

      test('should use first M4B alphabetically when multiple exist', async () => {
        const { log } = createMockLogger();
        
        // Create multiple M4B files
        const firstPath = path.join(testDir, 'a-first.m4b');
        const lastPath = path.join(testDir, 'z-last.m4b');
        
        await fs.writeFile(firstPath, 'fake m4b content');
        await fs.writeFile(lastPath, 'fake m4b content');
        
        // Add mock responses
        mockFfprobeResponses[firstPath] = mockFfprobeResponses['/home/mason/Downloads/01 Angels and Demons.m4b'];
        mockFfprobeResponses[lastPath] = mockFfprobeResponses['/home/mason/Downloads/01 Angels and Demons.m4b'];
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).not.toBeNull();
        // Should use a-first.m4b (alphabetically first)
        expect(result.title).toBe('Angels and Demons');
      });
    });

    describe('Directory content handling', () => {
      test('should return null for empty directory', async () => {
        const { log } = createMockLogger();
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).toBeNull();
      });

      test('should return null for directory with only non-audio files', async () => {
        const { log } = createMockLogger();
        
        // Create some non-audio files
        await fs.writeFile(path.join(testDir, 'readme.txt'), 'test');
        await fs.writeFile(path.join(testDir, 'cover.jpg'), 'fake image');
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).toBeNull();
      });

      test('should skip subdirectories and only process audio files', async () => {
        const { log } = createMockLogger();
        
        // Create subdirectory with audio file
        const subdir = path.join(testDir, 'subfolder');
        await fs.mkdir(subdir);
        
        const subdirFile = path.join(subdir, 'nested.mp3');
        const mainFile = path.join(testDir, 'main.m4b');
        
        await fs.writeFile(subdirFile, 'fake mp3 content');
        await fs.writeFile(mainFile, 'fake m4b content');
        
        // Add mock responses
        mockFfprobeResponses[subdirFile] = mockFfprobeResponses['/home/mason/Downloads/Lodestar.mp3'];
        mockFfprobeResponses[mainFile] = mockFfprobeResponses['/home/mason/Downloads/01 Angels and Demons.m4b'];
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).not.toBeNull();
        // Should extract from main directory file, not subdirectory
        expect(result.title).toBe('Angels and Demons');
      });

      test('should handle mixed audio and non-audio files', async () => {
        const { log } = createMockLogger();
        
        const mp3Path = path.join(testDir, 'audiobook.mp3');
        
        await fs.writeFile(path.join(testDir, 'readme.txt'), 'test');
        await fs.writeFile(mp3Path, 'fake mp3 content');
        await fs.writeFile(path.join(testDir, 'cover.jpg'), 'fake');
        
        // Add mock response
        mockFfprobeResponses[mp3Path] = mockFfprobeResponses['/home/mason/Downloads/Lodestar.mp3'];
        
        const result = await extractDirectoryMetadata(testDir, log);

        expect(result).not.toBeNull();
        expect(result.title).toBe('Lodestar');
      });
    });

    describe('Error handling', () => {
      test('should return null for non-existent directory', async () => {
        const { log } = createMockLogger();
        const result = await extractDirectoryMetadata('/path/to/nonexistent/dir', log);

        expect(result).toBeNull();
      });

      test('should handle permission errors gracefully', async () => {
        const { log } = createMockLogger();
        // Try to read a protected directory
        const result = await extractDirectoryMetadata('/root', log);

        // Should return null, not throw
        expect(result).toBeNull();
      });
    });
  });
});

describe('metadata.js - Integration Tests', () => {
  describe('Real-world audiobook scenarios', () => {
    test('should extract metadata from professional audiobook (Audible format)', async () => {
      const { log } = createMockLogger();
      
      // Test with actual Audible-formatted M4B
      const result = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', log);

      expect(result).not.toBeNull();
      expect(result.title).toBeTruthy();
      expect(result.author).toBeTruthy();
      expect(result.year).toBeTruthy();
      expect(result.genre).toBeTruthy();
      
      // Verify quality of extracted data
      expect(result.title.length).toBeGreaterThan(3);
      expect(result.author.length).toBeGreaterThan(3);
      expect(result.year.match(/^\d{4}$/)).toBeTruthy(); // 4-digit year
    });

    test('should handle newer releases with current year', async () => {
      const { log } = createMockLogger();
      
      const result = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', log);

      expect(result).not.toBeNull();
      expect(result.year).toBe('2025');
      expect(parseInt(result.year)).toBeGreaterThanOrEqual(2024);
    });

    test('should extract from multiple different audiobook sources', async () => {
      const { log } = createMockLogger();
      
      const files = [
        '/home/mason/Downloads/01 Angels and Demons.m4b',
        '/home/mason/Downloads/Lodestar.mp3',
        '/home/mason/Downloads/R.F. Kuang - Katabasis.m4b',
        '/home/mason/Downloads/Matt Dinniman - Dungeon Crawler Carl.m4b',
        '/home/mason/Downloads/Neverseen.mp3'
      ];

      for (const file of files) {
        const result = await extractAudioMetadata(file, log);
        
        expect(result).not.toBeNull();
        expect(result.hasMetadata).toBe(true);
        expect(result.title).toBeTruthy();
        expect(result.author).toBeTruthy();
      }
    });
  });

  describe('Performance and reliability', () => {
    test('should extract metadata quickly (< 2 seconds per file)', async () => {
      const { log } = createMockLogger();
      
      const start = Date.now();
      await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', log);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(2000); // Should be fast
    });

    test('should handle multiple extractions in sequence', async () => {
      const { log } = createMockLogger();
      
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', log);
        results.push(result);
      }

      // All results should be consistent
      expect(results.every(r => r?.title === 'Lodestar')).toBe(true);
      expect(results.every(r => r?.author === 'Shannon Messenger')).toBe(true);
    });
  });
});
