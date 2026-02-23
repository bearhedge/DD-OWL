/**
 * Audit Banks Module
 *
 * Phase 1: Heuristic flags — queries DB for active deals with problems
 * Phase 2: LLM verification + auto-fix — re-parses PDFs and uses DeepSeek as fallback
 * Phase 3: Combined audit — runs both phases and returns full report
 */

import axios from 'axios';
import * as path from 'path';
import { PDFParse } from 'pdf-parse';
import { normalizeBankName } from './bank-normalizer.js';
import { normalizeRole, isLeadRole } from './role-normalizer.js';
import type { BankAppointment } from './hkex-scraper-v2.js';
import type pg from 'pg';

type Pool = InstanceType<typeof pg.Pool>;

// ============================================================
// Interfaces
// ============================================================

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
  summary: { total_active: number; flagged: number; verified: number; fixed: number };
  issues: AuditIssue[];
  fixes: AuditFix[];
  still_broken: { company: string; deal_id: number; reason: string }[];
}

// ============================================================
// Phase 1: Heuristic Flags
// ============================================================

/**
 * Query DB for active deals with potential bank data problems:
 * - 0 banks (no deal_appointments)
 * - Only 1 bank (unusual for HK IPOs)
 * - No sponsor role assigned
 * - No OC PDF link available
 */
export async function runHeuristicFlags(pool: Pool): Promise<{ totalActive: number; issues: AuditIssue[] }> {
  // Get all active deals with their bank counts, roles, and PDF links
  const result = await pool.query(`
    SELECT
      d.id AS deal_id,
      c.name_en AS company_name,
      c.name_cn AS company_name_cn,
      COALESCE(
        (SELECT oc.pdf_url FROM oc_announcements oc WHERE oc.deal_id = d.id ORDER BY oc.announcement_date DESC LIMIT 1),
        (SELECT da2.source_url FROM deal_appointments da2 WHERE da2.deal_id = d.id AND da2.source_url IS NOT NULL LIMIT 1)
      ) AS pdf_url,
      COUNT(da.id) AS bank_count,
      COALESCE(
        array_agg(da.roles) FILTER (WHERE da.id IS NOT NULL),
        '{}'
      ) AS all_roles
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN deal_appointments da ON da.deal_id = d.id
    WHERE d.status = 'active'
    GROUP BY d.id, c.name_en, c.name_cn
    ORDER BY d.filing_date DESC
  `);

  const deals = result.rows;
  const totalActive = deals.length;
  const issues: AuditIssue[] = [];

  for (const deal of deals) {
    const problems: string[] = [];
    const bankCount = Number(deal.bank_count);

    // Problem 1: No banks at all
    if (bankCount === 0) {
      problems.push('0 banks — no deal_appointments');
    }

    // Problem 2: Only 1 bank (unusual)
    if (bankCount === 1) {
      problems.push('Only 1 bank — unusually few for HK IPO');
    }

    // Problem 3: No sponsor role
    if (bankCount > 0) {
      const allRoles: string[][] = deal.all_roles || [];
      const hasSponsor = allRoles.some((roles: string[]) =>
        Array.isArray(roles) && roles.includes('sponsor')
      );
      if (!hasSponsor) {
        problems.push('No sponsor role assigned');
      }
    }

    // Problem 4: No OC PDF link
    if (!deal.pdf_url) {
      problems.push('No OC PDF link available');
    }

    if (problems.length > 0) {
      issues.push({
        deal_id: deal.deal_id,
        company: deal.company_name,
        company_name: deal.company_name,
        pdf_url: deal.pdf_url || null,
        problems,
      });
    }
  }

  console.log(`[AUDIT] Phase 1: ${totalActive} active deals, ${issues.length} flagged`);
  return { totalActive, issues };
}

// ============================================================
// Internal: LLM Bank Extraction via DeepSeek
// ============================================================

interface LLMBankResult {
  bank: string;
  role: 'sponsor' | 'coordinator' | 'bookrunner' | 'leadManager';
}

/**
 * Call DeepSeek to extract banks and roles from PDF text.
 * Used as second opinion when regex parser finds nothing new.
 */
