/**
 * Backfill Active Deals — OC URLs + Chinese Names + Bank Normalization
 *
 * Phase 1 of the data completeness backfill. Three steps:
 *   1. Scrape OC PDF URLs from HKEX app index (2025+2026) → save to oc_announcements
 *   2. Extract Chinese names from OC PDFs → update companies.name_cn
 *   3. Normalize bank short_name for all banks → update banks.short_name
 *
 * Usage:
 *   npx tsx src/scripts/backfill-active-deals.ts              # dry-run
 *   npx tsx src/scripts/backfill-active-deals.ts --apply       # apply DB updates
 *   npx tsx src/scripts/backfill-active-deals.ts --test 3      # test first 3 per step
 *   npx tsx src/scripts/backfill-active-deals.ts --step 1      # only run step 1
 *   npx tsx src/scripts/backfill-active-deals.ts --step 2      # only run step 2
 *   npx tsx src/scripts/backfill-active-deals.ts --step 3      # only run step 3
 */

import pg from 'pg';
import puppeteer from 'puppeteer';
import { extractBanksFromPdfUrl } from '../hkex-scraper-v2.js';
import { normalizeBankName, KNOWN_BANKS } from '../bank-normalizer.js';

const { Pool } = pg;

// ── Config ──────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@104.199.131.94:5432/ddowl';
const DRY_RUN = !process.argv.includes('--apply');
const TEST_LIMIT = process.argv.includes('--test')
  ? parseInt(process.argv[process.argv.indexOf('--test') + 1]) || 3
  : 0;
const STEP_ONLY = process.argv.includes('--step')
  ? parseInt(process.argv[process.argv.indexOf('--step') + 1]) || 0
  : 0;

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Step 1: Scrape OC PDF URLs from HKEX ────────────────────────────────
interface OcEntry {
  appId: string;
  pdfUrl: string;
  company: string;
  filingDate: string;
}

async function scrapeOcPdfUrls(): Promise<OcEntry[]> {
  console.log('\n=== Step 1: Scrape OC PDF URLs from HKEX ===\n');

  const allEntries: OcEntry[] = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    // Accept HKEX disclaimer
    await page.goto('https://www1.hkexnews.hk/app/appindex.html', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const elements = document.querySelectorAll('button, a, input');
      for (const el of elements) {
        const text = el.textContent?.trim().toUpperCase() || '';
        if (text === 'ACCEPT') {
          (el as HTMLElement).click();
          return;
        }
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    // Scrape 2025 + 2026 Main Board
    for (const year of [2026, 2025]) {
      const url = `https://www1.hkexnews.hk/app/appyearlyindex.html?lang=en&board=mainBoard&year=${year}`;
      console.log(`  Fetching: ${url}`);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));

      const results = await page.evaluate(() => {
        const entries: { appId: string; pdfUrl: string; company: string; filingDate: string }[] = [];
        const rows = document.querySelectorAll('tr');

        rows.forEach(row => {
          const text = row.textContent || '';

          // Extract company name
          const applicantMatch = text.match(/Applicant:\s*(.+?)(?:\d{2}\/\d{2}\/\d{4}|$)/);
          if (!applicantMatch) return;

          const company = applicantMatch[1]
            .replace(/\s*-\s*[AB]\s*$/, '')
            .replace(/\s*\(formerly known as.*\)/i, '')
            .trim();

          // Extract filing date
          const dateMatch = text.match(/Date of First Posting:\s*(\d{2}\/\d{2}\/\d{4})/);
          const filingDate = dateMatch ? dateMatch[1] : '';

          // Find OC announcement PDF links
          const links = row.querySelectorAll('a');
          let ocPdfUrl = '';
          let appId = '';

          links.forEach(link => {
            const linkText = link.textContent?.trim() || '';
            const href = (link as HTMLAnchorElement).href;

            if (linkText.includes('OC Announcement') && href.includes('.pdf')) {
              // Prefer revised OC announcements
              if (!ocPdfUrl || linkText.includes('Revised')) {
                ocPdfUrl = href;
                const appIdMatch = href.match(/\/(\d{6})\//);
                if (appIdMatch) appId = appIdMatch[1];
              }
            }
          });

          if (ocPdfUrl && appId) {
            entries.push({ appId, pdfUrl: ocPdfUrl, company, filingDate });
          }
        });

        return entries;
      });

      // Later entries (revised) overwrite earlier ones via appId
      for (const entry of results) {
        // Check if we already have this appId — keep the latest (revised) one
        const existingIdx = allEntries.findIndex(e => e.appId === entry.appId);
        if (existingIdx >= 0) {
          allEntries[existingIdx] = entry;
        } else {
          allEntries.push(entry);
        }
      }
      console.log(`  Found ${results.length} OC PDFs for ${year}`);
    }

    await page.close();
  } finally {
    await browser.close();
  }

  return allEntries;
}

async function step1_saveOcUrls(ocEntries: OcEntry[]): Promise<{ matched: number; saved: number }> {
  // Get all active deals with hkex_app_id
  const dealsResult = await pool.query(`
    SELECT d.id as deal_id, d.hkex_app_id, d.filing_date, c.name_en
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    WHERE d.status = 'active'
    ORDER BY d.filing_date DESC
  `);

  // Build appId → OC URL map
  const ocMap = new Map<string, OcEntry>();
  for (const entry of ocEntries) {
    ocMap.set(entry.appId, entry);
  }

  console.log(`\nActive deals: ${dealsResult.rows.length}`);
  console.log(`OC entries scraped: ${ocEntries.length}`);

  // Check which deals already have OC announcements
  const existingOcResult = await pool.query(`
    SELECT deal_id FROM oc_announcements
  `);
  const existingOcDealIds = new Set(existingOcResult.rows.map(r => r.deal_id));

  let matched = 0;
  let saved = 0;

  for (const deal of dealsResult.rows) {
    const oc = ocMap.get(deal.hkex_app_id);
    if (!oc) continue;

    matched++;

    // Skip if already has OC announcement
    if (existingOcDealIds.has(deal.deal_id)) continue;

    console.log(`  [${matched}] ${deal.name_en} (${deal.hkex_app_id}) → ${oc.pdfUrl.slice(0, 60)}...`);

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO oc_announcements (deal_id, announcement_date, pdf_url)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [deal.deal_id, deal.filing_date, oc.pdfUrl]);
    }
    saved++;
  }

  return { matched, saved };
}

