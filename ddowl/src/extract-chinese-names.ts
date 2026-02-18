/**
 * Extract Chinese Company Names from HKEX Prospectuses
 *
 * This script:
 * 1. Reads Excel Index sheet for ticker → prospectus URL mapping
 * 2. Reads CSV to identify deals missing Chinese names
 * 3. Downloads prospectus PDFs and extracts first 3 pages for agent processing
 * 4. Tracks progress in a JSON file for resume capability
 */

import xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { PDFParse } from 'pdf-parse';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const EXCEL_PATH = path.join(PROJECT_ROOT, 'Reference files/Main Board/Listed/HKEX_IPO_Listed.xlsx');
const CSV_PATH = path.join(PROJECT_ROOT, 'ddowl/public/baseline-enriched.csv');
const PROGRESS_FILE = path.join(PROJECT_ROOT, 'ddowl/chinese-names-progress.json');
const PDF_CACHE_DIR = path.join(PROJECT_ROOT, 'ddowl/pdf-cache');

// Common company name suffixes for validation
const COMPANY_SUFFIXES = [
  '有限公司',
  '股份有限公司',
  '有限責任公司',
  '股份公司',
  '控股有限公司',
  '集團有限公司',
  '公司',
  '控股',
  '集團'
];

/**
 * Check if text looks like a Chinese company name
 * @param text - Chinese text to validate (should be pre-cleaned, no spaces)
 */
export function isCompanyName(text: string): boolean {
  // Must be at least 4 characters (minimum: X公司)
  if (text.length < 3) return false;

  // Must end with a company suffix
  return COMPANY_SUFFIXES.some(suffix => text.endsWith(suffix));
}

// Common Chinese name-like suffixes (broader than strict company suffixes)
const NAME_SUFFIXES = [
  '科技', '醫藥', '生物', '國際', '集團', '控股', '製藥', '電子',
  '半導體', '智能', '新能源', '材料', '食品', '股份', '技術',
];

/**
 * Extract Chinese company name from text using regex
 * - Finds Chinese character sequences
 * - Allows spaces between chars (some PDFs have this)
 * - First tries strict match (ends in 公司/有限公司/控股/etc.)
 * - Falls back to longest Chinese sequence >= 4 chars
 *
 * @param text - Raw text extracted from PDF
 * @returns Chinese company name if found and validated, null otherwise
 */
export function extractChineseNameFromText(text: string): string | null {
  // Match Chinese characters (CJK unified ideographs)
  // Allow spaces between chars (some PDFs have space-separated chars)
  const chinesePattern = /[\u4e00-\u9fff](?:\s*[\u4e00-\u9fff])*/g;

  const matches = text.match(chinesePattern);
  if (!matches) return null;

  const cleaned = matches.map(m => m.replace(/\s+/g, ''));

  // Pass 1: Strict company name (ends with 公司/控股/集團)
  for (const name of cleaned) {
    if (isCompanyName(name)) {
      return name;
    }
  }

  // Pass 2: Longer Chinese sequences ending with common name suffixes (科技/醫藥/國際/etc.)
  for (const name of cleaned) {
    if (name.length >= 4 && NAME_SUFFIXES.some(s => name.endsWith(s))) {
      return name;
    }
  }

  // Pass 3: Longest Chinese sequence >= 4 chars (likely the company name)
  const longest = cleaned.filter(n => n.length >= 4).sort((a, b) => b.length - a.length);
  if (longest.length > 0) {
    return longest[0];
  }

  return null;
}

export interface DealToProcess {
  ticker: string;
  company: string;
  prospectusUrl: string;
}

export interface ExtractionProgress {
  completed: Record<string, string>;  // ticker -> chinese_name
  failed: Record<string, string>;     // ticker -> error message
  pending: string[];                  // tickers yet to process
  lastUpdated: string;
}

export interface ProspectusData {
  ticker: string;
  company: string;
  url: string;
  textContent: string;
  pageCount: number;
}

/**
 * Parse CSV file and extract deals missing Chinese names
 */
