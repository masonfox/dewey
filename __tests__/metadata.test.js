import { extractAudioMetadata, extractDirectoryMetadata } from '../src/metadata.js';

// Simple logger for tests
const mockLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {}
};

describe('metadata.js', () => {
  describe('extractAudioMetadata', () => {
    test('should extract metadata from real m4b file', async () => {
      const result = await extractAudioMetadata('/home/mason/Downloads/01 Angels and Demons.m4b', mockLog);

      expect(result).not.toBeNull();
      expect(result.hasMetadata).toBe(true);
      expect(result.source).toBe('file');
      expect(result.title).toBe('Angels and Demons');
      expect(result.author).toBe('Dan Brown');
      expect(result.year).toBe('2004');
      expect(result.genre).toBeTruthy();
    });

    test('should extract metadata from real mp3 file', async () => {
      const result = await extractAudioMetadata('/home/mason/Downloads/Lodestar.mp3', mockLog);

      expect(result).not.toBeNull();
      expect(result.hasMetadata).toBe(true);
      expect(result.title).toBe('Lodestar');
      expect(result.author).toBe('Shannon Messenger');
    });

    test('should extract metadata from Katabasis m4b', async () => {
      const result = await extractAudioMetadata('/home/mason/Downloads/R.F. Kuang - Katabasis.m4b', mockLog);

      expect(result).not.toBeNull();
      expect(result.hasMetadata).toBe(true);
      expect(result.title).toBe('Katabasis');
      expect(result.author).toBe('R. F. Kuang');
      expect(result.year).toBe('2025');
    });

    test('should return null for non-existent file', async () => {
      const result = await extractAudioMetadata('/path/to/nonexistent.m4b', mockLog);

      expect(result).toBeNull();
    });
    });

  describe('extractDirectoryMetadata', () => {
    test('should return null for non-existent directory', async () => {
      const result = await extractDirectoryMetadata('/path/to/nonexistent/dir', mockLog);

      expect(result).toBeNull();
    });
  });
});
