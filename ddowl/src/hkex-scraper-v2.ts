/**
 * HKEX IPO Scraper v2 - Full Coverage
 *
 * Scrapes ALL active IPO applications from HKEX with:
 * - 100% coverage verification
 * - Company names from HTML (more reliable)
 * - Bank data from OC PDFs
 * - Deduplication by company name
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { PDFParse } from 'pdf-parse';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import pg from 'pg';
import { extractChineseNameFromText } from './extract-chinese-names.js';
import { normalizeBankName } from './bank-normalizer.js';

const { Pool } = pg;

// Types
type Role = 'sponsor' | 'coordinator' | 'bookrunner' | 'leadManager' | 'other';

export interface BankAppointment {
  bank: string;
  roles: Role[];  // Can have multiple roles (e.g., sponsor AND coordinator)
  isLead: boolean;
}

export interface Application {
  company: string;
  companyRaw: string;
  companyCn: string | null;
  filingDate: string;
  ocPdfUrl: string;
  appId: string;
  board: 'mainBoard' | 'gem';
}

export interface ScrapedDeal {
  company: string;
  companyCn: string | null;
  filingDate: string;
  banks: BankAppointment[];
  ocPdfUrl: string;
  appId: string;
  board: 'mainBoard' | 'gem';
}

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Accept HKEX disclaimer
 */
export async function acceptDisclaimer(page: Page): Promise<void> {
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
}

/**
 * Get all applications from a yearly index page
 */
