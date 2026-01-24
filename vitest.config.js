import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  test: {
    globals: false, // Don't auto-inject globals (keep explicit imports)
    environment: 'node',
    testTimeout: 10000, // Default timeout
    hookTimeout: 10000,
    include: ['__tests__/**/*.test.js'],
    env: loadEnv(mode, process.cwd(), ''), // Load .env file
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        '__tests__/',
        '*.config.js',
        'src/healthcheck.js'
      ]
    }
  }
}));
