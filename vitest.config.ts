import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    hookTimeout: 30000,
    slowTestThreshold: 10000,
    coverage: {
      reporter: ['text', 'json', 'html'],
      // Scope coverage to the actual library source. Root-level manual test
      // scripts, build/config scripts, and generated output are not library
      // code and shouldn't count against the coverage ratio.
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'backup/',
        'scripts/',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});