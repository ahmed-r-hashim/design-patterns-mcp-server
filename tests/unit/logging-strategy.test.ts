import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import path from 'path';
import {
  CompositeLoggingStrategy,
  ConsoleLoggingStrategy,
  FileLoggingStrategy,
  Logger,
  LoggerManager,
  LogLevel,
  NullLoggingStrategy,
  StructuredLoggingStrategy,
  createConsoleLogger,
  createFileLogger,
  createProductionLogger,
  type LogEntry,
} from '../../src/strategies/logging-strategy.js';

function buildEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: LogLevel.INFO,
    service: 'svc',
    message: 'hello',
    ...overrides,
  };
}

describe('ConsoleLoggingStrategy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes formatted entries to stderr and tracks stats', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const strategy = new ConsoleLoggingStrategy();

    strategy.log(buildEntry({ data: { a: 1 }, correlationId: 'c1', duration: 5 }));
    strategy.log(buildEntry({ level: LogLevel.ERROR, error: new Error('boom') }));

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(strategy.getStats().entriesLogged).toBe(2);
    expect(writeSpy.mock.calls[0][0]).toContain('[c1]');
    expect(writeSpy.mock.calls[1][0]).toContain('Error: boom');
  });

  it('applies ANSI color when stderr is a TTY', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const strategy = new ConsoleLoggingStrategy();

    strategy.log(buildEntry({ level: LogLevel.FATAL }));
    expect(writeSpy.mock.calls[0][0]).toContain('\x1b[35m');

    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
  });
});

describe('FileLoggingStrategy', () => {
  const tmpDir = path.join(process.cwd(), 'temp', 'logging-strategy-fixtures');
  const logFile = path.join(tmpDir, 'test.log');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('buffers entries and flushes automatically once bufferSize is reached', () => {
    const strategy = new FileLoggingStrategy(logFile);
    for (let i = 0; i < 10; i++) {
      strategy.log(buildEntry({ message: `msg-${i}` }));
    }

    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(strategy.getStats().entriesLogged).toBe(10);
  });

  it('flush() is a no-op when the buffer is empty', () => {
    const strategy = new FileLoggingStrategy(logFile);
    strategy.flush();
    expect(existsSync(logFile)).toBe(false);
  });

  it('creates the log directory if missing', () => {
    const nestedFile = path.join(tmpDir, 'nested', 'deep', 'test.log');
    const strategy = new FileLoggingStrategy(nestedFile);
    strategy.log(buildEntry());
    strategy.flush();
    expect(existsSync(nestedFile)).toBe(true);
  });

  it('serializes error details into the JSON entry', () => {
    const strategy = new FileLoggingStrategy(logFile);
    strategy.log(buildEntry({ error: new Error('bad thing') }));
    strategy.flush();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('"message":"bad thing"');
  });

  it('falls back to console.error when the write fails', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Point logFile at a directory to force appendFileSync to fail
    const badPath = path.join(tmpDir, 'is-a-dir');
    mkdirSync(badPath, { recursive: true });
    const strategy = new FileLoggingStrategy(badPath);

    strategy.log(buildEntry());
    strategy.flush();

    expect(consoleSpy).toHaveBeenCalledWith('Failed to write to log file:', expect.anything());
  });

  it('rotates files once maxFileSize is exceeded', () => {
    const strategy = new FileLoggingStrategy(logFile, 1, 3);
    strategy.log(buildEntry({ message: 'first write large enough to exceed one byte' }));
    strategy.flush();
    strategy.log(buildEntry({ message: 'second write triggers rotation' }));
    strategy.flush();

    expect(existsSync(`${logFile}.1`)).toBe(true);
  });

  it('shifts multiple rotated files and removes the oldest', () => {
    const strategy = new FileLoggingStrategy(logFile, 1, 2);
    // Pre-seed an existing rotated file so the shift path is exercised.
    writeFileSync(`${logFile}.1`, 'old-1');

    strategy.log(buildEntry({ message: 'triggers rotation again' }));
    strategy.flush();

    // .1 should now hold the just-rotated current file, old .1 shifted away.
    expect(existsSync(`${logFile}.1`)).toBe(true);
  });
});

describe('StructuredLoggingStrategy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes structured JSON with environment/version metadata to stderr', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const strategy = new StructuredLoggingStrategy();

    strategy.log(buildEntry({ error: new Error('x') }));

    const payload = JSON.parse((writeSpy.mock.calls[0][0] as string).trim()) as {
      level: string;
      environment: string;
    };
    expect(payload.level).toBe('info');
    expect(payload.environment).toBeDefined();
    expect(strategy.getStats().entriesLogged).toBe(1);
  });
});

describe('NullLoggingStrategy', () => {
  it('tracks entry counts without producing output', () => {
    const strategy = new NullLoggingStrategy();
    strategy.log(buildEntry());
    strategy.log(buildEntry());
    expect(strategy.getStats().entriesLogged).toBe(2);
  });
});

