import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ScreeningMetrics, BenchmarkResult, FunnelSnapshot } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base paths
const LOGS_DIR = path.join(__dirname, '../../logs');
const SCREENINGS_DIR = path.join(LOGS_DIR, 'screenings');
const METRICS_DIR = path.join(LOGS_DIR, 'metrics');
const BENCHMARKS_DIR = path.join(LOGS_DIR, 'benchmarks');

// Ensure directories exist
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Initialize all log directories
export function initLogDirectories(): void {
  ensureDir(SCREENINGS_DIR);
  ensureDir(METRICS_DIR);
  ensureDir(BENCHMARKS_DIR);
}

// Save screening log
export function saveScreeningLog(
  subject: string,
  runId: string,
  data: {
    metrics: ScreeningMetrics;
    findings: any[];
    eventLog: any[];
    triageLog?: any[];
    urlTracker?: {
      gathered: any[];
      programmaticElimination?: {
        passed: any[];
        bypassed: any[];
        eliminated: {
          noise_domain: any[];
          noise_title_pattern: any[];
          name_char_separation: any[];
          missing_dirty_word: any[];
        };
      };
      categorized: { red: any[]; amber: any[]; green: any[] };
      eliminated: any[];
      processed: any[];
    };
  }
): string {
  const sanitizedSubject = subject.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  const subjectDir = path.join(SCREENINGS_DIR, sanitizedSubject);
  ensureDir(subjectDir);

  const filename = `${runId}.json`;
  const filepath = path.join(subjectDir, filename);

  const logData = {
    runId,
    subject,
    savedAt: new Date().toISOString(),
    ...data,
  };

  fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
  return filepath;
}

// Load screening log
export function loadScreeningLog(subject: string, runId: string): any | null {
  const sanitizedSubject = subject.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  const filepath = path.join(SCREENINGS_DIR, sanitizedSubject, `${runId}.json`);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// List all screening logs for a subject
export function listScreeningLogs(subject?: string): { subject: string; runId: string; savedAt: string }[] {
  ensureDir(SCREENINGS_DIR);

  const results: { subject: string; runId: string; savedAt: string }[] = [];

  const subjects = subject
    ? [subject.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')]
    : fs.readdirSync(SCREENINGS_DIR).filter(f =>
        fs.statSync(path.join(SCREENINGS_DIR, f)).isDirectory()
      );

  for (const subj of subjects) {
    const subjDir = path.join(SCREENINGS_DIR, subj);
    if (!fs.existsSync(subjDir)) continue;

    const files = fs.readdirSync(subjDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(subjDir, file), 'utf8'));
        results.push({
          subject: data.subject || subj,
          runId: data.runId || file.replace('.json', ''),
          savedAt: data.savedAt || data.metrics?.startTime || 'unknown',
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// Save daily metrics aggregate
export function saveDailyMetrics(date: string, metrics: ScreeningMetrics[]): void {
  ensureDir(path.join(METRICS_DIR, 'daily'));
  const filepath = path.join(METRICS_DIR, 'daily', `${date}.json`);

  const aggregate = {
    date,
    screeningCount: metrics.length,
    totalCostUSD: metrics.reduce((sum, m) => sum + m.totalCostUSD, 0),
    totalQueries: metrics.reduce((sum, m) => sum + m.queriesExecuted, 0),
    totalFindings: metrics.reduce((sum, m) => sum + m.findingsRed + m.findingsAmber, 0),
    metrics,
  };

  fs.writeFileSync(filepath, JSON.stringify(aggregate, null, 2));
}

// Save benchmark result
export function saveBenchmarkResult(result: BenchmarkResult): void {
  ensureDir(path.join(BENCHMARKS_DIR, 'results'));
  const filename = `${result.timestamp.split('T')[0]}-${result.subject.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.json`;
  const filepath = path.join(BENCHMARKS_DIR, 'results', filename);

  fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
}

// Load benchmark results
export function loadBenchmarkResults(subject?: string): BenchmarkResult[] {
  const resultsDir = path.join(BENCHMARKS_DIR, 'results');
  ensureDir(resultsDir);

  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
  const results: BenchmarkResult[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
      if (!subject || data.subject === subject) {
        results.push(data);
      }
    } catch {
      // Skip invalid files
    }
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Save funnel snapshot for benchmark tracing
export function saveFunnelSnapshot(snapshot: FunnelSnapshot): void {
  ensureDir(path.join(BENCHMARKS_DIR, 'funnels'));
  const safeName = snapshot.subject.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  const filename = `${snapshot.timestamp.split('T')[0]}-${safeName}.json`;
  const filepath = path.join(BENCHMARKS_DIR, 'funnels', filename);
  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  console.log(`[BENCHMARK] Funnel snapshot saved: ${filepath}`);
}
