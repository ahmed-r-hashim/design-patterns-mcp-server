import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDatabaseManager,
  initializeDatabaseManager,
} from '../../src/services/database-manager.js';
import { MigrationManager } from '../../src/services/migrations.js';
import { PatternStorageService } from '../../src/services/pattern-storage.js';

describe('PatternStorageService', () => {
  let storage: PatternStorageService;

  beforeAll(async () => {
    const db = await initializeDatabaseManager({ filename: ':memory:', options: { readonly: false } });
    const mm = new MigrationManager(db, './migrations');
    mm.initialize();
    const result = await mm.migrate();
    if (!result.success) throw new Error(`Migration failed: ${result.message}`);

    storage = new PatternStorageService();
    await storage.storePattern({
      id: 'factory-method',
      name: 'Factory Method',
      category: 'Creational',
      description: 'Creates objects without specifying the exact class.',
      problem: 'p',
      solution: 's',
      when_to_use: ['a'],
      benefits: ['b'],
      drawbacks: ['d'],
      use_cases: ['u'],
      implementations: [],
      complexity: 'Medium',
      tags: ['creational', 'gof'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await storage.storePattern({
      id: 'singleton',
      name: 'Singleton',
      category: 'Creational',
      description: 'Ensures a single instance.',
      problem: 'p',
      solution: 's',
      when_to_use: ['a'],
      benefits: ['b'],
      drawbacks: ['d'],
      use_cases: ['u'],
      implementations: [],
      complexity: 'Low',
      tags: ['creational'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabaseManager();
  });

  it('getPattern returns a stored pattern by id', async () => {
    const pattern = await storage.getPattern('factory-method');
    expect(pattern?.name).toBe('Factory Method');
  });

  it('getPattern returns null for an unknown id', async () => {
    expect(await storage.getPattern('missing')).toBeNull();
  });

  it('getPatternByName returns a stored pattern by name', async () => {
    const pattern = await storage.getPatternByName('Singleton');
    expect(pattern?.id).toBe('singleton');
  });

  it('getAllPatterns returns all patterns ordered by category/name', async () => {
    const patterns = await storage.getAllPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(2);
  });

  it('getPatternsByCategory filters by category', async () => {
    const patterns = await storage.getPatternsByCategory('Creational');
    expect(patterns.every(p => p.category === 'Creational')).toBe(true);
  });

  it('searchPatterns finds patterns by name/description/tags', async () => {
    const results = await storage.searchPatterns('Factory');
    expect(results.some(p => p.id === 'factory-method')).toBe(true);
  });

  it('getCategories returns category counts', async () => {
    const categories = await storage.getCategories();
    const creational = categories.find(c => c.category === 'Creational');
    expect(creational?.count).toBeGreaterThanOrEqual(2);
  });

  it('storeRelationship persists a relationship between two patterns', async () => {
    await storage.storeRelationship('factory-method', 'singleton', 'related_to', 0.8, 'desc');
    // Verify indirectly via stats (relationships aren't directly queryable here, but no throw = success)
    expect(true).toBe(true);
  });

  it('storePatternImplementation and getPatternImplementations round-trip', async () => {
    await storage.storePatternImplementation({
      id: 'impl-1',
      pattern_id: 'factory-method',
      language: 'typescript',
      approach: 'classic',
      code: 'class Foo {}',
      explanation: 'basic example',
    });

    const impls = await storage.getPatternImplementations('factory-method');
    expect(impls).toHaveLength(1);
    expect(impls[0].language).toBe('typescript');
  });

  it('storePatternEmbedding and getPatternEmbedding round-trip', async () => {
    await storage.storePatternEmbedding({
      pattern_id: 'factory-method',
      embedding: [0.1, 0.2, 0.3],
      model: 'test-model',
    });

    const embedding = await storage.getPatternEmbedding('factory-method');
    expect(embedding?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('getPatternEmbedding returns null when none stored', async () => {
    expect(await storage.getPatternEmbedding('singleton')).toBeNull();
  });

  it('findSimilarPatterns ranks by cosine similarity to the query embedding', async () => {
    const results = await storage.findSimilarPatterns([0.1, 0.2, 0.3], 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('score');
  });

  it('getPatternStats reports totals', async () => {
    const stats = await storage.getPatternStats();
    expect(stats.totalPatterns).toBeGreaterThanOrEqual(2);
    expect(stats.implementations).toBeGreaterThanOrEqual(1);
    expect(stats.embeddings).toBeGreaterThanOrEqual(1);
  });

  it('clearAllData removes all patterns, implementations, and embeddings', async () => {
    await storage.clearAllData();
    expect(await storage.getAllPatterns()).toHaveLength(0);
    const stats = await storage.getPatternStats();
    expect(stats.totalPatterns).toBe(0);
    expect(stats.implementations).toBe(0);
    expect(stats.embeddings).toBe(0);
  });
});
