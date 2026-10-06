import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { StructuredLogger } from '../../src/utils/logger.js';

describe('StructuredLogger', () => {
  const tmpDir = path.join(process.cwd(), 'temp', 'structured-logger-fixtures');
  const logFile = path.join(tmpDir, 'test.log');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildLogger(overrides: Record<string, unknown> = {}) {
    return new StructuredLogger({
      level: 0,
      format: 'json',
      enableConsole: false,
      enableFile: true,
      logFile,
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      enableRotation: true,
      enableCompression: false,
      structuredData: true,
      includeStackTrace: true,
      includePerformanceMetrics: false,
      ...overrides,
    } as never);
  }

  function readLogLines(): Record<string, unknown>[] {
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, 'utf-8');

    // Entries may be pretty-printed (multi-line) JSON concatenated together,
    // so split on brace-depth boundaries instead of naive newline splitting.
    const entries: Record<string, unknown>[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          entries.push(JSON.parse(content.slice(start, i + 1)) as Record<string, unknown>);
          start = -1;
        }
      }
    }
    return entries;
  }

  it('writes info/debug/warn messages with structured data', () => {
    const logger = buildLogger();
    logger.info('svc', 'hello', { foo: 'bar' });
    logger.flushAll();

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('hello');
    expect(lines[0].level).toBe('INFO');
    expect((lines[0].data as Record<string, unknown>).foo).toBe('bar');
  });

  it('flushes immediately for ERROR-level logs including error details', () => {
    const logger = buildLogger();
    const error = new Error('boom');
    logger.error('svc', 'failed', error, { context: 'x' });

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('ERROR');
    expect((lines[0].error as Record<string, unknown>).message).toBe('boom');
  });

  it('fatal logs flush immediately', () => {
    const logger = buildLogger();
    logger.fatal('svc', 'fatal error', new Error('critical'));
    expect(readLogLines()).toHaveLength(1);
  });

  it('skips logs below configured level', () => {
    const logger = buildLogger({ level: 2 }); // WARN
    logger.debug('svc', 'debug msg');
    logger.info('svc', 'info msg');
    logger.flushAll();
    expect(readLogLines()).toHaveLength(0);
  });

  it('buffers logs until bufferSize is reached when below ERROR level', () => {
    const logger = buildLogger();
    logger.info('svc', 'buffered message');
    // Not flushed yet (bufferSize is 100, ERROR auto-flushes but INFO doesn't)
    expect(readLogLines()).toHaveLength(0);
    logger.flushAll();
    expect(readLogLines()).toHaveLength(1);
  });

  it('http() logs structured HTTP request data', () => {
    const logger = buildLogger();
    logger.http('svc', 'GET', '/health', 200, 12, 'agent', '127.0.0.1');
    logger.flushAll();

    const lines = readLogLines();
    expect(lines[0].message).toBe('HTTP GET /health');
    expect((lines[0].data as Record<string, unknown>).statusCode).toBe(200);
  });

  it('database() logs structured database operation data', () => {
    const logger = buildLogger();
    logger.database('svc', 'SELECT', 'patterns', 5, 10);
    logger.flushAll();

    const lines = readLogLines();
    expect(lines[0].message).toBe('Database SELECT on patterns');
    expect((lines[0].data as Record<string, unknown>).recordCount).toBe(10);
  });

  it('timing() logs performance metrics when enabled', () => {
    const logger = buildLogger({ includePerformanceMetrics: true });
    logger.timing('svc', 'op', 42, { extra: true });
    logger.flushAll();

    const lines = readLogLines();
    expect(lines[0].message).toBe('Operation completed: op');
    expect((lines[0].data as Record<string, unknown>).duration).toBe(42);
  });

  it('child() creates a logger that tags entries with the child service name', () => {
    const logger = buildLogger();
    const child = logger.child('child-service');
    child.info('', 'from child');
    logger.flushAll();

    const lines = readLogLines();
    expect(lines[0].service).toBe('child-service');
  });

  it('child logger forwards error/warn/debug/http/database/timing to the parent', () => {
    const logger = buildLogger();
    const child = logger.child('child-service');

    child.debug('', 'd');
    child.warn('', 'w');
    child.error('', 'e', new Error('x'));
    child.http('', 'GET', '/x', 200, 1);
    child.database('', 'SELECT', 't', 1);
    child.timing('', 'op', 1);
    logger.flushAll();

    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.every(l => l.service === 'child-service')).toBe(true);
  });

  it('nested child() creates another child bound to the same root parent', () => {
    const logger = buildLogger();
    const child = logger.child('child-a');
    const grandchild = child.child('child-b');
    grandchild.info('', 'nested');
    logger.flushAll();

    const lines = readLogLines();
    expect(lines[0].service).toBe('child-b');
  });

  it('formats as human-readable text when format=text', () => {
    const logger = buildLogger({ format: 'text' });
    logger.info('svc', 'plain text message', { a: 1 });
    logger.flushAll();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('plain text message');
    expect(content).toContain('svc');
  });

  it('formats as pretty JSON when format=pretty', () => {
    const logger = buildLogger({ format: 'pretty' });
    logger.info('svc', 'pretty message');
    logger.flushAll();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('"message": "pretty message"');
  });

  it('getStats reports buffered count and file size', () => {
    const logger = buildLogger();
    logger.info('svc', 'one');
    const stats = logger.getStats();
    expect(stats.buffered).toBe(1);

    logger.flushAll();
    const statsAfter = logger.getStats();
    expect(statsAfter.buffered).toBe(0);
    expect(statsAfter.currentFileSize).toBeGreaterThan(0);
  });

  it('rotates the log file once maxFileSize is exceeded', () => {
    const logger = buildLogger({ maxFileSize: 1 });
    logger.info('svc', 'first message, long enough to exceed one byte');
    logger.flushAll();
    logger.info('svc', 'second message triggers rotation');
    logger.flushAll();

    expect(existsSync(`${logFile}.0`)).toBe(true);
  });

  it('falls back to console.error when file writes fail', () => {
    const logger = buildLogger({ logFile: path.join(tmpDir, 'nested', 'deep', 'test.log') });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force a failure by pointing logFile at a directory path (invalid target)
    mkdirSync(path.join(tmpDir, 'nested', 'deep', 'test.log'), { recursive: true });

    logger.info('svc', 'will fail to write');
    logger.flushAll();

    expect(consoleSpy).toHaveBeenCalled();
  });

  it('does not write to file when enableFile is false', () => {
    const logger = buildLogger({ enableFile: false });
    logger.info('svc', 'no file output');
    logger.flushAll();
    expect(existsSync(logFile)).toBe(false);
  });
});
