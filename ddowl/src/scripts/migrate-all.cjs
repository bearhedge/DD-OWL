/**
 * Bulk migration script — runs with plain node (no tsx)
 * Migrates historical + active CSV data into the database
 */

const pg = require('pg');
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@35.194.142.132:5432/ddowl';
const HISTORICAL_CSV = path.join(__dirname, '../../public/baseline-enriched.csv');
const ACTIVE_CSV = path.join(__dirname, '../../public/active-deals.csv');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += ch;
  }
  result.push(current);
  return result;
}

function readCSV(filepath) {
  const text = fs.readFileSync(filepath, 'utf-8');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function parseDateDMY(d) {
  if (!d) return null;
  const p = d.split('/');
  if (p.length === 3) return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
  return null;
}

async function main() {
  console.log('Connecting to database...');
  const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 1 });

  // Terminate stale sessions
  await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ddowl' AND state='idle in transaction' AND pid != pg_backend_pid()");

  const client = await pool.connect();
  console.log('Connected.\n');

  // Wrap everything in one transaction, use savepoints per row
  await client.query('BEGIN');

  // ==================== HISTORICAL ====================
  console.log('=== Importing Historical Deals ===');
  const historical = readCSV(HISTORICAL_CSV);
  console.log(`Read ${historical.length} rows`);

  let hImported = 0, hErrors = 0;
  for (let i = 0; i < historical.length; i++) {
    const row = historical[i];
    try {
      // Single transaction per row
      await client.query('SAVEPOINT sp');

      // Upsert company
      const cr = await client.query(
        `INSERT INTO companies (name_en, name_cn, sector, industry, sub_industry, stock_code)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name_en) DO UPDATE SET
           name_cn=COALESCE(EXCLUDED.name_cn,companies.name_cn),
           sector=COALESCE(EXCLUDED.sector,companies.sector),
           industry=COALESCE(EXCLUDED.industry,companies.industry),
           sub_industry=COALESCE(EXCLUDED.sub_industry,companies.sub_industry),
           stock_code=COALESCE(EXCLUDED.stock_code,companies.stock_code),
           updated_at=NOW()
         RETURNING id`,
        [row.company, row.company_cn||null, row.sector||null, row.industry||null, row.sub_industry||null, row.ticker||null]
      );
      const companyId = cr.rows[0].id;

      const sizeHkdm = parseFloat(row.size_hkdm);
      const shares = parseFloat(row.shares);
      const price = parseFloat(row.price_hkd);
      const listingDate = parseDateDMY(row.date);

      // Check existing deal
      const existing = await client.query('SELECT id FROM deals WHERE company_id=$1 AND status=$2 LIMIT 1', [companyId, 'listed']);
      let dealId;
      if (existing.rows.length > 0) {
        dealId = existing.rows[0].id;
        await client.query(
          `UPDATE deals SET deal_type=COALESCE($2,deal_type),listing_date=COALESCE($3,listing_date),
           shares_offered=COALESCE($4,shares_offered),price_hkd=COALESCE($5,price_hkd),
           size_hkdm=COALESCE($6,size_hkdm),is_dual_listing=$7,
           prospectus_url=COALESCE($8,prospectus_url),updated_at=NOW() WHERE id=$1`,
          [dealId, row.deal_type||row.type||null, listingDate, isNaN(shares)?null:shares,
           isNaN(price)?null:price, isNaN(sizeHkdm)?null:sizeHkdm, row.is_dual_listing==='Y', row.prospectus_url||null]
        );
      } else {
        const dr = await client.query(
          `INSERT INTO deals (company_id,status,deal_type,listing_date,shares_offered,price_hkd,size_hkdm,is_dual_listing,prospectus_url)
           VALUES ($1,'listed',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [companyId, row.deal_type||row.type||null, listingDate, isNaN(shares)?null:shares,
           isNaN(price)?null:price, isNaN(sizeHkdm)?null:sizeHkdm, row.is_dual_listing==='Y', row.prospectus_url||null]
        );
        dealId = dr.rows[0].id;
      }

      // Banks
      const sponsors = (row.sponsors||'').split('; ').filter(Boolean);
      const others = (row.others||'').split('; ').filter(Boolean);
      const allBanks = [
        ...sponsors.map(b => ({name:b, role:'sponsor'})),
        ...others.map(b => ({name:b, role:'other'})),
      ];
      for (const bank of allBanks) {
        const br = await client.query(
          `INSERT INTO banks (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET updated_at=NOW() RETURNING id`,
          [bank.name]
        );
        await client.query(
          `INSERT INTO deal_appointments (deal_id,bank_id,roles,is_lead,source_url)
           VALUES ($1,$2,$3::bank_role[],$4,$5)
           ON CONFLICT (deal_id,bank_id) DO UPDATE SET roles=EXCLUDED.roles,is_lead=EXCLUDED.is_lead`,
          [dealId, br.rows[0].id, [bank.role], bank.role==='sponsor', row.prospectus_url||null]
        );
      }

      await client.query('RELEASE SAVEPOINT sp');
      hImported++;
      if (hImported % 100 === 0) console.log(`  ${hImported}/${historical.length}`);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp');
      hErrors++;
      if (hErrors <= 3) console.error(`  Error [${row.ticker}]: ${err.message}`);
    }
  }
  console.log(`Historical: ${hImported} imported, ${hErrors} errors\n`);

  // ==================== ACTIVE ====================
  console.log('=== Importing Active Deals ===');
  const active = readCSV(ACTIVE_CSV);
  console.log(`Read ${active.length} rows`);

  let aImported = 0, aErrors = 0;
  for (let i = 0; i < active.length; i++) {
    const row = active[i];
    try {
      await client.query('SAVEPOINT sp');

      const cr = await client.query(
        `INSERT INTO companies (name_en) VALUES ($1) ON CONFLICT (name_en) DO UPDATE SET updated_at=NOW() RETURNING id`,
        [row.company]
      );
      const companyId = cr.rows[0].id;
      const filingDate = parseDateDMY(row.oc_date);

      const dr = await client.query(
        `INSERT INTO deals (company_id,status,filing_date) VALUES ($1,'active',$2)
         ON CONFLICT (company_id) WHERE status='active' DO UPDATE SET
           filing_date=COALESCE(EXCLUDED.filing_date,deals.filing_date),updated_at=NOW()
         RETURNING id`,
        [companyId, filingDate]
      );
      const dealId = dr.rows[0].id;

      if (row.document_url) {
        await client.query(
          `INSERT INTO oc_announcements (deal_id,announcement_date,pdf_url) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [dealId, filingDate, row.document_url]
        );
      }

      const sponsors = (row.sponsors||'').split('; ').filter(Boolean);
      const others = (row.others||'').split('; ').filter(Boolean);
      const allBanks = [...sponsors.map(b=>({name:b,role:'sponsor'})),...others.map(b=>({name:b,role:'other'}))];
      for (const bank of allBanks) {
        const br = await client.query(
          `INSERT INTO banks (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET updated_at=NOW() RETURNING id`,
          [bank.name]
        );
        await client.query(
          `INSERT INTO deal_appointments (deal_id,bank_id,roles,is_lead,source_url) VALUES ($1,$2,$3::bank_role[],$4,$5)
           ON CONFLICT (deal_id,bank_id) DO UPDATE SET roles=EXCLUDED.roles,is_lead=EXCLUDED.is_lead`,
          [dealId, br.rows[0].id, [bank.role], bank.role==='sponsor', row.document_url||null]
        );
      }

      await client.query('RELEASE SAVEPOINT sp');
      aImported++;
      if (aImported % 50 === 0) console.log(`  ${aImported}/${active.length}`);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp');
      aErrors++;
      if (aErrors <= 3) console.error(`  Error [${row.company}]: ${err.message}`);
    }
  }
  console.log(`Active: ${aImported} imported, ${aErrors} errors\n`);

  // ==================== VERIFY ====================
  const listed = await client.query("SELECT count(*) FROM deals WHERE status='listed'");
  const activeCount = await client.query("SELECT count(*) FROM deals WHERE status='active'");
  const companies = await client.query("SELECT count(*) FROM companies");
  const banks = await client.query("SELECT count(*) FROM banks");
  console.log('=== Verification ===');
  console.log(`Listed deals: ${listed.rows[0].count}`);
  console.log(`Active deals: ${activeCount.rows[0].count}`);
  console.log(`Companies: ${companies.rows[0].count}`);
  console.log(`Banks: ${banks.rows[0].count}`);

  await client.query('COMMIT');
  client.release();
  await pool.end();
  console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
