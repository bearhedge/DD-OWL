import { pool } from './db/index.js';

// --- Init ---

export async function initReportsDb(): Promise<void> {
  await pool.query(SCHEMA);

  // Migrations for existing databases (safe to run repeatedly)
  const migrations = [
    'ALTER TABLE dd_reports ADD COLUMN IF NOT EXISTS clean_results_json TEXT',
    'ALTER TABLE dd_reports ADD COLUMN IF NOT EXISTS screening_stats_json TEXT',
    'ALTER TABLE dd_reports ADD COLUMN IF NOT EXISTS quality_rating INTEGER',
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }
}

// --- Types ---

export interface CleanEntityResult {
  url: string;
  title: string;
  snippet: string;
}

export interface ScreeningStats {
  gathered: number;
  programmaticElimination: { before: number; after: number; eliminated: number; govBypassed: number };
  categorized: { red: number; amber: number; green: number };
  processed: { total: number; adverse: number; cleared: number; failed: number };
  consolidated: { before: number; after: number };
}

export interface SaveReportInput {
  runId: string;
  subjectName: string;
  screenedAt: string;
  language: string;
  nameVariations: string[];
  findings: {
    severity: 'RED' | 'AMBER' | 'REVIEW';
    headline: string;
    eventType: string;
    summary: string;
    dateRange?: string;
    sourceCount: number;
    sourceUrls: { url: string; title: string }[];
  }[];
  cleanResults?: Record<string, CleanEntityResult[]>;
  screeningStats?: ScreeningStats;
  reportMarkdown?: string;
  costUsd: number;
  durationMs: number;
  queriesExecuted: number;
  totalSearchResults: number;
}

export interface ReportRow {
  id: number;
  run_id: string;
  subject_name: string;
  screened_at: string;
  language: string;
  name_variations: string;
  finding_count: number;
  red_count: number;
  amber_count: number;
  report_markdown: string | null;
  clean_results_json: string | null;
  screening_stats_json: string | null;
  edited_markdown: string | null;
  edit_distance: number | null;
  quality_rating: number | null;
  cost_usd: number;
  duration_ms: number;
  queries_executed: number;
  total_search_results: number;
  created_at: string;
  findings: FindingRow[];
  missed_flags: MissedFlagRow[];
}

export interface FindingRow {
  id: number;
  report_id: number;
  severity: string;
  headline: string;
  event_type: string;
  summary: string;
  date_range: string | null;
  source_count: number;
  source_urls: string;
  included_in_report: number;
  human_verdict: string | null;
  wrong_reason: string | null;
}

export interface MissedFlagRow {
  id: number;
  report_id: number;
  description: string;
  severity: string;
  event_type: string | null;
}

export interface SourceRow {
  domain: string;
  times_seen: number;
  times_in_finding: number;
  times_confirmed: number;
  times_wrong: number;
  reliability_score: number | null;
}

export interface Stats {
  totalReports: number;
  reviewedReports: number;
  totalFindings: number;
  confirmed: number;
  wrong: number;
  missed: number;
  accuracy: number;
  missRate: number;
  avgEditDistance: number;
  avgFindingsPerReport: number;
  avgQualityRating: number;
  topWrongReasons: { reason: string; count: number }[];
  topMissedTypes: { eventType: string; count: number }[];
  topConfirmedTypes: { eventType: string; count: number }[];
}

export interface Learnings {
  wrongPatterns: { reason: string; count: number; percentage: number }[];
  missedPatterns: { eventType: string; count: number }[];
  topSources: { domain: string; reliability: number; sampleSize: number }[];
  noiseSources: { domain: string; wrongCount: number; confirmedCount: number }[];
  avgEditDistance: number;
  editDistanceTrend: { month: string; avg: number }[];
}

// --- Delete ---

export async function deleteReport(id: number): Promise<void> {
  await pool.query('DELETE FROM dd_reports WHERE id = $1', [id]);
}

export async function deleteAllReports(): Promise<void> {
  await pool.query('DELETE FROM dd_reports');
  await pool.query('DELETE FROM dd_sources');
}

// --- CRUD ---