function getDealsFromCSV(): Map<string, { company: string; hasChineseName: boolean }> {
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n');
  const deals = new Map<string, { company: string; hasChineseName: boolean }>();

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line (handle quoted values)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const ticker = values[0]?.replace(/"/g, '');
    const company = values[1]?.replace(/"/g, '');
    const companyCn = values[2]?.replace(/"/g, '');

    if (ticker) {
      deals.set(ticker, {
        company: company || '',
        hasChineseName: !!companyCn && companyCn.length > 0
      });
    }
  }

  return deals;
}

/**
 * Parse Excel file and extract ticker → prospectus URL mapping
 */
function getProspectusUrls(): Map<string, { company: string; url: string }> {
  const workbook = xlsx.readFile(EXCEL_PATH);
  const indexSheet = workbook.Sheets['Index'];
  const data = xlsx.utils.sheet_to_json<(string | null)[]>(indexSheet, { header: 1, raw: false });

  const urls = new Map<string, { company: string; url: string }>();

  // Skip header rows (row 0 and 1)
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const ticker = row[1]?.toString();
    const company = row[2]?.toString() || '';
    const url = row[4]?.toString() || '';

    if (ticker && url && url.includes('http')) {
      urls.set(ticker, { company, url });
    }
  }

  return urls;
}

/**
 * Find deals that need Chinese name extraction
 */
export function findDealsToProcess(): DealToProcess[] {
  const csvDeals = getDealsFromCSV();
  const prospectusUrls = getProspectusUrls();

  const dealsToProcess: DealToProcess[] = [];

  for (const [ticker, info] of csvDeals) {
    // Skip if already has Chinese name
    if (info.hasChineseName) continue;

    // Check if we have a prospectus URL
    const prospectusInfo = prospectusUrls.get(ticker);
    if (!prospectusInfo || !prospectusInfo.url) continue;

    dealsToProcess.push({
      ticker,
      company: info.company,
      prospectusUrl: prospectusInfo.url
    });
  }

  return dealsToProcess;
}

/**
 * Load or initialize progress tracking
 */
export function loadProgress(): ExtractionProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }

  const dealsToProcess = findDealsToProcess();
  const progress: ExtractionProgress = {
    completed: {},
    failed: {},
    pending: dealsToProcess.map(d => d.ticker),
    lastUpdated: new Date().toISOString()
  };

  saveProgress(progress);
  return progress;
}

/**
 * Save progress to file
 */
export function saveProgress(progress: ExtractionProgress): void {
  progress.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

/**
 * Download PDF and extract text from first N pages
 */
export async function downloadAndExtractPdf(
  url: string,
  ticker: string,
  maxPages: number = 3
): Promise<{ text: string; pageCount: number }> {
  // Ensure cache directory exists
  if (!fs.existsSync(PDF_CACHE_DIR)) {
    fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
  }

  const cacheFile = path.join(PDF_CACHE_DIR, `${ticker}.pdf`);
  let pdfBuffer: Buffer;

  // Check cache
  if (fs.existsSync(cacheFile)) {
    pdfBuffer = fs.readFileSync(cacheFile);
  } else {
    // Download PDF
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/pdf'
      },
      timeout: 60000
    });

    pdfBuffer = Buffer.from(response.data);

    // Cache the PDF
    fs.writeFileSync(cacheFile, pdfBuffer);
  }

  // Parse PDF
  const uint8Array = new Uint8Array(pdfBuffer);
  const parser = new PDFParse(uint8Array);
  const result = await parser.getText();

  // Get text from first N pages
  const pages = result.pages.slice(0, maxPages);
  const text = pages.map(p => p.text).join('\n\n--- PAGE BREAK ---\n\n');

  return {
    text,
    pageCount: result.pages.length
  };
}

/**
 * Get next batch of deals to process
 */
export function getNextBatch(progress: ExtractionProgress, batchSize: number = 20): DealToProcess[] {
  const dealsToProcess = findDealsToProcess();
  const tickerToInfo = new Map(dealsToProcess.map(d => [d.ticker, d]));

  const batch: DealToProcess[] = [];

  for (const ticker of progress.pending) {
    if (batch.length >= batchSize) break;

    const deal = tickerToInfo.get(ticker);
    if (deal) {
      batch.push(deal);
    }
  }

  return batch;
}

