/**
 * Metrics Collector
 *
 * Tracks keeper performance metrics per scan cycle:
 * - Renewals attempted / succeeded / failed
 * - Fee revenue collected
 * - Latency vs due time
 */

import type { RenewalResult } from './executor.js';

export interface MetricsSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  totalGasUsed: bigint;
  avgLatencyMs: number;
}

export class MetricsCollector {
  private results: RenewalResult[] = [];
  private errors: Map<string, Error> = new Map();
  private startTimes: Map<string, number> = new Map();

  recordStart(vaultId: string): void {
    this.startTimes.set(vaultId, Date.now());
  }

  recordSuccess(result: RenewalResult): void {
    this.results.push(result);
    this.startTimes.delete(result.vaultId);
  }

  recordFailure(vaultId: string, error: Error): void {
    this.errors.set(vaultId, error);
    this.startTimes.delete(vaultId);
  }

  summarize(): MetricsSummary {
    const totalGasUsed = this.results.reduce(
      (sum, r) => sum + r.gasUsed,
      BigInt(0),
    );

    return {
      attempted: this.results.length + this.errors.size,
      succeeded: this.results.length,
      failed: this.errors.size,
      totalGasUsed,
      avgLatencyMs: 0, // TODO: calculate from startTimes
    };
  }

  reset(): void {
    this.results = [];
    this.errors.clear();
    this.startTimes.clear();
  }
}
