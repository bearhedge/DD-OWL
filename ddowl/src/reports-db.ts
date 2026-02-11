import Database from 'better-sqlite3';

let db: Database.Database | null = null;

// --- Init / Access / Close ---

export function initReportsDb(dbPath?: string): void {
  const resolvedPath = dbPath || process.env.REPORTS_DB_PATH || './data/ddowl-reports.db';
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  // Migrations for existing databases
  try {
    db.exec('ALTER TABLE reports ADD COLUMN clean_results_json TEXT');
  } catch { /* Column already exists */ }
  try {
    db.exec('ALTER TABLE reports ADD COLUMN screening_stats_json TEXT');
  } catch { /* Column already exists */ }
}

export function getReportsDb(): Database.Database {
  if (!db) throw new Error('Reports database not initialized. Call initReportsDb() first.');
  return db;
}

export function closeReportsDb(): void {
  if (db) { db.close(); db = null; }
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
  totalFindings: number;
  confirmed: number;
  wrong: number;
  missed: number;
  accuracy: number;
  missRate: number;
  avgEditDistance: number;
  avgFindingsPerReport: number;
  totalCostUsd: number;
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

// --- CRUD ---

export function saveReport(input: SaveReportInput): number {
  const d = getReportsDb();
  const redCount = input.findings.filter(f => f.severity === 'RED').length;
  const amberCount = input.findings.filter(f => f.severity === 'AMBER').length;
  const statsJson = input.screeningStats ? JSON.stringify(input.screeningStats) : null;

  // Upsert: if run_id already exists (reconnection), update instead of creating duplicate
  const upsertReport = d.prepare(`
    INSERT INTO reports (run_id, subject_name, screened_at, language, name_variations,
      finding_count, red_count, amber_count, report_markdown, clean_results_json, screening_stats_json,
      cost_usd, duration_ms, queries_executed, total_search_results)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      finding_count = excluded.finding_count,
      red_count = excluded.red_count,
      amber_count = excluded.amber_count,
      clean_results_json = excluded.clean_results_json,
      screening_stats_json = excluded.screening_stats_json,
      cost_usd = excluded.cost_usd,
      duration_ms = excluded.duration_ms,
      queries_executed = excluded.queries_executed,
      total_search_results = excluded.total_search_results
  `);

  const insertFinding = d.prepare(`
    INSERT INTO findings (report_id, severity, headline, event_type, summary, date_range, source_count, source_urls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = d.transaction(() => {
    upsertReport.run(
      input.runId, input.subjectName, input.screenedAt, input.language,
      JSON.stringify(input.nameVariations), input.findings.length, redCount, amberCount,
      input.reportMarkdown || null, input.cleanResults ? JSON.stringify(input.cleanResults) : null,
      statsJson, input.costUsd, input.durationMs,
      input.queriesExecuted, input.totalSearchResults,
    );

    // Get the report id (works for both insert and update)
    const row = d.prepare('SELECT id FROM reports WHERE run_id = ?').get(input.runId) as { id: number };
    const reportId = row.id;

    // Delete old findings before re-inserting (for upsert case)
    d.prepare('DELETE FROM findings WHERE report_id = ?').run(reportId);

    for (const f of input.findings) {
      insertFinding.run(reportId, f.severity, f.headline, f.eventType, f.summary,
        f.dateRange || null, f.sourceCount, JSON.stringify(f.sourceUrls));
    }

    // Track source domains
    for (const f of input.findings) {
      for (const s of f.sourceUrls) {
        try {
          const domain = new URL(s.url).hostname;
          trackSource(domain, 'in_finding');
        } catch { /* invalid URL */ }
      }
    }

    return reportId;
  })();

  return result as number;
}

export function getReport(id: number): ReportRow | null {
  const d = getReportsDb();
  const report = d.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  if (!report) return null;

  report.findings = d.prepare('SELECT * FROM findings WHERE report_id = ? ORDER BY id').all(id) as FindingRow[];
  report.missed_flags = d.prepare('SELECT * FROM missed_flags WHERE report_id = ? ORDER BY id').all(id) as MissedFlagRow[];
  return report;
}

export function listReports(opts: { limit?: number; offset?: number; search?: string } = {}): { reports: ReportRow[]; total: number } {
  const d = getReportsDb();
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  if (opts.search) {
    const ids = d.prepare('SELECT rowid FROM reports_fts WHERE reports_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?')
      .all(opts.search, limit, offset) as { rowid: number }[];
    const total = (d.prepare('SELECT count(*) as c FROM reports_fts WHERE reports_fts MATCH ?').get(opts.search) as { c: number }).c;

    const reports = ids.map(r => {
      const report = d.prepare('SELECT * FROM reports WHERE id = ?').get(r.rowid) as ReportRow;
      report.findings = [];
      report.missed_flags = [];
      return report;
    });
    return { reports, total };
  }

  const reports = d.prepare('SELECT * FROM reports ORDER BY screened_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as ReportRow[];
  const total = (d.prepare('SELECT count(*) as c FROM reports').get() as { c: number }).c;

  for (const r of reports) { r.findings = []; r.missed_flags = []; }
  return { reports, total };
}

// --- Review operations ---

export function updateFindingVerdict(findingId: number, verdict: 'CONFIRMED' | 'WRONG', wrongReason?: string): void {
  const d = getReportsDb();
  d.prepare('UPDATE findings SET human_verdict = ?, wrong_reason = ? WHERE id = ?')
    .run(verdict, wrongReason || null, findingId);

  // Update source reliability based on verdict
  const finding = d.prepare('SELECT source_urls FROM findings WHERE id = ?').get(findingId) as { source_urls: string } | undefined;
  if (finding) {
    const urls = JSON.parse(finding.source_urls) as { url: string }[];
    for (const s of urls) {
      try {
        const domain = new URL(s.url).hostname;
        trackSource(domain, verdict === 'CONFIRMED' ? 'confirmed' : 'wrong');
      } catch { /* invalid URL */ }
    }
  }
}

export function addMissedFlag(reportId: number, data: { description: string; severity: 'RED' | 'AMBER'; eventType?: string }): number {
  const d = getReportsDb();
  const res = d.prepare('INSERT INTO missed_flags (report_id, description, severity, event_type) VALUES (?, ?, ?, ?)')
    .run(reportId, data.description, data.severity, data.eventType || null);
  return res.lastInsertRowid as number;
}

export function saveEditedReport(reportId: number, editedMarkdown: string): void {
  const d = getReportsDb();
  const report = d.prepare('SELECT report_markdown FROM reports WHERE id = ?').get(reportId) as { report_markdown: string | null } | undefined;
  if (!report) return;

  const distance = computeEditDistance(report.report_markdown || '', editedMarkdown);
  d.prepare('UPDATE reports SET edited_markdown = ?, edit_distance = ? WHERE id = ?')
    .run(editedMarkdown, distance, reportId);
}

// --- Stats ---

export function getStats(): Stats {
  const d = getReportsDb();

  const totals = d.prepare(`
    SELECT
      (SELECT count(*) FROM reports) as totalReports,
      (SELECT count(*) FROM findings) as totalFindings,
      (SELECT count(*) FROM findings WHERE human_verdict = 'CONFIRMED') as confirmed,
      (SELECT count(*) FROM findings WHERE human_verdict = 'WRONG') as wrong,
      (SELECT count(*) FROM missed_flags) as missed,
      (SELECT avg(edit_distance) FROM reports WHERE edit_distance IS NOT NULL) as avgEditDistance,
      (SELECT sum(cost_usd) FROM reports) as totalCostUsd
  `).get() as any;

  const reviewed = totals.confirmed + totals.wrong;
  const accuracy = reviewed > 0 ? totals.confirmed / reviewed : 0;
  const missRate = (totals.confirmed + totals.missed) > 0 ? totals.missed / (totals.confirmed + totals.missed) : 0;

  const topWrongReasons = d.prepare(`
    SELECT wrong_reason as reason, count(*) as count FROM findings
    WHERE human_verdict = 'WRONG' AND wrong_reason IS NOT NULL
    GROUP BY wrong_reason ORDER BY count DESC LIMIT 10
  `).all() as { reason: string; count: number }[];

  const topMissedTypes = d.prepare(`
    SELECT event_type as eventType, count(*) as count FROM missed_flags
    WHERE event_type IS NOT NULL
    GROUP BY event_type ORDER BY count DESC LIMIT 10
  `).all() as { eventType: string; count: number }[];

  const topConfirmedTypes = d.prepare(`
    SELECT event_type as eventType, count(*) as count FROM findings
    WHERE human_verdict = 'CONFIRMED'
    GROUP BY event_type ORDER BY count DESC LIMIT 10
  `).all() as { eventType: string; count: number }[];

  return {
    totalReports: totals.totalReports,
    totalFindings: totals.totalFindings,
    confirmed: totals.confirmed,
    wrong: totals.wrong,
    missed: totals.missed,
    accuracy,
    missRate,
    avgEditDistance: totals.avgEditDistance || 0,
    avgFindingsPerReport: totals.totalReports > 0 ? totals.totalFindings / totals.totalReports : 0,
    totalCostUsd: totals.totalCostUsd || 0,
    topWrongReasons,
    topMissedTypes,
    topConfirmedTypes,
  };
}

export function getSourceRanking(limit: number = 20): SourceRow[] {
  const d = getReportsDb();
  return d.prepare(`
    SELECT domain, times_seen, times_in_finding, times_confirmed, times_wrong, reliability_score
    FROM sources WHERE (times_confirmed + times_wrong) > 0
    ORDER BY reliability_score DESC, (times_confirmed + times_wrong) DESC
    LIMIT ?
  `).all(limit) as SourceRow[];
}

export function getLearnings(): Learnings {
  const d = getReportsDb();

  const totalWrong = (d.prepare("SELECT count(*) as c FROM findings WHERE human_verdict = 'WRONG'").get() as { c: number }).c;
  const wrongPatterns = d.prepare(`
    SELECT wrong_reason as reason, count(*) as count FROM findings
    WHERE human_verdict = 'WRONG' AND wrong_reason IS NOT NULL
    GROUP BY wrong_reason ORDER BY count DESC
  `).all() as { reason: string; count: number }[];

  const missedPatterns = d.prepare(`
    SELECT event_type as eventType, count(*) as count FROM missed_flags
    WHERE event_type IS NOT NULL GROUP BY event_type ORDER BY count DESC
  `).all() as { eventType: string; count: number }[];

  const topSources = d.prepare(`
    SELECT domain, reliability_score as reliability, (times_confirmed + times_wrong) as sampleSize
    FROM sources WHERE reliability_score IS NOT NULL AND (times_confirmed + times_wrong) >= 3
    ORDER BY reliability_score DESC LIMIT 10
  `).all() as { domain: string; reliability: number; sampleSize: number }[];

  const noiseSources = d.prepare(`
    SELECT domain, times_wrong as wrongCount, times_confirmed as confirmedCount
    FROM sources WHERE times_wrong > times_confirmed AND (times_confirmed + times_wrong) >= 3
    ORDER BY times_wrong DESC LIMIT 10
  `).all() as { domain: string; wrongCount: number; confirmedCount: number }[];

  const avgEditDistance = (d.prepare("SELECT avg(edit_distance) as a FROM reports WHERE edit_distance IS NOT NULL").get() as { a: number | null }).a || 0;

  const editDistanceTrend = d.prepare(`
    SELECT strftime('%Y-%m', screened_at) as month, avg(edit_distance) as avg
    FROM reports WHERE edit_distance IS NOT NULL
    GROUP BY month ORDER BY month
  `).all() as { month: string; avg: number }[];

  return {
    wrongPatterns: wrongPatterns.map(p => ({ ...p, percentage: totalWrong > 0 ? (p.count / totalWrong) * 100 : 0 })),
    missedPatterns,
    topSources,
    noiseSources,
    avgEditDistance,
    editDistanceTrend,
  };
}

// --- Source tracking ---

export function trackSource(domain: string, action: 'seen' | 'in_finding' | 'confirmed' | 'wrong'): void {
  const d = getReportsDb();
  d.prepare('INSERT OR IGNORE INTO sources (domain) VALUES (?)').run(domain);

  const col = action === 'seen' ? 'times_seen' : action === 'in_finding' ? 'times_in_finding' : action === 'confirmed' ? 'times_confirmed' : 'times_wrong';
  d.prepare(`UPDATE sources SET ${col} = ${col} + 1, last_seen = datetime('now') WHERE domain = ?`).run(domain);

  // Recompute reliability
  d.prepare(`UPDATE sources SET reliability_score = CASE WHEN (times_confirmed + times_wrong) = 0 THEN NULL ELSE CAST(times_confirmed AS REAL) / (times_confirmed + times_wrong) END WHERE domain = ?`).run(domain);
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

// --- Schema ---

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    edit_distance REAL,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    queries_executed INTEGER NOT NULL DEFAULT 0,
    total_search_results INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('RED', 'AMBER', 'REVIEW')),
    headline TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'unknown',
    summary TEXT NOT NULL DEFAULT '',
    date_range TEXT,
    source_count INTEGER NOT NULL DEFAULT 1,
    source_urls TEXT NOT NULL DEFAULT '[]',
    included_in_report INTEGER NOT NULL DEFAULT 1,
    human_verdict TEXT CHECK(human_verdict IN ('CONFIRMED', 'WRONG')),
    wrong_reason TEXT CHECK(wrong_reason IN ('name_collision', 'outdated', 'not_relevant', 'other')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS missed_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'RED' CHECK(severity IN ('RED', 'AMBER')),
    event_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    times_seen INTEGER NOT NULL DEFAULT 0,
    times_in_finding INTEGER NOT NULL DEFAULT 0,
    times_confirmed INTEGER NOT NULL DEFAULT 0,
    times_wrong INTEGER NOT NULL DEFAULT 0,
    reliability_score REAL,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learning_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('triage_instruction', 'domain_depriority', 'search_query', 'filter_rule')),
    rule_text TEXT NOT NULL,
    source_feedback_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_reports_subject ON reports(subject_name);
  CREATE INDEX IF NOT EXISTS idx_reports_screened_at ON reports(screened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_findings_report_id ON findings(report_id);
  CREATE INDEX IF NOT EXISTS idx_findings_verdict ON findings(human_verdict);
  CREATE INDEX IF NOT EXISTS idx_missed_flags_report_id ON missed_flags(report_id);
  CREATE INDEX IF NOT EXISTS idx_sources_domain ON sources(domain);
  CREATE INDEX IF NOT EXISTS idx_sources_reliability ON sources(reliability_score DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(
    subject_name,
    report_markdown,
    content=reports,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS reports_fts_ai AFTER INSERT ON reports BEGIN
    INSERT INTO reports_fts(rowid, subject_name, report_markdown)
    VALUES (new.id, new.subject_name, new.report_markdown);
  END;

  CREATE TRIGGER IF NOT EXISTS reports_fts_au AFTER UPDATE OF subject_name, report_markdown ON reports BEGIN
    DELETE FROM reports_fts WHERE rowid = old.id;
    INSERT INTO reports_fts(rowid, subject_name, report_markdown)
    VALUES (new.id, new.subject_name, new.report_markdown);
  END;

  CREATE TRIGGER IF NOT EXISTS reports_fts_ad AFTER DELETE ON reports BEGIN
    DELETE FROM reports_fts WHERE rowid = old.id;
  END;
`;
