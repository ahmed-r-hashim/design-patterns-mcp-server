// Test setup file
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

interface TestCache {
  clear(): void;
}

interface TestDatabaseManager {
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var testCache: TestCache | undefined;
  // eslint-disable-next-line no-var
  var testDatabaseManager: TestDatabaseManager | undefined;
}

const TEST_DATA_DIR = join(__dirname, 'temp');
const MAIN_DB_PATH = join(__dirname, '..', 'data', 'design-patterns.db');
// Unique filename per test-file worker process to avoid EBUSY/ENOENT races
// when vitest runs multiple test files concurrently and they all share the
// same tests/temp directory.
const TEST_DB_PATH = join(TEST_DATA_DIR, `test-patterns-${process.pid}-${randomUUID()}.db`);

// Create test database directory and copy main database for tests
beforeAll(() => {
  // Create temp directory
  mkdirSync(TEST_DATA_DIR, { recursive: true });

  // Copy main database to test location if it exists
  if (existsSync(MAIN_DB_PATH)) {
    copyFileSync(MAIN_DB_PATH, TEST_DB_PATH);
  }

  // Set test environment variable
  process.env.NODE_ENV = 'test';
  process.env.TEST_DB_PATH = TEST_DB_PATH;
});

// Reset test environment before each test
beforeEach(() => {
  // Clear any test-specific caches
  if (globalThis.testCache) {
    globalThis.testCache.clear();
  }
});

// Clean up after tests
afterAll(async () => {
  if (globalThis.testDatabaseManager) {
    try {
      await globalThis.testDatabaseManager.close();
    } catch {
      // Ignore close errors during teardown
    }
  }

  // Brief yield so file handles can close before rmSync
  await new Promise(resolve => setTimeout(resolve, 50));

  // Only remove this worker's own test database file. Removing the whole
  // shared TEST_DATA_DIR here races with other test-file workers that may
  // still be creating/using their own unique DB file in the same directory.
  if (existsSync(TEST_DB_PATH)) {
    try {
      rmSync(TEST_DB_PATH, { force: true });
    } catch {
      // Non-fatal: file may still be locked on some platforms
    }
  }

  delete process.env.TEST_DB_PATH;
});