export async function saveReport(input: SaveReportInput): Promise<number> {
  const redCount = input.findings.filter(f => f.severity === 'RED').length;
  const amberCount = input.findings.filter(f => f.severity === 'AMBER').length;
  const statsJson = input.screeningStats ? JSON.stringify(input.screeningStats) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert report
    await client.query(`
      INSERT INTO dd_reports (run_id, subject_name, screened_at, language, name_variations,
        finding_count, red_count, amber_count, report_markdown, clean_results_json, screening_stats_json,
        cost_usd, duration_ms, queries_executed, total_search_results)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT(run_id) DO UPDATE SET
        finding_count = EXCLUDED.finding_count,
        red_count = EXCLUDED.red_count,
        amber_count = EXCLUDED.amber_count,
        clean_results_json = EXCLUDED.clean_results_json,
        screening_stats_json = EXCLUDED.screening_stats_json,
        cost_usd = EXCLUDED.cost_usd,
        duration_ms = EXCLUDED.duration_ms,
        queries_executed = EXCLUDED.queries_executed,
        total_search_results = EXCLUDED.total_search_results
    `, [
      input.runId, input.subjectName, input.screenedAt, input.language,
      JSON.stringify(input.nameVariations), input.findings.length, redCount, amberCount,
      input.reportMarkdown || null, input.cleanResults ? JSON.stringify(input.cleanResults) : null,
      statsJson, input.costUsd, input.durationMs,
      input.queriesExecuted, input.totalSearchResults,
    ]);

    // Get the report id
    const { rows: [row] } = await client.query('SELECT id FROM dd_reports WHERE run_id = $1', [input.runId]);
    const reportId = row.id;

    // Delete old findings before re-inserting (for upsert case)
    await client.query('DELETE FROM dd_findings WHERE report_id = $1', [reportId]);

    for (const f of input.findings) {
      await client.query(`
        INSERT INTO dd_findings (report_id, severity, headline, event_type, summary, date_range, source_count, source_urls)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [reportId, f.severity, f.headline, f.eventType, f.summary,
          f.dateRange || null, f.sourceCount, JSON.stringify(f.sourceUrls)]);
    }

    // Track source domains
    for (const f of input.findings) {
      for (const s of f.sourceUrls) {
        try {
          const domain = new URL(s.url).hostname;
          await trackSourceWithClient(client, domain, 'in_finding');
        } catch { /* invalid URL */ }
      }
    }

    await client.query('COMMIT');
    return reportId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getReport(id: number): Promise<ReportRow | null> {
  const { rows: [report] } = await pool.query('SELECT * FROM dd_reports WHERE id = $1', [id]);
  if (!report) return null;

  const { rows: findings } = await pool.query('SELECT * FROM dd_findings WHERE report_id = $1 ORDER BY id', [id]);
  const { rows: missedFlags } = await pool.query('SELECT * FROM dd_missed_flags WHERE report_id = $1 ORDER BY id', [id]);

  report.findings = findings;
  report.missed_flags = missedFlags;
  return report;
}

export async function listReports(opts: { limit?: number; offset?: number; search?: string } = {}): Promise<{ reports: ReportRow[]; total: number }> {
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  if (opts.search) {
    const pattern = `%${opts.search}%`;
    const { rows: reports } = await pool.query(
      'SELECT * FROM dd_reports WHERE subject_name ILIKE $1 OR report_markdown ILIKE $1 ORDER BY screened_at DESC LIMIT $2 OFFSET $3',
      [pattern, limit, offset]
    );
    const { rows: [{ c: total }] } = await pool.query(
      'SELECT count(*) as c FROM dd_reports WHERE subject_name ILIKE $1 OR report_markdown ILIKE $1',
      [pattern]
    );

    await attachHeadlines(reports);
    return { reports, total: parseInt(total) };
  }

  const { rows: reports } = await pool.query(
    'SELECT * FROM dd_reports ORDER BY screened_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  const { rows: [{ c: total }] } = await pool.query('SELECT count(*) as c FROM dd_reports');

  await attachHeadlines(reports);
  return { reports, total: parseInt(total) };
}

async function attachHeadlines(reports: any[]): Promise<void> {
  if (reports.length === 0) return;
  const ids = reports.map(r => r.id);
  const { rows: headlineRows } = await pool.query(
    'SELECT report_id, headline FROM dd_findings WHERE report_id = ANY($1::int[]) ORDER BY report_id, id',
    [ids]
  );
  const headlineMap = new Map<number, string[]>();
  for (const row of headlineRows) {
    if (!headlineMap.has(row.report_id)) headlineMap.set(row.report_id, []);
    headlineMap.get(row.report_id)!.push(row.headline);
  }
  for (const r of reports) {
    r.headlines = headlineMap.get(r.id) || [];
    r.findings = [];
    r.missed_flags = [];
  }
}

// --- Review operations ---

export async function updateFindingVerdict(findingId: number, verdict: 'CONFIRMED' | 'WRONG', wrongReason?: string): Promise<void> {
  await pool.query('UPDATE dd_findings SET human_verdict = $1, wrong_reason = $2 WHERE id = $3',
    [verdict, wrongReason || null, findingId]);

  // Update source reliability based on verdict
  const { rows: [finding] } = await pool.query('SELECT source_urls FROM dd_findings WHERE id = $1', [findingId]);
  if (finding) {
    const urls = JSON.parse(finding.source_urls) as { url: string }[];
    for (const s of urls) {
      try {
        const domain = new URL(s.url).hostname;
        await trackSource(domain, verdict === 'CONFIRMED' ? 'confirmed' : 'wrong');
      } catch { /* invalid URL */ }
    }
  }
}

export async function addMissedFlag(reportId: number, data: { description: string; severity: 'RED' | 'AMBER'; eventType?: string }): Promise<number> {
  const { rows: [row] } = await pool.query(
    'INSERT INTO dd_missed_flags (report_id, description, severity, event_type) VALUES ($1, $2, $3, $4) RETURNING id',
    [reportId, data.description, data.severity, data.eventType || null]
  );
  return row.id;
}

export async function saveEditedReport(reportId: number, editedMarkdown: string): Promise<void> {
  const { rows: [report] } = await pool.query('SELECT report_markdown FROM dd_reports WHERE id = $1', [reportId]);
  if (!report) return;

  const distance = computeEditDistance(report.report_markdown || '', editedMarkdown);
  await pool.query('UPDATE dd_reports SET edited_markdown = $1, edit_distance = $2 WHERE id = $3',
    [editedMarkdown, distance, reportId]);
}

export async function saveReportMarkdown(runId: string, markdown: string): Promise<void> {
  await pool.query('UPDATE dd_reports SET report_markdown = $1 WHERE run_id = $2', [markdown, runId]);
}

export async function setQualityRating(id: number, rating: number): Promise<void> {
  await pool.query('UPDATE dd_reports SET quality_rating = $1 WHERE id = $2', [rating, id]);
}

// --- Changelog ---

export interface ChangelogEntry {
  id: number;
  date: string;
  description: string;
  category: string;
  created_at: string;
}

export async function listChangelog(): Promise<ChangelogEntry[]> {
  const { rows } = await pool.query('SELECT * FROM dd_changelog ORDER BY date DESC, id DESC');
  return rows;
}

export async function addChangelogEntry(date: string, description: string, category: string): Promise<number> {
  const { rows: [row] } = await pool.query(
    'INSERT INTO dd_changelog (date, description, category) VALUES ($1, $2, $3) RETURNING id',
    [date, description, category]
  );
  return row.id;
}

// --- Stats ---

export async function getStats(): Promise<Stats> {
  const { rows: [totals] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM dd_reports) as "totalReports",
      (SELECT count(DISTINCT r.id) FROM dd_reports r JOIN dd_findings f ON f.report_id = r.id WHERE f.human_verdict IS NOT NULL) as "reviewedReports",
      (SELECT count(*) FROM dd_findings) as "totalFindings",
      (SELECT count(*) FROM dd_findings WHERE human_verdict = 'CONFIRMED') as confirmed,
      (SELECT count(*) FROM dd_findings WHERE human_verdict = 'WRONG') as wrong,
      (SELECT count(*) FROM dd_missed_flags) as missed,
      (SELECT avg(edit_distance) FROM dd_reports WHERE edit_distance IS NOT NULL) as "avgEditDistance",
      (SELECT avg(quality_rating) FROM dd_reports WHERE quality_rating IS NOT NULL) as "avgQualityRating"
  `);

  const totalReports = parseInt(totals.totalReports);
  const reviewedReports = parseInt(totals.reviewedReports);
  const totalFindings = parseInt(totals.totalFindings);
  const confirmed = parseInt(totals.confirmed);
  const wrong = parseInt(totals.wrong);
  const missed = parseInt(totals.missed);
  const reviewed = confirmed + wrong;
  const accuracy = reviewed > 0 ? confirmed / reviewed : 0;
  const missRate = (confirmed + missed) > 0 ? missed / (confirmed + missed) : 0;

  const { rows: topWrongReasons } = await pool.query(`
    SELECT wrong_reason as reason, count(*)::int as count FROM dd_findings
    WHERE human_verdict = 'WRONG' AND wrong_reason IS NOT NULL
    GROUP BY wrong_reason ORDER BY count DESC LIMIT 10
  `);

  const { rows: topMissedTypes } = await pool.query(`
    SELECT event_type as "eventType", count(*)::int as count FROM dd_missed_flags
    WHERE event_type IS NOT NULL
    GROUP BY event_type ORDER BY count DESC LIMIT 10
  `);

  const { rows: topConfirmedTypes } = await pool.query(`
    SELECT event_type as "eventType", count(*)::int as count FROM dd_findings
    WHERE human_verdict = 'CONFIRMED'
    GROUP BY event_type ORDER BY count DESC LIMIT 10
  `);

  return {
    totalReports,
    reviewedReports,
    totalFindings,
    confirmed,
    wrong,
    missed,
    accuracy,
    missRate,
    avgEditDistance: parseFloat(totals.avgEditDistance) || 0,
    avgFindingsPerReport: totalReports > 0 ? totalFindings / totalReports : 0,
    avgQualityRating: parseFloat(totals.avgQualityRating) || 0,
    topWrongReasons,
    topMissedTypes,
    topConfirmedTypes,
  };
}

export async function getSourceRanking(limit: number = 20): Promise<SourceRow[]> {
  const { rows } = await pool.query(`
    SELECT domain, times_seen, times_in_finding, times_confirmed, times_wrong, reliability_score
    FROM dd_sources WHERE (times_confirmed + times_wrong) > 0
    ORDER BY reliability_score DESC, (times_confirmed + times_wrong) DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

export async function getLearnings(): Promise<Learnings> {
  const { rows: [{ c: totalWrong }] } = await pool.query("SELECT count(*) as c FROM dd_findings WHERE human_verdict = 'WRONG'");
  const totalWrongNum = parseInt(totalWrong);

  const { rows: wrongPatterns } = await pool.query(`
    SELECT wrong_reason as reason, count(*)::int as count FROM dd_findings
    WHERE human_verdict = 'WRONG' AND wrong_reason IS NOT NULL
    GROUP BY wrong_reason ORDER BY count DESC
  `);

  const { rows: missedPatterns } = await pool.query(`
    SELECT event_type as "eventType", count(*)::int as count FROM dd_missed_flags
    WHERE event_type IS NOT NULL GROUP BY event_type ORDER BY count DESC
  `);

  const { rows: topSources } = await pool.query(`
    SELECT domain, reliability_score as reliability, (times_confirmed + times_wrong) as "sampleSize"
    FROM dd_sources WHERE reliability_score IS NOT NULL AND (times_confirmed + times_wrong) >= 3
    ORDER BY reliability_score DESC LIMIT 10
  `);

  const { rows: noiseSources } = await pool.query(`
    SELECT domain, times_wrong as "wrongCount", times_confirmed as "confirmedCount"
    FROM dd_sources WHERE times_wrong > times_confirmed AND (times_confirmed + times_wrong) >= 3
    ORDER BY times_wrong DESC LIMIT 10
  `);

  const { rows: [{ a: avgEditDistance }] } = await pool.query("SELECT avg(edit_distance) as a FROM dd_reports WHERE edit_distance IS NOT NULL");

  const { rows: editDistanceTrend } = await pool.query(`
    SELECT substring(screened_at from 1 for 7) as month, avg(edit_distance) as avg
    FROM dd_reports WHERE edit_distance IS NOT NULL
    GROUP BY month ORDER BY month
  `);

  return {
    wrongPatterns: wrongPatterns.map((p: any) => ({ ...p, percentage: totalWrongNum > 0 ? (p.count / totalWrongNum) * 100 : 0 })),
    missedPatterns,
    topSources,
    noiseSources,
    avgEditDistance: parseFloat(avgEditDistance) || 0,
    editDistanceTrend,
  };
}

// --- Source tracking ---

async function trackSourceWithClient(client: any, domain: string, action: 'seen' | 'in_finding' | 'confirmed' | 'wrong'): Promise<void> {
  await client.query(
    'INSERT INTO dd_sources (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING',
    [domain]
  );

  const col = action === 'seen' ? 'times_seen' : action === 'in_finding' ? 'times_in_finding' : action === 'confirmed' ? 'times_confirmed' : 'times_wrong';
  await client.query(
    `UPDATE dd_sources SET ${col} = ${col} + 1, last_seen = NOW() WHERE domain = $1`,
    [domain]
  );

  // Recompute reliability
  await client.query(
    `UPDATE dd_sources SET reliability_score = CASE WHEN (times_confirmed + times_wrong) = 0 THEN NULL ELSE times_confirmed::float / (times_confirmed + times_wrong) END WHERE domain = $1`,
    [domain]
  );
}

export async function trackSource(domain: string, action: 'seen' | 'in_finding' | 'confirmed' | 'wrong'): Promise<void> {
  await trackSourceWithClient(pool, domain, action);
}

// --- Edit distance ---

function computeEditDistance(original: string, edited: string): number {
  if (!original && !edited) return 0;
  if (!original) return 1;
  if (original === edited) return 0;

  // Word-level diff ratio
  const origWords = original.split(/\s+/);
  const editWords = edited.split(/\s+/);
  const origSet = new Set(origWords);
  const editSet = new Set(editWords);

  let shared = 0;
  for (const w of editSet) { if (origSet.has(w)) shared++; }

  const totalUnique = new Set([...origWords, ...editWords]).size;
  if (totalUnique === 0) return 0;

  return 1 - (shared / totalUnique);
}

// --- Schema DDL ---

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS dd_reports (
    id SERIAL PRIMARY KEY,
    run_id TEXT UNIQUE NOT NULL,
    subject_name TEXT NOT NULL,
    screened_at TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'zh',
    name_variations TEXT NOT NULL DEFAULT '[]',
    finding_count INTEGER NOT NULL DEFAULT 0,
    red_count INTEGER NOT NULL DEFAULT 0,
    amber_count INTEGER NOT NULL DEFAULT 0,
    report_markdown TEXT,
    clean_results_json TEXT,
    screening_stats_json TEXT,
    edited_markdown TEXT,
    edit_distance DOUBLE PRECISION,
    quality_rating INTEGER,
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    queries_executed INTEGER NOT NULL DEFAULT 0,
    total_search_results INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dd_findings (
    id SERIAL PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES dd_reports(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    headline TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'unknown',
    summary TEXT NOT NULL DEFAULT '',
    date_range TEXT,
    source_count INTEGER NOT NULL DEFAULT 1,
    source_urls TEXT NOT NULL DEFAULT '[]',
    included_in_report INTEGER NOT NULL DEFAULT 1,
    human_verdict TEXT,
    wrong_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dd_missed_flags (
    id SERIAL PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES dd_reports(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'RED',
    event_type TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dd_sources (
    id SERIAL PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    times_seen INTEGER NOT NULL DEFAULT 0,
    times_in_finding INTEGER NOT NULL DEFAULT 0,
    times_confirmed INTEGER NOT NULL DEFAULT 0,
    times_wrong INTEGER NOT NULL DEFAULT 0,
    reliability_score DOUBLE PRECISION,
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dd_learning_rules (
    id SERIAL PRIMARY KEY,
    rule_type TEXT NOT NULL,
    rule_text TEXT NOT NULL,
    source_feedback_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dd_changelog (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'prompt',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_dd_reports_subject ON dd_reports(subject_name);
  CREATE INDEX IF NOT EXISTS idx_dd_reports_screened_at ON dd_reports(screened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dd_findings_report_id ON dd_findings(report_id);
  CREATE INDEX IF NOT EXISTS idx_dd_findings_verdict ON dd_findings(human_verdict);
  CREATE INDEX IF NOT EXISTS idx_dd_missed_flags_report_id ON dd_missed_flags(report_id);
  CREATE INDEX IF NOT EXISTS idx_dd_sources_domain ON dd_sources(domain);
  CREATE INDEX IF NOT EXISTS idx_dd_sources_reliability ON dd_sources(reliability_score DESC);
`;