async function llmExtractBanks(pdfText: string, companyName: string): Promise<LLMBankResult[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn('[AUDIT] DEEPSEEK_API_KEY not set, skipping LLM extraction');
    return [];
  }

  // Truncate to stay under token limits
  const truncated = pdfText.slice(0, 15000);

  const prompt = `You are an IPO document analyst. Extract ALL investment banks and their roles from this Hong Kong IPO application proof document for "${companyName}".

Look for these role categories:
- sponsor (Sole Sponsor, Joint Sponsors)
- coordinator (Overall Coordinator, Joint Overall Coordinators, Global Coordinator)
- bookrunner (Joint Bookrunners, Joint Global Coordinators, Bookrunners and Lead Managers)
- leadManager (Joint Lead Managers, Lead Managers)

IMPORTANT:
- Return the EXACT legal name of each bank as it appears in the document
- Do NOT include "${companyName}" itself as a bank
- A single bank can have multiple roles (e.g., sponsor AND coordinator)
- If a bank has multiple roles, list it once with the highest-priority role (sponsor > coordinator > bookrunner > leadManager)

Return JSON only:
{"banks": [{"bank": "Goldman Sachs (Asia) L.L.C.", "role": "sponsor"}, {"bank": "CLSA Limited", "role": "coordinator"}]}

PDF TEXT:
${truncated}`;

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
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 60000,
      }
    );

    const rawText = response.data.choices?.[0]?.message?.content || '';

    // Strip markdown code blocks that DeepSeek wraps around JSON
    const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[AUDIT] No JSON found in DeepSeek response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.banks || !Array.isArray(parsed.banks)) {
      console.warn('[AUDIT] No banks array in DeepSeek response');
      return [];
    }

    // Validate roles
    const validRoles = new Set(['sponsor', 'coordinator', 'bookrunner', 'leadManager']);
    return parsed.banks
      .filter((b: any) => b.bank && validRoles.has(b.role))
      .map((b: any) => ({
        bank: b.bank.trim(),
        role: b.role as LLMBankResult['role'],
      }));
  } catch (err: any) {
    console.error(`[AUDIT] DeepSeek API error: ${err.message}`);
    return [];
  }
}

// ============================================================
// Internal: Download PDF and extract text
// ============================================================

async function downloadPdfText(pdfUrl: string): Promise<string | null> {
  try {
    const response = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    const buffer = Buffer.from(response.data);
    if (buffer.slice(0, 5).toString() !== '%PDF-') {
      console.log(`[AUDIT] Not a valid PDF: ${pdfUrl}`);
      return null;
    }

    const uint8Array = new Uint8Array(buffer);
    const cMapUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps/');
    const parser = new PDFParse({ data: uint8Array, cMapUrl, cMapPacked: true });
    const result = await parser.getText();

    return result.pages.map((p: { text: string }) => p.text).join('\n');
  } catch (err: any) {
    console.error(`[AUDIT] PDF download/parse error: ${err.message}`);
    return null;
  }
}

// ============================================================
// Internal: Upsert banks into DB
// ============================================================

async function upsertBanks(
  pool: Pool,
  dealId: number,
  banks: BankAppointment[],
  sourceUrl: string | null
): Promise<string[]> {
  const added: string[] = [];

  for (const bank of banks) {
    const { canonical: shortName } = normalizeBankName(bank.bank);
    const bankResult = await pool.query(`
      INSERT INTO banks (name, short_name) VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
      RETURNING id
    `, [bank.bank, shortName]);
    const bankId = bankResult.rows[0].id;

    const insertResult = await pool.query(`
      INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
      VALUES ($1, $2, $3::bank_role[], $4, $5)
      ON CONFLICT (deal_id, bank_id) DO NOTHING
      RETURNING id
    `, [dealId, bankId, bank.roles, bank.isLead, sourceUrl]);

    // Only count as "added" if the row was actually inserted (not a conflict)
    if (insertResult.rows.length > 0) {
      added.push(`${bank.bank} (${bank.roles.join(', ')})`);
    }
  }

  return added;
}

// ============================================================
// Phase 2: Verify and Auto-Fix
// ============================================================

/**
 * For each flagged deal:
 * 1. Re-run regex parser (extractBanksFromPdfUrl) with company name
 * 2. Compare against DB banks
 * 3. If regex finds missing banks -> write to DB
 * 4. If regex finds nothing new -> call DeepSeek LLM as second opinion
 * 5. If LLM finds missing banks -> write to DB
 * 6. Report what was fixed and what's still broken
 */
