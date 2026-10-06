import { describe, expect, it } from 'vitest';
import { formatPatternDetailsText } from '../../src/mcp/pattern-details-formatter.js';
import type { PatternImplementation, PatternRow } from '../../src/mcp/types.js';

function buildPattern(overrides: Partial<PatternRow> = {}): PatternRow {
  return {
    id: 'factory-method',
    name: 'Factory Method',
    category: 'Creational',
    description: 'Creates objects without specifying the exact class.',
    when_to_use: 'When a class cannot anticipate the type of objects it must create',
    benefits: 'Decoupling, Flexibility',
    drawbacks: 'Extra subclasses',
    use_cases: 'Plugin systems',
    complexity: 'Medium',
    tags: 'creational,gof',
    ...overrides,
  };
}

describe('formatPatternDetailsText', () => {
  it('renders core pattern fields', () => {
    const text = formatPatternDetailsText(buildPattern(), []);

    expect(text).toContain('# Factory Method (Creational)');
    expect(text).toContain('**Description:** Creates objects without specifying the exact class.');
    expect(text).toContain('**Benefits:** Decoupling, Flexibility');
    expect(text).toContain('**Complexity:** Medium');
    expect(text).toContain('**Tags:** creational, gof');
  });

  it('falls back to defaults when description/complexity are missing', () => {
    const text = formatPatternDetailsText(
      buildPattern({ description: undefined, complexity: undefined }),
      []
    );

    expect(text).toContain('No description available');
    expect(text).toContain('**Complexity:** Unknown');
  });

  it('renders parsed JSON code examples by language', () => {
    const pattern = buildPattern({
      examples: JSON.stringify({
        typescript: { description: 'Basic usage', code: 'const x = 1;' },
      }),
    });

    const text = formatPatternDetailsText(pattern, []);
    expect(text).toContain('**Code Examples:**');
    expect(text).toContain('### Typescript');
    expect(text).toContain('Basic usage');
    expect(text).toContain('```typescript\nconst x = 1;\n```');
  });

  it('silently skips malformed examples JSON', () => {
    const pattern = buildPattern({ examples: '{not valid json' });
    const text = formatPatternDetailsText(pattern, []);
    expect(text).not.toContain('**Code Examples:**');
  });

  it('appends implementations when provided', () => {
    const implementations: PatternImplementation[] = [
      { language: 'Python', code: 'print(1)', explanation: 'Simple example' },
    ];

    const text = formatPatternDetailsText(buildPattern(), implementations);
    expect(text).toContain('**Implementations:**');
    expect(text).toContain('### Python');
    expect(text).toContain('```python\nprint(1)\n```');
    expect(text).toContain('Simple example');
  });

  it('omits implementations section when list is empty', () => {
    const text = formatPatternDetailsText(buildPattern(), []);
    expect(text).not.toContain('**Implementations:**');
  });
});