describe('CompositeLoggingStrategy', () => {
  it('fans out log() and flush() to all added strategies', () => {
    const composite = new CompositeLoggingStrategy();
    const a = new NullLoggingStrategy();
    const flushSpy = vi.fn();
    const b: { log: typeof a.log; flush: () => void; getStats: () => { entriesLogged: number } } = {
      log: vi.fn(),
      flush: flushSpy,
      getStats: () => ({ entriesLogged: 0 }),
    };

    composite.addStrategy(a);
    composite.addStrategy(b);
    composite.log(buildEntry());
    composite.flush();

    expect(b.log).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(composite.getStats().entriesLogged).toBe(1);
    expect(composite.getStats().strategies).toHaveLength(2);
  });

  it('removeStrategy stops forwarding to a removed strategy', () => {
    const composite = new CompositeLoggingStrategy();
    const a = new NullLoggingStrategy();
    composite.addStrategy(a);
    composite.removeStrategy(a);
    composite.log(buildEntry());
    expect(composite.getStats().strategies).toHaveLength(0);
  });

  it('removeStrategy is a no-op for a strategy that was never added', () => {
    const composite = new CompositeLoggingStrategy();
    const a = new NullLoggingStrategy();
    expect(() => composite.removeStrategy(a)).not.toThrow();
  });
});

describe('LoggerManager + Logger', () => {
  it('filters entries below the configured minimum level', () => {
    const manager = new LoggerManager(LogLevel.WARN);
    const strategy = new NullLoggingStrategy();
    manager.addStrategy(strategy);

    manager.log(buildEntry({ level: LogLevel.DEBUG }));
    manager.log(buildEntry({ level: LogLevel.WARN }));

    expect(strategy.getStats().entriesLogged).toBe(1);
  });

  it('setMinLevel updates the active filtering threshold', () => {
    const manager = new LoggerManager(LogLevel.ERROR);
    const strategy = new NullLoggingStrategy();
    manager.addStrategy(strategy);
    manager.setMinLevel(LogLevel.DEBUG);

    manager.log(buildEntry({ level: LogLevel.DEBUG }));
    expect(strategy.getStats().entriesLogged).toBe(1);
  });

  it('removeStrategy detaches a strategy from the manager', () => {
    const manager = new LoggerManager();
    const strategy = new NullLoggingStrategy();
    manager.addStrategy(strategy);
    manager.removeStrategy(strategy);
    manager.log(buildEntry());
    expect(strategy.getStats().entriesLogged).toBe(0);
  });

  it('getStats reports strategy count, min level, and nested stats', () => {
    const manager = new LoggerManager(LogLevel.INFO, 'svc');
    manager.addStrategy(new NullLoggingStrategy());
    const stats = manager.getStats();
    expect(stats.strategies).toBe(1);
    expect(stats.minLevel).toBe('INFO');
    expect(stats.strategyStats).toHaveLength(1);
  });

  it('flush() forwards to strategies supporting flush', () => {
    const manager = new LoggerManager();
    const flushSpy = vi.fn();
    manager.addStrategy({ log: vi.fn(), flush: flushSpy });
    manager.flush();
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('Logger.debug/info/warn/error/fatal/timing all forward through the manager', () => {
    const manager = new LoggerManager(LogLevel.DEBUG);
    const strategy = new NullLoggingStrategy();
    manager.addStrategy(strategy);
    const logger = manager.createLogger('svc');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e', new Error('x'));
    logger.fatal('f', new Error('y'));
    logger.timing('op', 10, { foo: 'bar' });

    expect(strategy.getStats().entriesLogged).toBe(6);
  });

  it('Logger.child() creates a logger bound to a different service name', () => {
    const manager = new LoggerManager(LogLevel.DEBUG);
    const captured: LogEntry[] = [];
    manager.addStrategy({ log: (e: LogEntry) => captured.push(e) });
    const logger = manager.createLogger('parent');
    const child = logger.child('child');

    child.info('from child');
    expect(captured[0].service).toBe('child');
  });

  it("defaults service name to 'unknown' when none is provided", () => {
    const manager = new LoggerManager(LogLevel.DEBUG);
    const captured: LogEntry[] = [];
    manager.addStrategy({ log: (e: LogEntry) => captured.push(e) });
    const logger = manager.createLogger();

    logger.info('no service');
    expect(captured[0].service).toBe('unknown');
  });
});

describe('factory functions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createConsoleLogger wires a console strategy', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createConsoleLogger('svc');
    logger.info('hello');
    expect(writeSpy).toHaveBeenCalled();
  });

  it('createFileLogger wires a file strategy', () => {
    const tmpDir = path.join(process.cwd(), 'temp', 'logging-strategy-factory');
    mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, 'out.log');
    const logger = createFileLogger(file, 'svc');
    for (let i = 0; i < 10; i++) logger.info(`m${i}`);
    expect(existsSync(file)).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createProductionLogger wires console + structured (+file when provided)', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createProductionLogger(undefined, 'svc');
    logger.info('prod log');
    // console + structured = 2 writes per log call
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });
});