// ── Step 2: Extract Chinese Names from OC PDFs ─────────────────────────
async function step2_extractChineseNames(): Promise<{ total: number; extracted: number; failed: number }> {
  console.log('\n=== Step 2: Extract Chinese Names from OC PDFs ===\n');

  // Get active deals missing Chinese names that have OC PDFs
  const result = await pool.query(`
    SELECT d.id as deal_id, c.id as company_id, c.name_en, oc.pdf_url
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    JOIN oc_announcements oc ON oc.deal_id = d.id
    WHERE d.status = 'active' AND c.name_cn IS NULL
    ORDER BY d.filing_date DESC
  `);

  let deals = result.rows;
  if (TEST_LIMIT > 0) deals = deals.slice(0, TEST_LIMIT);

  console.log(`Active deals missing CN with OC PDFs: ${deals.length}`);
  if (deals.length === 0) return { total: 0, extracted: 0, failed: 0 };

  let extracted = 0;
  let failed = 0;

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    console.log(`[${i + 1}/${deals.length}] ${deal.name_en}`);

    try {
      const { chineseName } = await extractBanksFromPdfUrl(deal.pdf_url, deal.name_en);

      if (chineseName) {
        console.log(`  → ${chineseName}`);
        if (!DRY_RUN) {
          await pool.query(
            `UPDATE companies SET name_cn = $1, updated_at = NOW() WHERE id = $2 AND name_cn IS NULL`,
            [chineseName, deal.company_id]
          );
        }
        extracted++;
      } else {
        console.log(`  → No Chinese name found in PDF`);
        failed++;
      }
    } catch (err: any) {
      console.log(`  → Error: ${err.message}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  return { total: deals.length, extracted, failed };
}

// ── Step 3: Normalize Bank short_name ───────────────────────────────────
async function step3_normalizeBankNames(): Promise<{ total: number; updated: number; alreadySet: number }> {
  console.log('\n=== Step 3: Normalize Bank short_name ===\n');

  // Get all banks
  const result = await pool.query(`
    SELECT id, name, short_name FROM banks ORDER BY name
  `);

  const banks = result.rows;
  console.log(`Total banks: ${banks.length}`);

  let updated = 0;
  let alreadySet = 0;

  for (const bank of banks) {
    if (bank.short_name) {
      alreadySet++;
      continue;
    }

    const { canonical } = normalizeBankName(bank.name);

    // Only update if we got a meaningful short name (different from just stripping "Limited")
    // The normalizer returns cleaned version even for unknowns, so check if it matches a known bank
    const isKnownBank = Object.keys(KNOWN_BANKS).includes(canonical);

    if (isKnownBank || canonical !== bank.name) {
      console.log(`  ${bank.name} → ${canonical}`);
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE banks SET short_name = $1, updated_at = NOW() WHERE id = $2`,
          [canonical, bank.id]
        );
      }
      updated++;
    }
  }

  return { total: banks.length, updated, alreadySet };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Backfill Active Deals ===');
  console.log(`Database: ddowl`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --apply to write)' : 'APPLYING CHANGES'}`);
  if (TEST_LIMIT > 0) console.log(`Test limit: ${TEST_LIMIT} per step`);
  if (STEP_ONLY > 0) console.log(`Running only step ${STEP_ONLY}`);

  let step1Stats = { matched: 0, saved: 0 };
  let step2Stats = { total: 0, extracted: 0, failed: 0 };
  let step3Stats = { total: 0, updated: 0, alreadySet: 0 };

  // Step 1: Scrape OC URLs and save to oc_announcements
  if (!STEP_ONLY || STEP_ONLY === 1) {
    const ocEntries = await scrapeOcPdfUrls();
    step1Stats = await step1_saveOcUrls(ocEntries);
  }

  // Step 2: Extract Chinese names from OC PDFs
  if (!STEP_ONLY || STEP_ONLY === 2) {
    step2Stats = await step2_extractChineseNames();
  }

  // Step 3: Normalize bank short_name
  if (!STEP_ONLY || STEP_ONLY === 3) {
    step3Stats = await step3_normalizeBankNames();
  }

  // Summary
  console.log('\n=== Summary ===');
  if (!STEP_ONLY || STEP_ONLY === 1) {
    console.log(`Step 1 (OC URLs):      ${step1Stats.matched} matched, ${step1Stats.saved} new OC records ${DRY_RUN ? 'would be' : ''} saved`);
  }
  if (!STEP_ONLY || STEP_ONLY === 2) {
    console.log(`Step 2 (Chinese names): ${step2Stats.extracted}/${step2Stats.total} extracted (${step2Stats.failed} failed)`);
  }
  if (!STEP_ONLY || STEP_ONLY === 3) {
    console.log(`Step 3 (Bank names):    ${step3Stats.updated}/${step3Stats.total} updated (${step3Stats.alreadySet} already set)`);
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN COMPLETE ===');
    console.log('Run with --apply to update the database.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
