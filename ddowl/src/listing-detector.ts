/**
 * Listing Detector
 *
 * Checks active IPO deals against the HKEX Securities List to detect
 * newly listed companies. When a match is found, updates the deal
 * status from 'active' to 'listed' with listing date and stock code.
 */

import axios from 'axios';
import xlsx from 'xlsx';
import pg from 'pg';

const HKEX_SECURITIES_URL = 'https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx';

interface ListedSecurity {
  stockCode: string;
  nameEn: string;
  listingDate: string; // YYYY-MM-DD
}

interface ActiveDeal {
  dealId: number;
  companyName: string;
}

interface MatchResult {
  dealId: number;
  companyName: string;
  stockCode: string;
  listingDate: string;
  matchedName: string;
  similarity: number;
}

/**
 * Normalize company name for fuzzy matching
 * Strips common suffixes, punctuation, and normalizes whitespace
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(co\.?,?\s*ltd\.?|limited|inc\.?|corp\.?|corporation|group|holdings?\s*(co\.?\s*)?ltd\.?|plc)\b/gi, '')
    .replace(/[,.()\-'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard word similarity — ratio of shared words to total unique words
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeName(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeName(b).split(' ').filter(Boolean));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/**
 * Download and parse HKEX Securities List XLSX
 */
async function downloadSecuritiesList(): Promise<ListedSecurity[]> {
  console.log('Downloading HKEX Securities List...');

  const response = await axios.get(HKEX_SECURITIES_URL, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  const workbook = xlsx.read(Buffer.from(response.data), { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

  // Find header row (contains "Stock Code" or similar)
  let headerRow = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const rowText = (rows[i] || []).join(' ').toLowerCase();
    if (rowText.includes('stock code') || rowText.includes('name of securities')) {
      headerRow = i;
      break;
    }
  }

  const securities: ListedSecurity[] = [];

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;

    const stockCode = String(row[0]).trim();
    const nameEn = String(row[1] || '').trim();

    // Parse listing date — try column 5 or wherever it appears
    let listingDate = '';
    for (let col = 2; col < row.length; col++) {
      const val = row[col];
      if (val instanceof Date) {
        listingDate = val.toISOString().split('T')[0];
        break;
      }
      if (typeof val === 'string' && /\d{2}\/\d{2}\/\d{4}/.test(val)) {
        const parts = val.split('/');
        listingDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        break;
      }
    }

    if (stockCode && nameEn && /^\d+$/.test(stockCode)) {
      securities.push({ stockCode, nameEn, listingDate });
    }
  }

  console.log(`Parsed ${securities.length} securities from HKEX list`);
  return securities;
}

/**
 * Main listing check function
 */
export async function checkListings(pool: pg.Pool): Promise<{
  checked: number;
  matches: MatchResult[];
}> {
  // Get active deals
  const activeResult = await pool.query(`
    SELECT d.id as deal_id, c.name_en as company_name
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    WHERE d.status = 'active'
  `);

  const activeDeals: ActiveDeal[] = activeResult.rows;
  console.log(`Found ${activeDeals.length} active deals to check`);

  if (activeDeals.length === 0) {
    return { checked: 0, matches: [] };
  }

  // Download securities list
  const securities = await downloadSecuritiesList();

  // Fuzzy match
  const matches: MatchResult[] = [];
  const THRESHOLD = 0.7;

  for (const deal of activeDeals) {
    let bestMatch: { security: ListedSecurity; similarity: number } | null = null;

    for (const sec of securities) {
      const similarity = jaccardSimilarity(deal.companyName, sec.nameEn);
      if (similarity >= THRESHOLD && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { security: sec, similarity };
      }
    }

    if (bestMatch) {
      matches.push({
        dealId: deal.dealId,
        companyName: deal.companyName,
        stockCode: bestMatch.security.stockCode,
        listingDate: bestMatch.security.listingDate,
        matchedName: bestMatch.security.nameEn,
        similarity: bestMatch.similarity,
      });
    }
  }

  console.log(`Found ${matches.length} matches`);

  // Update matched deals
  for (const match of matches) {
    await pool.query(`
      UPDATE deals SET
        status = 'listed',
        listing_date = $2,
        updated_at = NOW()
      WHERE id = $1
    `, [match.dealId, match.listingDate || null]);

    // Update stock_code on company
    await pool.query(`
      UPDATE companies SET
        stock_code = $2,
        updated_at = NOW()
      WHERE id = (SELECT company_id FROM deals WHERE id = $1)
    `, [match.dealId, match.stockCode]);

    console.log(`  Updated deal ${match.dealId}: ${match.companyName} → ${match.stockCode} (${(match.similarity * 100).toFixed(0)}% match)`);
  }

  return { checked: activeDeals.length, matches };
}
