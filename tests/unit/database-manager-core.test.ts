import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseManager,
  closeDatabaseManager,
  getDatabaseManager,
  initializeDatabaseManager,
} from '../../src/services/database-manager.js';

describe('DatabaseManager core methods', () => {
  async function buildDb(): Promise<DatabaseManager> {
    const db = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await db.initialize();
    db.execDDL('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    return db;
  }

  it('query and queryOne return rows using prepared statements', async () => {
    const db = await buildDb();
    db.execute('INSERT INTO items (id, name) VALUES (?, ?)', [1, 'a']);
    db.execute('INSERT INTO items (id, name) VALUES (?, ?)', [2, 'b']);

    expect(db.query<{ id: number }>('SELECT id FROM items ORDER BY id')).toHaveLength(2);
    expect(db.queryOne<{ name: string }>('SELECT name FROM items WHERE id = ?', [1])?.name).toBe('a');
    expect(db.queryOne('SELECT name FROM items WHERE id = ?', [999])).toBeNull();

    await db.close();
  });

  it('query/queryOne throw when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.query('SELECT 1')).toThrow('Database not initialized');
    expect(() => db.queryOne('SELECT 1')).toThrow('Database not initialized');
  });

  it('transaction commits successful callbacks', async () => {
    const db = await buildDb();
    const result = db.transaction(() => {
      db.execute('INSERT INTO items (id, name) VALUES (1, "x")');
      return 'done';
    });

    expect(result).toBe('done');
    expect(db.query('SELECT * FROM items')).toHaveLength(1);
    await db.close();
  });

  it('transaction rolls back and rethrows on non-transient errors', async () => {
    const db = await buildDb();
    expect(() =>
      db.transaction(() => {
        db.execute('INSERT INTO items (id, name) VALUES (1, "x")');
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(db.query('SELECT * FROM items')).toHaveLength(0);
    await db.close();
  });

  it('transaction retries on transient BUSY-style errors then succeeds is bounded by maxRetries', async () => {
    const db = await buildDb();
    let attempts = 0;

    expect(() =>
      db.transaction(
        () => {
          attempts++;
          throw new Error('database is locked');
        },
        2,
        1
      )
    ).toThrow('database is locked');

    expect(attempts).toBe(2);
    await db.close();
  });

  it('transaction throws when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.transaction(() => 1)).toThrow('Database not initialized');
  });

  it('optimize runs ANALYZE/REINDEX/VACUUM without throwing', async () => {
    const db = await buildDb();
    expect(() => db.optimize()).not.toThrow();
    await db.close();
  });

  it('optimize throws when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.optimize()).toThrow('Database not initialized');
  });

  it('getStats reports table/index counts for an initialized database', async () => {
    const db = await buildDb();
    const stats = db.getStats();
    expect(stats.tableCount).toBeGreaterThanOrEqual(1);
    expect(stats.tables).toContain('items');
    expect(stats.error).toBeUndefined();
    await db.close();
  });

  it('getStats reports an error state when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    const stats = db.getStats();
    expect(stats.error).toBe('Database not initialized');
    expect(stats.tableCount).toBe(0);
  });

  it('healthCheck reports healthy for an initialized database', async () => {
    const db = await buildDb();
    const health = db.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.stats).toBeDefined();
    await db.close();
  });

  it('healthCheck reports unhealthy when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    const health = db.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.error).toBe('Database not initialized');
  });

  it('getDatabase returns the underlying sql.js database once initialized', async () => {
    const db = await buildDb();
    expect(db.getDatabase()).toBeDefined();
    await db.close();
  });

  it('getDatabase throws when not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.getDatabase()).toThrow('Database not initialized');
  });

  it('get/all/run aliases delegate to queryOne/query/execute', async () => {
    const db = await buildDb();
    db.run('INSERT INTO items (id, name) VALUES (1, "alias")');
    expect(db.all<{ name: string }>('SELECT name FROM items')).toHaveLength(1);
    expect(db.get<{ name: string }>('SELECT name FROM items WHERE id = 1')?.name).toBe('alias');
    expect(db.get('SELECT name FROM items WHERE id = 999')).toBeUndefined();
    await db.close();
  });

  it('prepare returns a statement handle for initialized databases', async () => {
    const db = await buildDb();
    const stmt = db.prepare('SELECT 1');
    expect(stmt).toBeDefined();
    stmt.free();
    await db.close();
  });

  it('prepare throws when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.prepare('SELECT 1')).toThrow('Database not initialized');
  });

  it('execDDL executes multiple semicolon-separated statements', async () => {
    const db = await buildDb();
    db.execDDL('CREATE TABLE t1 (id INTEGER); CREATE TABLE t2 (id INTEGER);');
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(['t1', 't2']));
    await db.close();
  });

  it('execDDL throws when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.execDDL('CREATE TABLE t (id INTEGER)')).toThrow('Database not initialized');
  });

  it('execDDL surfaces errors for invalid SQL', async () => {
    const db = await buildDb();
    expect(() => db.execDDL('NOT VALID SQL')).toThrow();
    await db.close();
  });

  it('getQueryMetrics/clearPreparedStatements/getPoolMetrics expose pool state', async () => {
    const db = await buildDb();
    db.query('SELECT 1');
    expect(db.getQueryMetrics().length).toBeGreaterThan(0);
    expect(db.getPoolMetrics()).toBeDefined();
    expect(() => db.clearPreparedStatements()).not.toThrow();
    await db.close();
  });

  it('execute throws when database is not initialized', () => {
    const db = new DatabaseManager({ filename: ':memory:' });
    expect(() => db.execute('SELECT 1')).toThrow('Database not initialized');
  });
});

describe('DatabaseManager singleton helpers', () => {
  afterEach(async () => {
    await closeDatabaseManager();
  });

  it('getDatabaseManager throws before initialization', () => {
    expect(() => getDatabaseManager()).toThrow('Database manager not initialized');
  });

  it('initializeDatabaseManager creates and returns a usable manager', async () => {
    const manager = await initializeDatabaseManager({ filename: ':memory:', options: { readonly: false } });
    expect(manager).toBeInstanceOf(DatabaseManager);
    expect(getDatabaseManager()).toBe(manager);
  });

  it('initializeDatabaseManager closes a previous instance before creating a new one', async () => {
    const first = await initializeDatabaseManager({ filename: ':memory:', options: { readonly: false } });
    const closeSpy = vi.spyOn(first, 'close');
    const second = await initializeDatabaseManager({ filename: ':memory:', options: { readonly: false } });

    expect(closeSpy).toHaveBeenCalled();
    expect(getDatabaseManager()).toBe(second);
  });

  it('closeDatabaseManager is a no-op when nothing was initialized', async () => {
    await closeDatabaseManager();
    expect(() => getDatabaseManager()).toThrow();
  });
});
