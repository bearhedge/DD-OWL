import pg from 'pg';

const { Pool } = pg;

// Database connection — prefer DATABASE_URL (set by Cloud Run secret) to unify
// with the Drizzle connection in src/db/index.ts. Hardcoded fallback for local dev.
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: '104.199.131.94',
        port: 5432,
        database: 'ddowl',
        user: 'postgres',
        password: 'DOMRD7x7ECUny4Pc615y9w==',
        max: 10,
        idleTimeoutMillis: 30000,
      }
);

export { pool };

// ============================================================
// TYPES - Matching database schema
// ============================================================

export interface ExtractedFacts {
  // Issue identification
  issue_type: string;           // Code from issue_types table
  title: string;                // e.g., "Hangxiao Steel Insider Trading Case"
  title_zh?: string;
  timeframe?: string;           // e.g., "2007-2008"
  status: 'convicted' | 'charged' | 'alleged' | 'investigated' | 'settled' | 'acquitted' | 'ongoing' | 'historical' | 'unknown';
  severity: 'RED' | 'AMBER';
  jurisdiction?: string;        // Country code

  // Timeline events
  events: {
    date?: string;
    description: string;
    description_zh?: string;
  }[];

  // People involved
  people: {
    name_zh: string;
    name_en?: string;
    role?: string;
    title?: string;
    organization?: string;
    outcome?: string;
    sentence?: string;
    fine?: string;
    is_subject: boolean;
  }[];

  // Organizations involved
  organizations: {
    name_zh: string;
    name_en?: string;
    stock_code?: string;
    role?: string;
    outcome?: string;
  }[];

  // Authorities involved
  authorities: {
    name_zh: string;
    name_en?: string;
    action?: string;
    action_date?: string;
    document_number?: string;
  }[];

  // Financial amounts
  amounts: {
    description: string;
    amount_cny?: string;
    amount_usd?: string;
    amount_type?: 'profit' | 'loss' | 'fine' | 'settlement' | 'contract' | 'bribe' | 'embezzlement' | 'other';
  }[];

  // Legal details
  legal: {
    case_number?: string;
    court_zh?: string;
    court_en?: string;
    charge?: string;
    charge_zh?: string;
    verdict?: 'guilty' | 'not_guilty' | 'settled' | 'dismissed' | 'pending' | 'unknown';
    verdict_date?: string;
  }[];

  // Summary
  summary?: string;
  summary_zh?: string;
}

export interface SourceInfo {
  url: string;
  title?: string;
  publisher?: string;
  publish_date?: string;
  content: string;
  fetch_method: 'axios' | 'puppeteer' | 'manual';
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

// Create a new screening
export async function createScreening(subjectNameZh: string, subjectNameEn?: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO screenings (subject_name_zh, subject_name_en, status)
     VALUES ($1, $2, 'in_progress')
     RETURNING id`,
    [subjectNameZh, subjectNameEn]
  );
  return result.rows[0].id;
}

// Update screening status
export async function updateScreening(screeningId: number, updates: {
  status?: string;
  searches_completed?: number;
  articles_fetched?: number;
  articles_analyzed?: number;
  issues_found?: number;
  red_flags?: number;
  amber_flags?: number;
  green_count?: number;
  completed_at?: Date;
  report_json?: any;
}): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(key === 'report_json' ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }

  if (fields.length > 0) {
    values.push(screeningId);
    await pool.query(
      `UPDATE screenings SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }
}

// Get issue type ID by code
export async function getIssueTypeId(code: string): Promise<number | null> {
  const result = await pool.query(
    'SELECT id FROM issue_types WHERE code = $1',
    [code]
  );
  return result.rows[0]?.id || null;
}

// Get jurisdiction ID by code
export async function getJurisdictionId(code: string): Promise<number | null> {
  const result = await pool.query(
    'SELECT id FROM jurisdictions WHERE code = $1',
    [code]
  );
  return result.rows[0]?.id || null;
}

