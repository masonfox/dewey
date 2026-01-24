import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false, // Don't auto-inject globals (keep explicit imports)
    environment: 'node',
    testTimeout: 10000, // Default timeout
    hookTimeout: 10000,
    include: ['__tests__/**/*.test.js'],
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
});
