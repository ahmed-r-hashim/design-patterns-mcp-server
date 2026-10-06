import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { DatabaseManager } from '../../src/services/database-manager.js';
import { MigrationManager } from '../../src/services/migrations.js';
import { RelationshipIntegrityChecker } from '../../src/services/relationship-integrity-checker.js';

describe('RelationshipIntegrityChecker', () => {
  let dbManager: DatabaseManager;
  let checker: RelationshipIntegrityChecker;

  beforeAll(async () => {
    dbManager = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await dbManager.initialize();

    const migrationManager = new MigrationManager(dbManager, './migrations');
    migrationManager.initialize();
    const result = await migrationManager.migrate();
    if (!result.success) {
      throw new Error(`Migration failed: ${result.message}`);
    }

    dbManager.execute(
      `INSERT INTO patterns (id, name, category, description, complexity) VALUES
        ('factory-method', 'Factory Method', 'Creational', 'desc', 'Medium'),
        ('singleton', 'Singleton', 'Creational', 'desc', 'Low'),
        ('observer', 'Observer', 'Behavioral', 'desc', 'Medium')`
    );

    checker = new RelationshipIntegrityChecker(dbManager);
  });

  afterAll(async () => {
    await dbManager.close();
  });

  it('reports valid when all relationships reference existing patterns', async () => {
    dbManager.execute(
      `INSERT INTO pattern_relationships (id, source_pattern_id, target_pattern_id, type, description)
       VALUES ('rel-1', 'factory-method', 'singleton', 'related_to', 'desc')`
    );

    const result = await checker.checkIntegrity();

    expect(result.valid).toBe(true);
    expect(result.totalPatterns).toBe(3);
    expect(result.totalRelationships).toBeGreaterThanOrEqual(1);
    expect(result.brokenReferences).toHaveLength(0);
  });

  it('detects broken references to non-existent target patterns', async () => {
    dbManager.execute('PRAGMA foreign_keys = OFF');
    dbManager.execute(
      `INSERT INTO pattern_relationships (id, source_pattern_id, target_pattern_id, type, description)
       VALUES ('rel-broken', 'observer', 'does-not-exist', 'related_to', 'desc')`
    );
    dbManager.execute('PRAGMA foreign_keys = ON');

    const result = await checker.checkIntegrity();

    expect(result.valid).toBe(false);
    const broken = result.brokenReferences.find(r => r.targetPatternId === 'does-not-exist');
    expect(broken).toBeDefined();
    expect(broken?.sourcePatternName).toBe('Observer');
  });

  it('detects duplicate relationships', async () => {
    dbManager.execute(
      `INSERT INTO pattern_relationships (id, source_pattern_id, target_pattern_id, type, description)
       VALUES ('rel-dup', 'factory-method', 'singleton', 'related_to', 'desc')`
    );

    const result = await checker.checkIntegrity();
    const dup = result.duplicateRelationships.find(
      d => d.sourcePatternId === 'factory-method' && d.targetPatternId === 'singleton'
    );
    expect(dup).toBeDefined();
    expect(dup?.count).toBeGreaterThanOrEqual(2);
  });

  it('formatReport renders a valid report without issues', async () => {
    const freshDb = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await freshDb.initialize();
    const mm = new MigrationManager(freshDb, './migrations');
    mm.initialize();
    await mm.migrate();
    freshDb.execute(
      `INSERT INTO patterns (id, name, category, description, complexity) VALUES ('a', 'A', 'Cat', 'd', 'Low')`
    );
    const freshChecker = new RelationshipIntegrityChecker(freshDb);
    const result = await freshChecker.checkIntegrity();

    const report = freshChecker.formatReport(result);
    expect(report).toContain('PATTERN RELATIONSHIP INTEGRITY REPORT');
    expect(report).toContain('All relationships are valid');
    await freshDb.close();
  });

  it('formatReport renders broken references and duplicates', () => {
    const report = checker.formatReport({
      valid: false,
      totalPatterns: 2,
      totalRelationships: 2,
      brokenReferences: [
        {
          sourcePatternId: 'a',
          sourcePatternName: 'A',
          targetPatternId: 'missing',
          relationshipType: 'uses',
          fileName: 'a.json',
        },
      ],
      duplicateRelationships: [
        { sourcePatternId: 'a', targetPatternId: 'b', type: 'uses', count: 2 },
      ],
      duration: 5,
    });

    expect(report).toContain('Issues found');
    expect(report).toContain('BROKEN REFERENCES');
    expect(report).toContain('a -> missing');
    expect(report).toContain('DUPLICATE RELATIONSHIPS');
    expect(report).toContain('a -> b (uses)');
  });

  it('checkIntegrity rejects when the query throws', async () => {
    const failingDb = {
      query: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    } as unknown as DatabaseManager;
    const failingChecker = new RelationshipIntegrityChecker(failingDb);

    await expect(failingChecker.checkIntegrity()).rejects.toThrow('boom');
  });

  describe('checkFileIntegrity', () => {
    const tmpDir = path.join(process.cwd(), 'temp', 'integrity-checker-fixtures');

    beforeAll(() => {
      mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('flags relationships pointing to patterns missing from both file and db', async () => {
      const filePath = path.join(tmpDir, 'sample-pattern.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          id: 'factory-method',
          relationships: [{ target_pattern_id: 'nonexistent-pattern', type: 'related_to' }],
        })
      );

      const result = await checker.checkFileIntegrity([filePath]);
      expect(result.brokenReferences).toHaveLength(1);
      expect(result.brokenReferences[0].targetPatternId).toBe('nonexistent-pattern');
      expect(result.brokenReferences[0].sourcePatternId).toBe('factory-method');
    });

    it('does not flag relationships that resolve within the same file', async () => {
      const filePath = path.join(tmpDir, 'multi-pattern.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          patterns: [
            { id: 'p1', relationships: [{ targetPatternId: 'p2', type: 'uses' }] },
            { id: 'p2' },
          ],
        })
      );

      const result = await checker.checkFileIntegrity([filePath]);
      expect(result.brokenReferences).toHaveLength(0);
    });

    it('does not flag relationships that resolve against the database', async () => {
      const filePath = path.join(tmpDir, 'db-resolved.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          id: 'observer',
          relationships: [{ target_pattern_id: 'singleton', type: 'related_to' }],
        })
      );

      const result = await checker.checkFileIntegrity([filePath]);
      expect(result.brokenReferences).toHaveLength(0);
    });
  });

  describe('fixBrokenReferences', () => {
    it('removes broken references and reports counts', async () => {
      const fixDb = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
      await fixDb.initialize();
      const mm = new MigrationManager(fixDb, './migrations');
      mm.initialize();
      await mm.migrate();
      fixDb.execute(
        `INSERT INTO patterns (id, name, category, description, complexity) VALUES ('a', 'A', 'Cat', 'd', 'Low')`
      );
      fixDb.execute('PRAGMA foreign_keys = OFF');
      fixDb.execute(
        `INSERT INTO pattern_relationships (id, source_pattern_id, target_pattern_id, type, description)
         VALUES ('rel-broken', 'a', 'missing-pattern', 'uses', 'desc')`
      );
      fixDb.execute('PRAGMA foreign_keys = ON');

      const fixChecker = new RelationshipIntegrityChecker(fixDb);
      const fixResult = await fixChecker.fixBrokenReferences();

      expect(fixResult.fixed).toBe(1);
      expect(fixResult.failed).toBe(0);
      expect(fixResult.errors).toHaveLength(0);

      const after = await fixChecker.checkIntegrity();
      expect(after.valid).toBe(true);

      await fixDb.close();
    });
  });
});