// Get authority ID by name (Chinese)
export async function getAuthorityId(nameZh: string): Promise<number | null> {
  const result = await pool.query(
    'SELECT id FROM authorities WHERE name_zh = $1 OR abbreviation = $1',
    [nameZh]
  );
  return result.rows[0]?.id || null;
}

// Log discovered authority (for ones we don't recognize)
export async function logDiscoveredAuthority(nameRaw: string, context: string, sourceUrl: string): Promise<void> {
  await pool.query(
    `INSERT INTO discovered_authorities (name_raw, context, source_url)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [nameRaw, context, sourceUrl]
  );
}

// Check if an issue already exists (by hash or similar title)
export async function findExistingIssue(screeningId: number, issueHash: string, title: string): Promise<number | null> {
  // First try exact hash match
  let result = await pool.query(
    'SELECT id FROM issues WHERE screening_id = $1 AND issue_hash = $2',
    [screeningId, issueHash]
  );
  if (result.rows[0]) return result.rows[0].id;

  // Then try fuzzy title match (for same screening)
  result = await pool.query(
    `SELECT id FROM issues
     WHERE screening_id = $1
     AND (title ILIKE $2 OR title_zh ILIKE $2)`,
    [screeningId, `%${title.slice(0, 30)}%`]
  );
  return result.rows[0]?.id || null;
}

// Create a new issue
export async function createIssue(screeningId: number, facts: ExtractedFacts): Promise<number> {
  const issueTypeId = await getIssueTypeId(facts.issue_type);
  const jurisdictionId = facts.jurisdiction ? await getJurisdictionId(facts.jurisdiction) : null;

  // Generate a hash for deduplication
  const issueHash = generateIssueHash(facts);

  const result = await pool.query(
    `INSERT INTO issues (
      screening_id, issue_type_id, issue_hash, title, title_zh, timeframe,
      severity, status, jurisdiction_id, summary, summary_zh
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id`,
    [
      screeningId, issueTypeId, issueHash, facts.title, facts.title_zh,
      facts.timeframe, facts.severity, facts.status, jurisdictionId,
      facts.summary, facts.summary_zh
    ]
  );
  return result.rows[0].id;
}

// Add people to an issue
export async function addIssuePeople(issueId: number, people: ExtractedFacts['people']): Promise<void> {
  for (const person of people) {
    await pool.query(
      `INSERT INTO issue_people (
        issue_id, name_zh, name_en, role, title, organization,
        outcome, sentence, fine_amount, is_subject
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        issueId, person.name_zh, person.name_en, person.role, person.title,
        person.organization, person.outcome, person.sentence, person.fine,
        person.is_subject
      ]
    );
  }
}

// Add organizations to an issue
export async function addIssueOrganizations(issueId: number, orgs: ExtractedFacts['organizations']): Promise<void> {
  for (const org of orgs) {
    await pool.query(
      `INSERT INTO issue_organizations (
        issue_id, name_zh, name_en, stock_code, role, outcome
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [issueId, org.name_zh, org.name_en, org.stock_code, org.role, org.outcome]
    );
  }
}

// Add authorities to an issue
export async function addIssueAuthorities(issueId: number, authorities: ExtractedFacts['authorities'], sourceUrl: string): Promise<void> {
  for (const auth of authorities) {
    const authorityId = await getAuthorityId(auth.name_zh);

    // If we don't recognize this authority, log it for review
    if (!authorityId) {
      await logDiscoveredAuthority(auth.name_zh, auth.action || '', sourceUrl);
    }

    await pool.query(
      `INSERT INTO issue_authorities (
        issue_id, authority_id, authority_name_raw, action, action_date, document_number
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        issueId, authorityId, auth.name_zh, auth.action,
        auth.action_date ? new Date(auth.action_date) : null, auth.document_number
      ]
    );
  }
}