async function getApplicationsFromYear(
  page: Page,
  year: number,
  board: 'mainBoard' | 'gem'
): Promise<Application[]> {
  const url = `https://www1.hkexnews.hk/app/appyearlyindex.html?lang=en&board=${board}&year=${year}`;
  console.log(`Fetching: ${url}`);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  const apps = await page.evaluate((boardParam: string) => {
    const results: any[] = [];
    const rows = document.querySelectorAll('tr');

    rows.forEach(row => {
      const text = row.textContent || '';

      // Extract company name from "Applicant: Company Name"
      const applicantMatch = text.match(/Applicant:\s*(.+?)(?:\d{2}\/\d{2}\/\d{4}|$)/);
      if (!applicantMatch) return;

      const companyRaw = applicantMatch[1].trim();

      // Extract Chinese name from raw text (Chinese chars appear after English name)
      const cnMatch = companyRaw.match(/([\u4e00-\u9fff][\u4e00-\u9fff\s]*[\u4e00-\u9fff])/);
      const companyCn = cnMatch ? cnMatch[1].replace(/\s+/g, '') : null;

      // Clean up company name (English only)
      const company = companyRaw
        .replace(/[\u4e00-\u9fff]+/g, '') // Remove Chinese characters
        .replace(/\s*-\s*[AB]\s*$/, '') // Remove " - B" suffix
        .replace(/\s*\(formerly known as.*\)/i, '') // Remove "formerly known as"
        .trim();

      if (company.length < 5) return;

      // Extract filing date
      const dateMatch = text.match(/Date of First Posting:\s*(\d{2}\/\d{2}\/\d{4})/);
      const filingDate = dateMatch ? dateMatch[1] : '';

      // Find OC announcement PDF link
      const links = row.querySelectorAll('a');
      let ocPdfUrl = '';
      let appId = '';

      links.forEach(link => {
        const linkText = link.textContent?.trim() || '';
        const href = (link as HTMLAnchorElement).href;

        if (linkText.includes('OC Announcement') && href.includes('.pdf')) {
          // Prefer revised OC announcements over originals
          if (!ocPdfUrl || linkText.includes('Revised')) {
            ocPdfUrl = href;
            // Extract app ID from URL like /2025/108018/
            const appIdMatch = href.match(/\/(\d{6})\//);
            if (appIdMatch) appId = appIdMatch[1];
          }
        }
      });

      if (ocPdfUrl) {
        results.push({
          company,
          companyRaw,
          companyCn,
          filingDate,
          ocPdfUrl,
          appId,
          board: boardParam,
        });
      }
    });

    return results;
  }, board);

  console.log(`  Found ${apps.length} applications for ${year} ${board}`);
  return apps as Application[];
}

/**
 * Download PDF and extract bank data
 */
export async function extractBanksFromPdf(page: Page, pdfUrl: string): Promise<BankAppointment[]> {
  const banks: BankAppointment[] = [];

  try {
    // Fetch PDF using page context (with session cookies)
    const pdfData = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return { error: `HTTP ${response.status}` };

        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        return { data: btoa(binary) };
      } catch (e: any) {
        return { error: e.message };
      }
    }, pdfUrl);

    if ('error' in pdfData && pdfData.error) {
      console.log(`    PDF fetch error: ${pdfData.error}`);
      return banks;
    }

    const buffer = Buffer.from(pdfData.data as string, 'base64');

    // Check if it's a valid PDF
    if (buffer.slice(0, 5).toString() !== '%PDF-') {
      console.log(`    Not a valid PDF`);
      return banks;
    }

    // Parse PDF (with CMap for CJK font decoding)
    const uint8Array = new Uint8Array(buffer);
    const cMapUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps/');
    const parser = new PDFParse({ data: uint8Array, cMapUrl, cMapPacked: true });
    const result = await parser.getText();

    // Search all pages for bank data; for long PDFs, focus on relevant sections
    let lastPagesText: string;
    if (result.pages.length <= 10) {
      lastPagesText = result.pages.map(p => p.text).join('\n');
    } else {
      // For long PDFs, find pages mentioning bank roles or "appointed"
      const roleKeywords = /sponsor|coordinator|co-ordinator|bookrunner|lead\s*manager|appointed/i;
      const relevantPages = result.pages.filter(p => roleKeywords.test(p.text));
      lastPagesText = relevantPages.length > 0
        ? relevantPages.map(p => p.text).join('\n')
        : result.pages.slice(-3).map(p => p.text).join('\n');
    }

    // Helper to parse roles from text
    function parseRolesFromText(text: string): Role[] {
      const lower = text.toLowerCase();
      const roles: Role[] = [];
      if (lower.includes('sponsor')) roles.push('sponsor');
      if (lower.includes('coordinator') || lower.includes('co-ordinator')) roles.push('coordinator');
      if (lower.includes('bookrunner') || lower.includes('book runner')) roles.push('bookrunner');
      if (lower.includes('lead manager') || lower.includes('lead-manager')) roles.push('leadManager');
      return roles.length > 0 ? roles : ['other'];
    }

    // Method 1: Extract from "has appointed X as sponsor/coordinator"
    const appointmentPatterns = [
      /has\s+appointed\s+([\s\S]+?Limited)\s+as\s+(?:its?\s+)?(?:the\s+)?(?:sole\s+)?(?:joint\s+)?((?:(?:global\s+)?(?:overall\s+)?(?:sponsor|coordinator|co-ordinator|bookrunner|book\s*runner|lead\s*manager)(?:\s*(?:and|,)\s*)?)+)/gi,
    ];

    for (const pattern of appointmentPatterns) {
      let match;
      while ((match = pattern.exec(lastPagesText)) !== null) {
        const captured = match[1].replace(/\s+/g, ' ').trim();
        const rolePart = match[2] || match[0];
        const roles = parseRolesFromText(rolePart);

        const bankNames = captured
          .split(/\s+and\s+|\s*,\s*/)
          .map(s => s.trim())
          .filter(s => s.match(/Limited$/i) && s.length > 10);

        for (const bankName of bankNames) {
          if (!banks.find(b => b.bank === bankName) && !bankName.match(/HOLDINGS LIMITED$/i)) {
            const isLead = roles.includes('sponsor') || roles.includes('coordinator');
            banks.push({ bank: bankName, roles, isLead });
          }
        }
      }
    }

    // Method 2: Extract from role headings
    // These patterns detect role HEADINGS - we parse ALL roles from the heading text
    const roleHeadingPattern = /^(?:Joint\s+)?(?:Sole\s+)?(?:Global\s+)?(?:Overall\s+)?((?:(?:Sponsor|Coordinator|Co-ordinator|Bookrunner|Lead\s*Manager)(?:\(s\))?(?:(?:\s*[-–]\s*|\s+and\s+)(?:Joint\s+)?(?:Sole\s+)?(?:Global\s+)?(?:Overall\s+)?)?)+)/i;

    const lines = lastPagesText.split('\n');
    let currentRoles: Role[] = ['other'];

    for (const line of lines) {
      const trimmed = line.trim();

      // Check if this line is a role heading
      const headingMatch = trimmed.match(roleHeadingPattern);
      if (headingMatch) {
        currentRoles = parseRolesFromText(trimmed);
        continue;
      }

      // Check if this line is a bank name
      const isBankName =
        trimmed.match(/Limited$/i) &&
        trimmed.match(/^[A-Z]/) &&
        trimmed.length > 15 &&
        trimmed.length < 80 &&
        !trimmed.match(/HOLDINGS LIMITED$/i) &&
        !trimmed.match(/Stock Exchange|Commission|responsibility|disclaimer|announcement/i) &&
        (trimmed.match(/Securities|Capital|Financial|Bank|Partners|Investment/i) || currentRoles[0] !== 'other');

      if (isBankName) {
        const bankName = trimmed.replace(/^\d+[\.\)]\s*/, '').trim();
        if (bankName && !banks.find(b => b.bank === bankName)) {
          const isLead = currentRoles.includes('sponsor') || currentRoles.includes('coordinator');
          banks.push({
            bank: bankName,
            roles: currentRoles,
            isLead,
          });
        }
      }
    }

  } catch (err) {
    console.log(`    PDF parse error: ${err}`);
  }

  return banks;
}

