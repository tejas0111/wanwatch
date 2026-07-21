import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../metrics.js';

describe('MetricsCollector', () => {
  it('should start with zero metrics', () => {
    const metrics = new MetricsCollector();
    const summary = metrics.summarize();
    expect(summary.attempted).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.totalGasUsed).toBe(BigInt(0));
  });

  it('should record a successful renewal', () => {
    const metrics = new MetricsCollector();
    metrics.recordStart('vault-1');
    metrics.recordSuccess({ vaultId: 'vault-1', digest: '0xabc', gasUsed: BigInt(1000), alerts: [] });

    const summary = metrics.summarize();
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.totalGasUsed).toBe(BigInt(1000));
  });

  it('should record a failed renewal', () => {
    const metrics = new MetricsCollector();
    metrics.recordStart('vault-2');
    metrics.recordFailure('vault-2', new Error('RPC error'));

    const summary = metrics.summarize();
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it('should track multiple renewals', () => {
    const metrics = new MetricsCollector();

    metrics.recordStart('vault-1');
    metrics.recordSuccess({ vaultId: 'vault-1', digest: '0x1', gasUsed: BigInt(500), alerts: [] });

    metrics.recordStart('vault-2');
    metrics.recordSuccess({ vaultId: 'vault-2', digest: '0x2', gasUsed: BigInt(300), alerts: [] });

    metrics.recordStart('vault-3');
    metrics.recordFailure('vault-3', new Error('timeout'));

    const summary = metrics.summarize();
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.totalGasUsed).toBe(BigInt(800));
  });

  it('should reset after summarizing', () => {
    const metrics = new MetricsCollector();

    metrics.recordStart('vault-1');
    metrics.recordSuccess({ vaultId: 'vault-1', digest: '0x1', gasUsed: BigInt(500), alerts: [] });

    metrics.reset();

    const summary = metrics.summarize();
    expect(summary.attempted).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.totalGasUsed).toBe(BigInt(0));
  });

  it('should clear start times after recording success', () => {
    const metrics = new MetricsCollector();
    metrics.recordStart('vault-1');
    metrics.recordSuccess({ vaultId: 'vault-1', digest: '0x1', gasUsed: BigInt(500), alerts: [] });

    const summary = metrics.summarize();
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
  });
});
