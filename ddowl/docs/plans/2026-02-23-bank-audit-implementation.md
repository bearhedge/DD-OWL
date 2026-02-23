# Bank Audit System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `POST /api/ipo/audit-banks` — heuristic flags + DeepSeek LLM verification + auto-fix for deals with missing or wrong bank data.

**Architecture:** New module `audit-banks.ts` handles heuristic DB queries and DeepSeek LLM verification. Single endpoint in `ipo-api.ts` runs both phases sequentially and returns a combined report. Auto-writes missing banks to DB using existing upsert patterns.

**Tech Stack:** PostgreSQL (existing pool), DeepSeek `deepseek-chat` via axios (same pattern as `triage.ts`), existing PDF parser (`extractBanksFromPdfUrl`), existing `normalizeBankName` + `normalizeRole`.

---

### Task 1: Create `audit-banks.ts` — Heuristic Flags

**Files:**
- Create: `ddowl/src/audit-banks.ts`

**Step 1: Create the module with heuristic query function**

```typescript
// src/audit-banks.ts
import pg from 'pg';
import axios from 'axios';
import { extractBanksFromPdfUrl } from './hkex-scraper-v2.js';
import { normalizeBankName } from './bank-normalizer.js';

const { Pool } = pg;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

export interface AuditIssue {
  deal_id: number;
  company: string;
  company_name: string;
  pdf_url: string | null;
  problems: string[];
}

export interface AuditFix {
  company: string;
  deal_id: number;
  added: string[];
  roles_corrected: string[];
}

export interface AuditResult {
  summary: {
    total_active: number;
    flagged: number;
    verified: number;
    fixed: number;
  };
  issues: AuditIssue[];
  fixes: AuditFix[];
  still_broken: { company: string; deal_id: number; reason: string }[];
}

/**
 * Phase 1: Run heuristic checks to flag deals with likely bank data problems.
 */
export async function runHeuristicFlags(pool: InstanceType<typeof Pool>): Promise<{
  totalActive: number;
  issues: AuditIssue[];
}> {
  // Count total active deals
  const totalResult = await pool.query(`SELECT COUNT(*) as cnt FROM deals WHERE status = 'active'`);
  const totalActive = parseInt(totalResult.rows[0].cnt);

  // Find deals with problems in a single query
  const result = await pool.query(`
    SELECT
      d.id as deal_id,
      c.name_en as company_name,
      oc.pdf_url,
      COUNT(da.id) as bank_count,
      BOOL_OR('sponsor' = ANY(da.roles)) as has_sponsor
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN deal_appointments da ON da.deal_id = d.id
    LEFT JOIN oc_announcements oc ON oc.deal_id = d.id
    WHERE d.status = 'active'
    GROUP BY d.id, c.name_en, oc.pdf_url
    HAVING
      COUNT(da.id) = 0
      OR COUNT(da.id) = 1
      OR NOT BOOL_OR('sponsor' = ANY(da.roles))
      OR oc.pdf_url IS NULL
  `);

  const issues: AuditIssue[] = result.rows.map(row => {
    const problems: string[] = [];
    if (parseInt(row.bank_count) === 0) problems.push('no_banks');
    else if (parseInt(row.bank_count) === 1) problems.push('single_bank');
    if (!row.has_sponsor && parseInt(row.bank_count) > 0) problems.push('no_sponsor');
    if (!row.pdf_url) problems.push('no_oc_pdf');
    return {
      deal_id: row.deal_id,
      company: row.company_name,
      company_name: row.company_name,
      pdf_url: row.pdf_url,
      problems,
    };
  });

  return { totalActive, issues };
}
```

**Step 2: Commit**

```bash
git add ddowl/src/audit-banks.ts
git commit -m "feat: add audit-banks module with heuristic flag queries"
```

---

### Task 2: Add LLM verification + auto-fix to `audit-banks.ts`

**Files:**
- Modify: `ddowl/src/audit-banks.ts`

**Step 1: Add DeepSeek LLM verification function**

Append to `audit-banks.ts`:

```typescript
interface LLMBank {
  name: string;
  role: string;
}

/**
 * Call DeepSeek to extract banks from PDF text.
 * Returns structured list of bank names + roles.
 */
async function llmExtractBanks(pdfText: string, companyName: string): Promise<LLMBank[]> {
  if (!DEEPSEEK_API_KEY) {
    console.log('[AUDIT] No DEEPSEEK_API_KEY configured, skipping LLM verification');
    return [];
  }

  const prompt = `Extract ALL investment banks, sponsors, coordinators, bookrunners, and lead managers from this Hong Kong IPO OC (Overall Coordinator) announcement for "${companyName}".