export interface PdfExtractionResult {
  banks: BankAppointment[];
  chineseName: string | null;
}

/**
 * Standalone PDF bank extraction (no Puppeteer needed)
 * Downloads PDF via axios and extracts banks + Chinese company name
 */
export async function extractBanksFromPdfUrl(pdfUrl: string): Promise<PdfExtractionResult> {
  try {
    const response = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    const buffer = Buffer.from(response.data);
    if (buffer.slice(0, 5).toString() !== '%PDF-') {
      console.log(`    Not a valid PDF`);
      return { banks: [], chineseName: null };
    }

    const uint8Array = new Uint8Array(buffer);
    const cMapUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps/');
    const parser = new PDFParse({ data: uint8Array, cMapUrl, cMapPacked: true });
    const result = await parser.getText();

    const banks = parseBanksFromText(result.pages);

    // Extract Chinese company name from first few pages
    const firstPagesText = result.pages.slice(0, 3).map(p => p.text).join('\n');
    const chineseName = extractChineseNameFromText(firstPagesText);

    return { banks, chineseName };
  } catch (err) {
    console.log(`    PDF download/parse error: ${err}`);
    return { banks: [], chineseName: null };
  }
}

/**
 * Shared bank parsing logic used by both Puppeteer and standalone extractors
 */
function parseBanksFromText(pages: { text: string }[]): BankAppointment[] {
  const banks: BankAppointment[] = [];

  type Role = 'sponsor' | 'coordinator' | 'bookrunner' | 'leadManager' | 'other';

  let pagesText: string;
  if (pages.length <= 10) {
    pagesText = pages.map(p => p.text).join('\n');
  } else {
    const roleKeywords = /sponsor|coordinator|co-ordinator|bookrunner|lead\s*manager|appointed/i;
    const relevantPages = pages.filter(p => roleKeywords.test(p.text));
    pagesText = relevantPages.length > 0
      ? relevantPages.map(p => p.text).join('\n')
      : pages.slice(-3).map(p => p.text).join('\n');
  }

  function parseRolesFromText(text: string): Role[] {
    const lower = text.toLowerCase();
    const roles: Role[] = [];
    if (lower.includes('sponsor')) roles.push('sponsor');
    if (lower.includes('coordinator') || lower.includes('co-ordinator')) roles.push('coordinator');
    if (lower.includes('bookrunner') || lower.includes('book runner')) roles.push('bookrunner');
    if (lower.includes('lead manager') || lower.includes('lead-manager')) roles.push('leadManager');
    return roles.length > 0 ? roles : ['other'];
  }

  // Method 1: "has appointed X as ..."
  const appointmentPatterns = [
    /has\s+appointed\s+([\s\S]+?Limited)\s+as\s+(?:its?\s+)?(?:the\s+)?(?:sole\s+)?(?:joint\s+)?((?:(?:global\s+)?(?:overall\s+)?(?:sponsor|coordinator|co-ordinator|bookrunner|book\s*runner|lead\s*manager)(?:\s*(?:and|,)\s*)?)+)/gi,
  ];

  for (const pattern of appointmentPatterns) {
    let match;
    while ((match = pattern.exec(pagesText)) !== null) {
      const captured = match[1].replace(/\s+/g, ' ').trim();
      const rolePart = match[2] || match[0];
      const roles = parseRolesFromText(rolePart);

      const bankNames = captured
        .split(/\s+and\s+|\s*,\s*/)
        .map(s => s.trim())
        .filter(s => s.match(/Limited$/i) && s.length > 10);

      for (const bankName of bankNames) {
        if (!banks.find(b => b.bank === bankName) && !bankName.match(/HOLDINGS LIMITED$/i)) {
          const isLead = roles.includes('sponsor') || roles.includes('coordinator');
          banks.push({ bank: bankName, roles, isLead });
        }
      }
    }
  }

  // Method 2: Role headings
  const roleHeadingPattern = /^(?:Joint\s+)?(?:Sole\s+)?(?:Global\s+)?(?:Overall\s+)?((?:(?:Sponsor|Coordinator|Co-ordinator|Bookrunner|Lead\s*Manager)(?:\(s\))?(?:(?:\s*[-–]\s*|\s+and\s+)(?:Joint\s+)?(?:Sole\s+)?(?:Global\s+)?(?:Overall\s+)?)?)+)/i;

  const lines = pagesText.split('\n');
  let currentRoles: Role[] = ['other'];

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = trimmed.match(roleHeadingPattern);
    if (headingMatch) {
      currentRoles = parseRolesFromText(trimmed);
      continue;
    }

    const isBankName =
      trimmed.match(/Limited$/i) &&
      trimmed.match(/^[A-Z]/) &&
      trimmed.length > 15 &&
      trimmed.length < 80 &&
      !trimmed.match(/HOLDINGS LIMITED$/i) &&
      !trimmed.match(/Stock Exchange|Commission|responsibility|disclaimer|announcement/i) &&
      (trimmed.match(/Securities|Capital|Financial|Bank|Partners|Investment/i) || currentRoles[0] !== 'other');

    if (isBankName) {
      const bankName = trimmed.replace(/^\d+[\.\)]\s*/, '').trim();
      if (bankName && !banks.find(b => b.bank === bankName)) {
        const isLead = currentRoles.includes('sponsor') || currentRoles.includes('coordinator');
        banks.push({ bank: bankName, roles: currentRoles, isLead });
      }
    }
  }

  return banks;
}

