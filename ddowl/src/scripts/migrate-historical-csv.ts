/**
 * Migrate Historical Deals from baseline-enriched.csv → Database
 *
 * Usage: npx tsx src/scripts/migrate-historical-csv.ts
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, '../../public/baseline-enriched.csv');
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@35.194.142.132:5432/ddowl';

interface CsvRow {
  ticker: string;
  company: string;
  company_cn: string;
  industry: string;
  sub_industry: string;
  sector: string;
  deal_type: string;
  type: string;
  date: string;
  shares: string;
  price_hkd: string;
  size_hkdm: string;
  sponsors: string;
  others: string;
  prospectus_url: string;
  is_dual_listing: string;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function readCSV(): CsvRow[] {
  const text = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const headers = parseCSVLine(lines[0]);

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row: any = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Parse DD/MM/YYYY date to YYYY-MM-DD
 */
function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return null;
}

async function run() {
  const rows = readCSV();
  console.log(`Read ${rows.length} rows from CSV`);

  const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  console.log('Connected to database');

  let imported = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (i < 3) console.log(`  [${i}] Processing: ${row.ticker} ${row.company}`);
      await client.query('BEGIN');
      if (i < 3) console.log(`  [${i}] BEGIN ok`);

      // Upsert company
      const companyResult = await client.query(`
        INSERT INTO companies (name_en, name_cn, sector, industry, sub_industry, stock_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name_en) DO UPDATE SET
          name_cn = COALESCE(EXCLUDED.name_cn, companies.name_cn),
          sector = COALESCE(EXCLUDED.sector, companies.sector),
          industry = COALESCE(EXCLUDED.industry, companies.industry),
          sub_industry = COALESCE(EXCLUDED.sub_industry, companies.sub_industry),
          stock_code = COALESCE(EXCLUDED.stock_code, companies.stock_code),
          updated_at = NOW()
        RETURNING id
      `, [
        row.company,
        row.company_cn || null,
        row.sector || null,
        row.industry || null,
        row.sub_industry || null,
        row.ticker || null,
      ]);
      const companyId = companyResult.rows[0].id;

      // Parse size_hkdm — may be numeric or a label like "Introduction"
      const sizeNum = parseFloat(row.size_hkdm);
      const sizeHkdm = isNaN(sizeNum) ? null : sizeNum;

      const sharesNum = parseFloat(row.shares);
      const shares = isNaN(sharesNum) ? null : sharesNum;

      const priceNum = parseFloat(row.price_hkd);
      const price = isNaN(priceNum) ? null : priceNum;

      const listingDate = parseDate(row.date);

      // Insert deal — no unique constraint on listed deals, just insert
      // Check if already exists first (idempotent re-runs)
      const existing = await client.query(
        'SELECT id FROM deals WHERE company_id = $1 AND status = $2 LIMIT 1',
        [companyId, 'listed']
      );

      let dealId: number;
      if (existing.rows.length > 0) {
        dealId = existing.rows[0].id;
        await client.query(`
          UPDATE deals SET
            deal_type = COALESCE($2, deal_type),
            listing_date = COALESCE($3, listing_date),
            shares_offered = COALESCE($4, shares_offered),
            price_hkd = COALESCE($5, price_hkd),
            size_hkdm = COALESCE($6, size_hkdm),
            is_dual_listing = $7,
            prospectus_url = COALESCE($8, prospectus_url),
            updated_at = NOW()
          WHERE id = $1
        `, [dealId, row.deal_type || row.type || null, listingDate, shares, price, sizeHkdm, row.is_dual_listing === 'Y', row.prospectus_url || null]);
      } else {
        const newDeal = await client.query(`
          INSERT INTO deals (company_id, status, deal_type, listing_date, shares_offered, price_hkd, size_hkdm, is_dual_listing, prospectus_url)
          VALUES ($1, 'listed', $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, [companyId, row.deal_type || row.type || null, listingDate, shares, price, sizeHkdm, row.is_dual_listing === 'Y', row.prospectus_url || null]);
        dealId = newDeal.rows[0].id;
      }

      // Insert bank appointments
      const allBanks = [
        ...((row.sponsors || '').split('; ').filter(Boolean).map(b => ({ name: b, role: 'sponsor' as const }))),
        ...((row.others || '').split('; ').filter(Boolean).map(b => ({ name: b, role: 'other' as const }))),
      ];

      for (const bank of allBanks) {
        const bankResult = await client.query(`
          INSERT INTO banks (name)
          VALUES ($1)
          ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `, [bank.name]);
        const bankId = bankResult.rows[0].id;

        await client.query(`
          INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
          VALUES ($1, $2, $3::bank_role[], $4, $5)
          ON CONFLICT (deal_id, bank_id) DO UPDATE SET
            roles = EXCLUDED.roles,
            is_lead = EXCLUDED.is_lead
        `, [dealId, bankId, [bank.role], bank.role === 'sponsor', row.prospectus_url || null]);
      }

      await client.query('COMMIT');
      imported++;

      if (imported % 100 === 0) {
        console.log(`  Imported ${imported}/${rows.length}`);
      }
    } catch (err: any) {
      await client.query('ROLLBACK');
      errors++;
      if (errors <= 5) {
        console.error(`  Error on ${row.ticker} ${row.company}: ${err.message}`);
      }
    }
  }

  client.release();
  console.log(`\nDone. Imported: ${imported}, Errors: ${errors}`);
  await pool.end();
}

run().catch(console.error);