For each bank, provide its EXACT full legal name as written in the document, and its role.

Roles must be one of: sponsor, coordinator, bookrunner, leadManager

Return JSON only:
{"banks":[{"name":"Example Securities Limited","role":"sponsor"},{"name":"Another Capital Limited","role":"bookrunner"}]}

DOCUMENT TEXT:
${pdfText.slice(0, 15000)}`;

  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 60000,
      }
    );

    const rawText = response.data.choices?.[0]?.message?.content || '';
    const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.banks || !Array.isArray(parsed.banks)) return [];

    return parsed.banks;
  } catch (err: any) {
    console.error(`[AUDIT] DeepSeek error: ${err.message}`);
    return [];
  }
}
```

**Step 2: Add the verify-and-fix function**

Append to `audit-banks.ts`:

```typescript
/**
 * Phase 2: For each flagged deal with a PDF, use LLM to verify banks and auto-fix.
 */
export async function verifyAndFix(
  pool: InstanceType<typeof Pool>,
  issues: AuditIssue[]
): Promise<{ fixes: AuditFix[]; stillBroken: { company: string; deal_id: number; reason: string }[] }> {
  const fixes: AuditFix[] = [];
  const stillBroken: { company: string; deal_id: number; reason: string }[] = [];

  // Only verify deals that have a PDF URL
  const verifiable = issues.filter(i => i.pdf_url);
  const noUrl = issues.filter(i => !i.pdf_url);

  for (const issue of noUrl) {
    stillBroken.push({ company: issue.company, deal_id: issue.deal_id, reason: 'No OC PDF available' });
  }

  for (const issue of verifiable) {
    console.log(`[AUDIT] Verifying: ${issue.company}`);

    try {
      // Download and parse the PDF text
      const { banks: regexBanks } = await extractBanksFromPdfUrl(issue.pdf_url!, issue.company_name);

      // Get existing DB banks for this deal
      const dbResult = await pool.query(`
        SELECT b.name FROM deal_appointments da
        JOIN banks b ON b.id = da.bank_id
        WHERE da.deal_id = $1
      `, [issue.deal_id]);
      const dbBankNames = new Set(dbResult.rows.map(r => r.name.toUpperCase()));

      // Find banks the regex found that aren't in DB
      const missingFromDb = regexBanks.filter(b => !dbBankNames.has(b.bank.toUpperCase()));

      // If regex already found missing ones, write them
      if (missingFromDb.length > 0) {
        const added: string[] = [];
        for (const bank of missingFromDb) {
          const { canonical: shortName } = normalizeBankName(bank.bank);
          const bankResult = await pool.query(`
            INSERT INTO banks (name, short_name) VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
            RETURNING id
          `, [bank.bank, shortName]);
          const bankId = bankResult.rows[0].id;

          await pool.query(`
            INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
            VALUES ($1, $2, $3::bank_role[], $4, $5)
            ON CONFLICT (deal_id, bank_id) DO NOTHING
          `, [issue.deal_id, bankId, bank.roles, bank.isLead, issue.pdf_url]);
          added.push(bank.bank);
        }
        fixes.push({ company: issue.company, deal_id: issue.deal_id, added, roles_corrected: [] });
        console.log(`[AUDIT]   Fixed: added ${added.length} banks`);
        continue;
      }

      // If regex found nothing new, try LLM as second opinion
      // Re-download PDF text for LLM
      const pdfResponse = await axios.get(issue.pdf_url!, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      const buffer = Buffer.from(pdfResponse.data);
      if (buffer.slice(0, 5).toString() !== '%PDF-') {
        stillBroken.push({ company: issue.company, deal_id: issue.deal_id, reason: 'Invalid PDF' });
        continue;
      }

      const { PDFParse } = await import('pdf-parse');
      const path = await import('path');
      const uint8Array = new Uint8Array(buffer);
      const cMapUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps/');
      const parser = new PDFParse({ data: uint8Array, cMapUrl, cMapPacked: true });
      const result = await parser.getText();
      const pdfText = result.pages.map((p: { text: string }) => p.text).join('\n');

      const llmBanks = await llmExtractBanks(pdfText, issue.company);
      if (llmBanks.length === 0) {
        stillBroken.push({ company: issue.company, deal_id: issue.deal_id, reason: 'LLM found no banks' });
        continue;
      }

      // Compare LLM results vs DB
      const llmMissing = llmBanks.filter(lb => !dbBankNames.has(lb.name.toUpperCase()));

      if (llmMissing.length > 0) {
        const added: string[] = [];
        for (const lb of llmMissing) {
          const { normalizeRole, isLeadRole } = await import('./role-normalizer.js');
          const roles = normalizeRole(lb.role);
          const isLead = isLeadRole(roles);
          const { canonical: shortName } = normalizeBankName(lb.name);

          const bankResult = await pool.query(`
            INSERT INTO banks (name, short_name) VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
            RETURNING id
          `, [lb.name, shortName]);
          const bankId = bankResult.rows[0].id;

          await pool.query(`
            INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
            VALUES ($1, $2, $3::bank_role[], $4, $5)
            ON CONFLICT (deal_id, bank_id) DO NOTHING
          `, [issue.deal_id, bankId, roles, isLead, issue.pdf_url]);
          added.push(lb.name);
        }
        fixes.push({ company: issue.company, deal_id: issue.deal_id, added, roles_corrected: [] });
        console.log(`[AUDIT]   LLM fixed: added ${added.length} banks`);
      } else {
        // LLM agrees with DB — flag remains but no fix needed
        stillBroken.push({ company: issue.company, deal_id: issue.deal_id, reason: 'LLM agrees with DB — issue may be valid (single bank deal or no sponsor role in PDF)' });
      }
    } catch (err: any) {
      console.error(`[AUDIT]   Error verifying ${issue.company}: ${err.message}`);
      stillBroken.push({ company: issue.company, deal_id: issue.deal_id, reason: `Error: ${err.message}` });
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  return { fixes, stillBroken };
}
```