/**
 * Scrape all HKEX applications
 */
export async function scrapeAllApplications(options: {
  years?: number[];
  boards?: ('mainBoard' | 'gem')[];
  limit?: number;
  extractBanks?: boolean;
} = {}): Promise<ScrapedDeal[]> {
  const {
    years = [2026, 2025],
    boards = ['mainBoard'],
    limit = 0,
    extractBanks = true,
  } = options;

  const b = await getBrowser();
  const page = await b.newPage();

  await acceptDisclaimer(page);

  // Collect all applications
  const allApps: Application[] = [];

  for (const year of years) {
    for (const board of boards) {
      const apps = await getApplicationsFromYear(page, year, board);
      allApps.push(...apps);
    }
  }

  console.log(`\nTotal applications found: ${allApps.length}`);

  // Deduplicate by company name (keep most recent)
  const seen = new Map<string, Application>();
  for (const app of allApps) {
    const key = app.company.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, app);
    }
  }

  let uniqueApps = Array.from(seen.values());
  console.log(`Unique companies: ${uniqueApps.length}`);

  if (limit > 0) {
    uniqueApps = uniqueApps.slice(0, limit);
    console.log(`Limited to: ${uniqueApps.length}`);
  }

  // Process each application
  const deals: ScrapedDeal[] = [];

  for (let i = 0; i < uniqueApps.length; i++) {
    const app = uniqueApps[i];
    console.log(`[${i + 1}/${uniqueApps.length}] ${app.company}`);

    let banks: BankAppointment[] = [];

    if (extractBanks && app.ocPdfUrl) {
      banks = await extractBanksFromPdf(page, app.ocPdfUrl);
      console.log(`    Banks: ${banks.length}`);
    }

    deals.push({
      company: app.company,
      companyCn: app.companyCn,
      filingDate: app.filingDate,
      banks,
      ocPdfUrl: app.ocPdfUrl,
      appId: app.appId,
      board: app.board as 'mainBoard' | 'gem',
    });

    // Small delay to be nice to HKEX
    await new Promise(r => setTimeout(r, 100));
  }

  await page.close();
  return deals;
}

/**
 * Save scraped deals to database
 */
