import { ScreeningMetrics, CostEstimate } from '../types.js';
import { estimateCost, estimateTokens, Provider, SERPER_COST_PER_QUERY } from './costs.js';

export class MetricsTracker {
  private metrics: ScreeningMetrics;

  constructor(subject: string) {
    this.metrics = {
      runId: `${this.sanitizeName(subject)}-${Date.now()}`,
      subject,
      startTime: new Date().toISOString(),
      queriesExecuted: 0,
      totalSearchResults: 0,
      uniqueUrlsProcessed: 0,
      duplicatesSkipped: 0,
      triageRed: 0,
      triageYellow: 0,
      triageGreen: 0,
      fetchAttempted: 0,
      fetchSucceeded: 0,
      fetchFailed: 0,
      analysisCompleted: 0,
      findingsRed: 0,
      findingsAmber: 0,
      totalCleared: 0,
      consolidationRatio: 0,
      costs: [],
      totalCostUSD: 0,
    };
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  }

  getRunId(): string {
    return this.metrics.runId;
  }

  // Search tracking
  recordQuery(resultsFound: number): void {
    this.metrics.queriesExecuted++;
    this.metrics.totalSearchResults += resultsFound;
    this.metrics.totalCostUSD += SERPER_COST_PER_QUERY;
  }

  restoreQueryCount(count: number): void {
    this.metrics.queriesExecuted = count;
  }

  recordUrlProcessed(isDuplicate: boolean): void {
    if (isDuplicate) {
      this.metrics.duplicatesSkipped++;
    } else {
      this.metrics.uniqueUrlsProcessed++;
    }
  }

  // Triage tracking
  recordTriage(red: number, yellow: number, green: number): void {
    this.metrics.triageRed += red;
    this.metrics.triageYellow += yellow;
    this.metrics.triageGreen += green;
  }

  // Fetch tracking
  recordFetch(success: boolean): void {
    this.metrics.fetchAttempted++;
    if (success) {
      this.metrics.fetchSucceeded++;
    } else {
      this.metrics.fetchFailed++;
    }
  }

  // Analysis tracking
  recordAnalysis(isAdverse: boolean, severity?: 'RED' | 'AMBER'): void {
    this.metrics.analysisCompleted++;
    if (isAdverse && severity === 'RED') {
      this.metrics.findingsRed++;
    } else if (isAdverse && severity === 'AMBER') {
      this.metrics.findingsAmber++;
    } else {
      this.metrics.totalCleared++;
    }
  }

  // Consolidation tracking
  recordConsolidation(beforeCount: number, afterCount: number): void {
    this.metrics.consolidationRatio = afterCount > 0 ? beforeCount / afterCount : 0;
  }

  // Cost tracking
  recordLLMCall(
    provider: Provider,
    operation: CostEstimate['operation'],
    inputText: string,
    outputText: string
  ): void {
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);
    const cost = estimateCost(provider, inputTokens, outputTokens);

    this.metrics.costs.push({
      provider,
      operation,
      inputTokens,
      outputTokens,
      estimatedCostUSD: cost,
    });

    this.metrics.totalCostUSD = Math.round(
      this.metrics.costs.reduce((sum, c) => sum + c.estimatedCostUSD, 0) * 1_000_000
    ) / 1_000_000;
  }

  // Finalize
  finalize(): ScreeningMetrics {
    this.metrics.endTime = new Date().toISOString();
    this.metrics.durationMs =
      new Date(this.metrics.endTime).getTime() -
      new Date(this.metrics.startTime).getTime();
    return this.metrics;
  }

  getMetrics(): ScreeningMetrics {
    return { ...this.metrics };
  }
}
