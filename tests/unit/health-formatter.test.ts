import { describe, expect, it } from 'vitest';
import { formatHealthReportText } from '../../src/mcp/health-formatter.js';
import { HealthStatus } from '../../src/health/types.js';
import type { HealthReport } from '../../src/health/types.js';

function buildReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    overall: HealthStatus.HEALTHY,
    timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    duration: 12.345,
    checks: [
      {
        name: 'database',
        status: HealthStatus.HEALTHY,
        message: 'All good',
        timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        duration: 5.6,
      },
    ],
    summary: { total: 1, healthy: 1, degraded: 0, unhealthy: 0, unknown: 0 },
    ...overrides,
  };
}

describe('formatHealthReportText', () => {
  it('renders overall status, summary, and check list', () => {
    const text = formatHealthReportText(buildReport());

    expect(text).toContain('System Health Report');
    expect(text).toContain('HEALTHY');
    expect(text).toContain('Total Checks:** 1');
    expect(text).toContain('**database**');
    expect(text).toContain('Status:** HEALTHY');
    expect(text).toContain('Duration:** 6ms');
    expect(text).toContain('Message:** All good');
  });

  it('includes details as JSON when present', () => {
    const report = buildReport({
      checks: [
        {
          name: 'vector-ops',
          status: HealthStatus.DEGRADED,
          message: 'Slow',
          timestamp: new Date().toISOString(),
          duration: 1,
          details: { latencyMs: 900 },
        },
      ],
    });

    const text = formatHealthReportText(report);
    expect(text).toContain('**Details:**');
    expect(text).toContain('"latencyMs": 900');
  });

  it('includes tags when present on a check', () => {
    const report = buildReport({
      checks: [
        {
          name: 'llm-bridge',
          status: HealthStatus.UNKNOWN,
          message: 'Not configured',
          timestamp: new Date().toISOString(),
          duration: 0,
          tags: ['optional', 'llm'],
        },
      ],
    });

    const text = formatHealthReportText(report);
    expect(text).toContain('**Tags:** optional, llm');
  });

  it('omits tags line when a check has no tags', () => {
    const text = formatHealthReportText(buildReport());
    expect(text).not.toContain('**Tags:**');
  });
});