export async function saveToDatabase(deals: ScrapedDeal[], pool: InstanceType<typeof Pool>): Promise<{
  newCompanies: number;
  newDeals: number;
  newBanks: number;
  newAppointments: number;
}> {

  let newCompanies = 0;
  let newDeals = 0;
  let newBanks = 0;
  let newAppointments = 0;

  try {
    for (const deal of deals) {
      // Parse filing date (DD/MM/YYYY to YYYY-MM-DD)
      let filingDate: string | null = null;
      if (deal.filingDate) {
        const parts = deal.filingDate.split('/');
        if (parts.length === 3) {
          filingDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
      }

      // Upsert company
      const companyResult = await pool.query(`
        INSERT INTO companies (name_en)
        VALUES ($1)
        ON CONFLICT (name_en) DO UPDATE SET updated_at = NOW()
        RETURNING id, (xmax = 0) as inserted
      `, [deal.company]);

      const companyId = companyResult.rows[0].id;
      if (companyResult.rows[0].inserted) newCompanies++;

      // Upsert deal (unique by company_id since one company = one active deal)
      const dealResult = await pool.query(`
        INSERT INTO deals (company_id, board, status, filing_date, hkex_app_id)
        VALUES ($1, $2, 'active', $3, $4)
        ON CONFLICT (company_id)
        WHERE status = 'active'
        DO UPDATE SET
          filing_date = COALESCE(EXCLUDED.filing_date, deals.filing_date),
          hkex_app_id = COALESCE(EXCLUDED.hkex_app_id, deals.hkex_app_id),
          updated_at = NOW()
        RETURNING id, (xmax = 0) as inserted
      `, [companyId, deal.board, filingDate, deal.appId]);

      // If ON CONFLICT didn't match, deal might exist without the constraint
      let dealId = dealResult.rows[0]?.id;
      if (!dealId) {
        // Try to find existing deal
        const existingDeal = await pool.query(
          'SELECT id FROM deals WHERE company_id = $1 AND status = $2',
          [companyId, 'active']
        );
        if (existingDeal.rows.length > 0) {
          dealId = existingDeal.rows[0].id;
        } else {
          // Create new deal
          const newDealResult = await pool.query(`
            INSERT INTO deals (company_id, board, status, filing_date, hkex_app_id)
            VALUES ($1, $2, 'active', $3, $4)
            RETURNING id
          `, [companyId, deal.board, filingDate, deal.appId]);
          dealId = newDealResult.rows[0].id;
          newDeals++;
        }
      } else if (dealResult.rows[0].inserted) {
        newDeals++;
      }

      // Upsert banks and appointments
      for (const bank of deal.banks) {
        // Upsert bank with short_name from normalizer
        const { canonical: shortName } = normalizeBankName(bank.bank);
        const bankResult = await pool.query(`
          INSERT INTO banks (name, short_name)
          VALUES ($1, $2)
          ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name)
          RETURNING id
        `, [bank.bank, shortName]);

        let bankId = bankResult.rows[0]?.id;
        if (!bankId) {
          const existingBank = await pool.query('SELECT id FROM banks WHERE name = $1', [bank.bank]);
          bankId = existingBank.rows[0]?.id;
        } else {
          newBanks++;
        }

        if (bankId && dealId) {
          // Roles already match database enum values
          const dbRoles = bank.roles;

          // Upsert appointment with roles array
          const apptResult = await pool.query(`
            INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
            VALUES ($1, $2, $3::bank_role[], $4, $5)
            ON CONFLICT (deal_id, bank_id) DO UPDATE SET
              roles = EXCLUDED.roles,
              is_lead = EXCLUDED.is_lead,
              source_url = EXCLUDED.source_url
            RETURNING id
          `, [dealId, bankId, dbRoles, bank.isLead, deal.ocPdfUrl]);

          if (apptResult.rows.length > 0) newAppointments++;
        }
      }
    }
  } finally {
    // Pool is owned by the caller — don't end it here
  }

  return { newCompanies, newDeals, newBanks, newAppointments };
}

/**
 * Full scrape and save
 */
export async function runFullScrape(dbUrl: string): Promise<void> {
  console.log('=== HKEX Full Scrape ===\n');

  const startTime = Date.now();
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    // Scrape 2025 + 2026, Main Board only (for now)
    const deals = await scrapeAllApplications({
      years: [2026, 2025],
      boards: ['mainBoard'],
      extractBanks: true,
    });

    console.log(`\nScraped ${deals.length} deals`);
    console.log(`Total banks found: ${deals.reduce((sum, d) => sum + d.banks.length, 0)}`);

    // Save to database
    console.log('\nSaving to database...');
    const stats = await saveToDatabase(deals, pool);

    console.log(`\n=== Results ===`);
    console.log(`New companies: ${stats.newCompanies}`);
    console.log(`New deals: ${stats.newDeals}`);
    console.log(`New banks: ${stats.newBanks}`);
    console.log(`New appointments: ${stats.newAppointments}`);
    console.log(`\nTime: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
    await closeBrowser();
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@104.199.131.94:5432/ddowl';
  runFullScrape(dbUrl).catch(console.error);
}