// Add events to an issue
export async function addIssueEvents(issueId: number, events: ExtractedFacts['events']): Promise<void> {
  let sortOrder = 1;
  for (const event of events) {
    await pool.query(
      `INSERT INTO issue_events (
        issue_id, event_date, event_date_parsed, description, description_zh, sort_order
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        issueId, event.date, parseDate(event.date), event.description,
        event.description_zh, sortOrder++
      ]
    );
  }
}

// Add amounts to an issue
export async function addIssueAmounts(issueId: number, amounts: ExtractedFacts['amounts']): Promise<void> {
  for (const amount of amounts) {
    await pool.query(
      `INSERT INTO issue_amounts (
        issue_id, description, amount_cny, amount_usd, amount_cny_raw, amount_type
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        issueId, amount.description, amount.amount_cny, amount.amount_usd,
        parseAmount(amount.amount_cny), amount.amount_type
      ]
    );
  }
}

// Add legal details to an issue
export async function addIssueLegal(issueId: number, legal: ExtractedFacts['legal']): Promise<void> {
  for (const item of legal) {
    await pool.query(
      `INSERT INTO issue_legal (
        issue_id, case_number, court_zh, court_en, charge, charge_zh,
        verdict, verdict_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        issueId, item.case_number, item.court_zh, item.court_en,
        item.charge, item.charge_zh, item.verdict,
        item.verdict_date ? new Date(item.verdict_date) : null
      ]
    );
  }
}

// Add source to an issue
export async function addIssueSource(issueId: number, source: SourceInfo, extractedFacts: ExtractedFacts): Promise<number> {
  const contentHash = generateContentHash(source.content);
  const urlHash = generateContentHash(source.url);

  const result = await pool.query(
    `INSERT INTO issue_sources (
      issue_id, url, url_hash, title, publisher, publish_date,
      fetch_method, content_hash, content_length, raw_content, extracted_facts
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id`,
    [
      issueId, source.url, urlHash, source.title, source.publisher,
      source.publish_date, source.fetch_method, contentHash,
      source.content.length, source.content, JSON.stringify(extractedFacts)
    ]
  );
  return result.rows[0].id;
}

// Check if source already processed
export async function isSourceProcessed(url: string): Promise<boolean> {
  const urlHash = generateContentHash(url);
  const result = await pool.query(
    'SELECT id FROM issue_sources WHERE url_hash = $1',
    [urlHash]
  );
  return result.rows.length > 0;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function generateIssueHash(facts: ExtractedFacts): string {
  // Create a hash based on key identifying features
  const key = `${facts.issue_type}|${facts.title}|${facts.timeframe || ''}`.toLowerCase();
  return simpleHash(key);
}

function generateContentHash(content: string): string {
  return simpleHash(content);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0');
}

function parseDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function parseAmount(amountStr?: string): number | null {
  if (!amountStr) return null;
  // Extract numeric value from strings like "40.37 million" or "4037万"
  const match = amountStr.match(/[\d.]+/);
  if (!match) return null;

  let value = parseFloat(match[0]);

  // Handle multipliers
  if (amountStr.includes('billion') || amountStr.includes('亿')) {
    value *= 100000000;
  } else if (amountStr.includes('million') || amountStr.includes('百万')) {
    value *= 1000000;
  } else if (amountStr.includes('万')) {
    value *= 10000;
  }

  return value;
}

// Get all issue types for reference
export async function getIssueTypes(): Promise<Array<{code: string, name_en: string, name_zh: string, severity_default: string}>> {
  const result = await pool.query(
    'SELECT code, name_en, name_zh, severity_default FROM issue_types ORDER BY code'
  );
  return result.rows;
}

// Get all authorities for reference
export async function getAuthorities(): Promise<Array<{name_zh: string, name_en: string, abbreviation: string}>> {
  const result = await pool.query(
    'SELECT name_zh, name_en, abbreviation FROM authorities ORDER BY name_zh'
  );
  return result.rows;
}
