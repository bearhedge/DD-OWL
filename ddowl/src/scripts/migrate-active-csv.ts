/**
 * Migrate Active Deals from active-deals.csv → Database
 *
 * Usage: npx tsx src/scripts/migrate-active-csv.ts
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, '../../public/active-deals.csv');
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@35.194.142.132:5432/ddowl';

interface CsvRow {
  company: string;
  oc_date: string;
  sponsors: string;
  others: string;
  document_url: string;
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

  for (const row of rows) {
    try {
      await client.query('BEGIN');

      // Upsert company
      const companyResult = await client.query(`
        INSERT INTO companies (name_en)
        VALUES ($1)
        ON CONFLICT (name_en) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `, [row.company]);
      const companyId = companyResult.rows[0].id;

      const filingDate = parseDate(row.oc_date);

      // Upsert deal (status = active)
      const dealResult = await client.query(`
        INSERT INTO deals (company_id, status, filing_date)
        VALUES ($1, 'active', $2)
        ON CONFLICT (company_id) WHERE status = 'active' DO UPDATE SET
          filing_date = COALESCE(EXCLUDED.filing_date, deals.filing_date),
          updated_at = NOW()
        RETURNING id
      `, [companyId, filingDate]);
      const dealId = dealResult.rows[0].id;

      // Insert OC announcement record
      if (row.document_url) {
        await client.query(`
          INSERT INTO oc_announcements (deal_id, announcement_date, pdf_url)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [dealId, filingDate, row.document_url]);
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
        `, [dealId, bankId, [bank.role], bank.role === 'sponsor', row.document_url || null]);
      }

      await client.query('COMMIT');
      imported++;

      if (imported % 50 === 0) {
        console.log(`  Imported ${imported}/${rows.length}`);
      }
    } catch (err: any) {
      await client.query('ROLLBACK');
      errors++;
      if (errors <= 5) {
        console.error(`  Error on ${row.company}: ${err.message}`);
      }
    }
  }

  client.release();
  console.log(`\nDone. Imported: ${imported}, Errors: ${errors}`);
  await pool.end();
}

run().catch(console.error);
