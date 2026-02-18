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
  if (!name) return '';
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
 * Match score combining Jaccard + first-word matching + abbreviation awareness
 * Returns 0-1 score. Handles cases like "IMPRESSION DHP" vs "Impression Dahongpao Co., Ltd."
 */
function matchScore(dealName: string, securityName: string): number {
  const jaccard = jaccardSimilarity(dealName, securityName);
  if (jaccard >= 0.7) return jaccard;

  const normA = normalizeName(dealName);
  const normB = normalizeName(securityName);
  const wordsA = normA.split(' ').filter(Boolean);
  const wordsB = normB.split(' ').filter(Boolean);

  if (wordsA.length === 0 || wordsB.length === 0) return jaccard;

  // First word must match for abbreviation matching
  if (wordsA[0] !== wordsB[0]) return jaccard;

  // If first word matches and one name is a 2-word abbreviation of a longer name,
  // check if the second word is an abbreviation (starts with same letters)
  if (wordsB.length <= 3 && wordsA.length >= 2) {
    const secWord = wordsB[1] || '';
    // Check if any word in the deal name starts with the abbreviation
    const isAbbrev = wordsA.some(w => w.length > secWord.length && w.startsWith(secWord));
    if (isAbbrev) return 0.75;
    // Check if the abbreviation is initials of remaining words
    const initials = wordsA.slice(1).map(w => w[0]).join('');
    if (initials === secWord) return 0.75;
    // Check if abbreviation letters appear in order within a single word
    // e.g. "dahongpao" contains d-h-p in order → matches "DHP"
    for (const w of wordsA.slice(1)) {
      if (secWord.length >= 2 && secWord.length <= 5 && w.length >= secWord.length * 2) {
        let pos = 0;
        let matched = 0;
        for (const ch of secWord) {
          const idx = w.indexOf(ch, pos);
          if (idx === -1) break;
          matched++;
          pos = idx + 1;
        }
        if (matched === secWord.length) return 0.75;
      }
    }
  }

  // Boost if first word matches and there's partial overlap
  if (jaccard >= 0.3) return Math.min(jaccard + 0.2, 0.75);

  return jaccard;
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

  // Fuzzy match using combined scoring (Jaccard + abbreviation awareness)
  const matches: MatchResult[] = [];
  const THRESHOLD = 0.5;

  for (const deal of activeDeals) {
    let bestMatch: { security: ListedSecurity; similarity: number } | null = null;

    for (const sec of securities) {
      const score = matchScore(deal.companyName, sec.nameEn);
      if (score >= THRESHOLD && (!bestMatch || score > bestMatch.similarity)) {
        bestMatch = { security: sec, similarity: score };
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