export async function verifyAndFix(pool: Pool, issues: AuditIssue[]): Promise<{
  fixes: AuditFix[];
  still_broken: { company: string; deal_id: number; reason: string }[];
}> {
  // Dynamically import to avoid circular deps
  const { extractBanksFromPdfUrl } = await import('./hkex-scraper-v2.js');

  const fixes: AuditFix[] = [];
  const still_broken: { company: string; deal_id: number; reason: string }[] = [];

  for (const issue of issues) {
    const { deal_id, company, pdf_url } = issue;

    // Skip deals without a PDF URL — nothing to parse
    if (!pdf_url) {
      still_broken.push({ company, deal_id, reason: 'No PDF URL available' });
      await delay(300);
      continue;
    }

    console.log(`[AUDIT] Verifying: ${company} (deal ${deal_id})`);

    // Get existing banks from DB for comparison
    const existingResult = await pool.query(`
      SELECT b.name
      FROM deal_appointments da
      JOIN banks b ON b.id = da.bank_id
      WHERE da.deal_id = $1
    `, [deal_id]);
    const existingBankNames = new Set(existingResult.rows.map((r: any) => r.name.toLowerCase()));

    // Step 1: Re-run regex parser
    let regexBanks: BankAppointment[] = [];
    try {
      const { banks } = await extractBanksFromPdfUrl(pdf_url, company);
      regexBanks = banks;
    } catch (err: any) {
      console.warn(`[AUDIT] Regex parser failed for ${company}: ${err.message}`);
    }

    // Find banks from regex that are NOT already in DB
    const newRegexBanks = regexBanks.filter(
      b => !existingBankNames.has(b.bank.toLowerCase())
    );

    if (newRegexBanks.length > 0) {
      // Step 2: Regex found missing banks -> write to DB
      console.log(`[AUDIT] Regex found ${newRegexBanks.length} new banks for ${company}`);
      const added = await upsertBanks(pool, deal_id, newRegexBanks, pdf_url);
      if (added.length > 0) {
        fixes.push({
          company,
          deal_id,
          added,
          roles_corrected: [],
        });
      }
    } else {
      // Step 3: Regex found nothing new -> try DeepSeek LLM
      console.log(`[AUDIT] Regex found nothing new for ${company}, trying DeepSeek...`);

      const pdfText = await downloadPdfText(pdf_url);
      if (!pdfText) {
        still_broken.push({ company, deal_id, reason: 'PDF download/parse failed' });
        await delay(300);
        continue;
      }

      const llmBanks = await llmExtractBanks(pdfText, company);
      if (llmBanks.length === 0) {
        still_broken.push({ company, deal_id, reason: 'Neither regex nor LLM found banks' });
        await delay(300);
        continue;
      }

      // Convert LLM results to BankAppointment format
      const newLlmBanks = llmBanks
        .filter(b => !existingBankNames.has(b.bank.toLowerCase()))
        .map(b => {
          const roles = normalizeRole(b.role);
          return {
            bank: b.bank,
            roles,
            isLead: isLeadRole(roles),
          } as BankAppointment;
        });

      if (newLlmBanks.length > 0) {
        console.log(`[AUDIT] DeepSeek found ${newLlmBanks.length} new banks for ${company}`);
        const added = await upsertBanks(pool, deal_id, newLlmBanks, pdf_url);
        if (added.length > 0) {
          fixes.push({
            company,
            deal_id,
            added,
            roles_corrected: [],
          });
        }
      } else {
        // LLM found banks but they were all already in DB — still might have other problems
        const remainingProblems = issue.problems.filter(
          p => !p.startsWith('0 banks') && !p.startsWith('Only 1 bank')
        );
        if (remainingProblems.length > 0) {
          still_broken.push({ company, deal_id, reason: remainingProblems.join('; ') });
        }
      }
    }

    // Rate limiting between deal verifications
    await delay(300);
  }

  console.log(`[AUDIT] Phase 2: ${fixes.length} fixed, ${still_broken.length} still broken`);
  return { fixes, still_broken };
}

// ============================================================
// Phase 3: Combined Audit
// ============================================================

/**
 * Run the full audit:
 * 1. Heuristic flags (Phase 1)
 * 2. Verify and auto-fix (Phase 2)
 * 3. Return combined AuditResult
 */
export async function auditBanks(pool: Pool): Promise<AuditResult> {
  console.log('[AUDIT] Starting bank audit...');

  // Phase 1: Find issues
  const { totalActive, issues } = await runHeuristicFlags(pool);

  if (issues.length === 0) {
    console.log('[AUDIT] No issues found, all active deals look good');
    return {
      summary: { total_active: totalActive, flagged: 0, verified: 0, fixed: 0 },
      issues: [],
      fixes: [],
      still_broken: [],
    };
  }

  // Phase 2: Verify and fix
  const { fixes, still_broken } = await verifyAndFix(pool, issues);

  const result: AuditResult = {
    summary: {
      total_active: totalActive,
      flagged: issues.length,
      verified: issues.length,
      fixed: fixes.length,
    },
    issues,
    fixes,
    still_broken,
  };

  console.log(`[AUDIT] Complete: ${totalActive} active, ${issues.length} flagged, ${fixes.length} fixed, ${still_broken.length} still broken`);
  return result;
}

// ============================================================
// Utility
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