/**
 * Mark a deal as completed with extracted Chinese name
 */
export function markCompleted(
  progress: ExtractionProgress,
  ticker: string,
  chineseName: string
): void {
  progress.completed[ticker] = chineseName;
  progress.pending = progress.pending.filter(t => t !== ticker);
  saveProgress(progress);
}

/**
 * Mark a deal as failed
 */
export function markFailed(
  progress: ExtractionProgress,
  ticker: string,
  error: string
): void {
  progress.failed[ticker] = error;
  progress.pending = progress.pending.filter(t => t !== ticker);
  saveProgress(progress);
}

/**
 * Get statistics about extraction progress
 */
export function getStats(): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  withUrls: number;
  missingChinese: number;
} {
  const csvDeals = getDealsFromCSV();
  const prospectusUrls = getProspectusUrls();
  const progress = loadProgress();

  const missingChinese = Array.from(csvDeals.entries())
    .filter(([_, info]) => !info.hasChineseName).length;

  const withUrls = Array.from(csvDeals.entries())
    .filter(([ticker, info]) => !info.hasChineseName && prospectusUrls.has(ticker)).length;

  return {
    total: csvDeals.size,
    completed: Object.keys(progress.completed).length,
    failed: Object.keys(progress.failed).length,
    pending: progress.pending.length,
    withUrls,
    missingChinese
  };
}

/**
 * Update CSV file with extracted Chinese names
 */
export function updateCSV(): void {
  const progress = loadProgress();
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n');

  const newLines = [lines[0]]; // Keep header

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      newLines.push('');
      continue;
    }

    // Parse the line to get ticker
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);

    const ticker = values[0]?.replace(/"/g, '');
    const existingCn = values[2]?.replace(/"/g, '');

    // Update Chinese name if we have a new one and existing is empty
    if (ticker && progress.completed[ticker] && (!existingCn || existingCn.length === 0)) {
      values[2] = `"${progress.completed[ticker]}"`;
      newLines.push(values.join(','));
    } else {
      newLines.push(line);
    }
  }

  // Write back
  fs.writeFileSync(CSV_PATH, newLines.join('\n'));
  console.log(`Updated CSV with ${Object.keys(progress.completed).length} Chinese names`);
}

// CLI interface
if (process.argv[1].endsWith('extract-chinese-names.ts') ||
    process.argv[1].endsWith('extract-chinese-names.js')) {
  const command = process.argv[2];

  switch (command) {
    case 'stats':
      const stats = getStats();
      console.log('Extraction Statistics:');
      console.log(`  Total deals in CSV: ${stats.total}`);
      console.log(`  Missing Chinese names: ${stats.missingChinese}`);
      console.log(`  With prospectus URLs: ${stats.withUrls}`);
      console.log(`  Completed: ${stats.completed}`);
      console.log(`  Failed: ${stats.failed}`);
      console.log(`  Pending: ${stats.pending}`);
      break;

    case 'list':
      const deals = findDealsToProcess();
      console.log(`Found ${deals.length} deals to process:`);
      deals.slice(0, 20).forEach(d => {
        console.log(`  ${d.ticker}: ${d.company}`);
      });
      if (deals.length > 20) {
        console.log(`  ... and ${deals.length - 20} more`);
      }
      break;

    case 'update-csv':
      updateCSV();
      break;

    case 'reset':
      if (fs.existsSync(PROGRESS_FILE)) {
        fs.unlinkSync(PROGRESS_FILE);
        console.log('Progress reset');
      }
      break;

    default:
      console.log('Usage: tsx extract-chinese-names.ts <command>');
      console.log('Commands:');
      console.log('  stats      - Show extraction statistics');
      console.log('  list       - List deals to process');
      console.log('  update-csv - Update CSV with extracted names');
      console.log('  reset      - Reset progress tracking');
  }
}