**Step 3: Add the combined audit function**

Append to `audit-banks.ts`:

```typescript
/**
 * Full audit: heuristics → LLM verify → auto-fix.
 */
export async function auditBanks(pool: InstanceType<typeof Pool>): Promise<AuditResult> {
  console.log('[AUDIT] Starting bank audit...');

  // Phase 1: Heuristics
  const { totalActive, issues } = await runHeuristicFlags(pool);
  console.log(`[AUDIT] Phase 1: ${issues.length}/${totalActive} deals flagged`);

  if (issues.length === 0) {
    return {
      summary: { total_active: totalActive, flagged: 0, verified: 0, fixed: 0 },
      issues: [],
      fixes: [],
      still_broken: [],
    };
  }

  // Phase 2: LLM verify + auto-fix
  const { fixes, stillBroken } = await verifyAndFix(pool, issues);
  console.log(`[AUDIT] Phase 2: ${fixes.length} fixed, ${stillBroken.length} still broken`);

  return {
    summary: {
      total_active: totalActive,
      flagged: issues.length,
      verified: issues.filter(i => i.pdf_url).length,
      fixed: fixes.length,
    },
    issues,
    fixes,
    still_broken: stillBroken,
  };
}
```

**Step 4: Commit**

```bash
git add ddowl/src/audit-banks.ts
git commit -m "feat: add LLM verification and auto-fix to bank audit"
```

---

### Task 3: Add endpoint to `ipo-api.ts`

**Files:**
- Modify: `ddowl/src/ipo-api.ts`

**Step 1: Add the audit-banks endpoint**

Add before the `export default ipoRouter;` line at the bottom of `ipo-api.ts`:

```typescript
/**
 * POST /api/ipo/audit-banks
 * Runs heuristic checks + LLM verification + auto-fix for bank data quality.
 * Phase 1: flags deals with 0 banks, no sponsor, single bank, no OC PDF.
 * Phase 2: for flagged deals, re-parses PDFs and uses DeepSeek to verify, auto-writes fixes.
 */
ipoRouter.post('/audit-banks', async (req: Request, res: Response) => {
  try {
    const { auditBanks } = await import('./audit-banks.js');
    const result = await auditBanks(pool);
    res.json(result);
  } catch (err) {
    console.error('Audit banks error:', err);
    res.status(500).json({ error: 'Failed to audit banks' });
  }
});
```

**Step 2: Commit**

```bash
git add ddowl/src/ipo-api.ts
git commit -m "feat: add POST /api/ipo/audit-banks endpoint"
```

---

### Task 4: TypeScript compilation check

**Step 1: Run tsc**

```bash
cd ddowl && npx tsc --noEmit
```

Expected: No new errors in `audit-banks.ts` or `ipo-api.ts`. Pre-existing errors in `update-manual-prospectus.ts` are acceptable.

**Step 2: Fix any type errors if needed**

---

### Task 5: Final commit with all files

**Step 1: Commit any remaining changes**

```bash
git add ddowl/src/audit-banks.ts ddowl/src/ipo-api.ts
git commit -m "feat: bank audit system — heuristic flags + DeepSeek LLM verify + auto-fix"
```
