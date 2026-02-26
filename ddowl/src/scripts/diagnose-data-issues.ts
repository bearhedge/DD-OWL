/**
 * Diagnose IPO tracker data issues.
 *
 * Read-only queries against production DB to identify:
 * 1. Listed deals missing deal values (size_hkdm)
 * 2. Knowledge Atlas (02513) company/deal existence
 * 3. Missing Chinese names for specific stocks
 * 4. Sponsors for Illuvatar (9903)
 * 5. Suspect sponsors for 6651, 3378, 2695
 * 6. Unmapped banks (short_name IS NULL or equals name)
 *
 * Usage:
 *   npx tsx src/scripts/diagnose-data-issues.ts
 */

import pg from 'pg';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@104.199.131.94:5432/ddowl';

const pool = new pg.Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

function header(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}`);
}

async function main() {
  // ── 1. Listed deals missing deal values ──
  header('1. Listed deals with missing size_hkdm');
  const dealValues = await pool.query(`
    SELECT c.stock_code, c.name_en, d.size_hkdm, d.price_hkd, d.prospectus_url
    FROM deals d
    JOIN companies c ON c.id = d.company_id
    WHERE d.status = 'listed' AND d.size_hkdm IS NULL
    ORDER BY d.listing_date DESC
    LIMIT 30
  `);
  if (dealValues.rows.length === 0) {
    console.log('  All listed deals have size_hkdm populated.');
  } else {
    console.log(`  Found ${dealValues.rows.length} listed deals missing size_hkdm:\n`);
    console.log('  Stock  | Name                           | Price     | Has Prospectus');
    console.log('  -------|--------------------------------|-----------|---------------');
    for (const r of dealValues.rows) {
      const hasProspectus = r.prospectus_url ? 'Yes' : 'No';
      console.log(`  ${(r.stock_code || '?').padEnd(6)} | ${(r.name_en || '').slice(0, 30).padEnd(30)} | ${String(r.price_hkd ?? '-').padEnd(9)} | ${hasProspectus}`);
    }
  }

  // ── 2. Knowledge Atlas (02513) ──
  header('2. Knowledge Atlas (02513) — company + deal check');
  const company02513 = await pool.query(`
    SELECT * FROM companies WHERE stock_code = '02513'
  `);
  if (company02513.rows.length === 0) {
    console.log('  Company with stock_code 02513 NOT FOUND in companies table.');
    // Try fuzzy match
    const fuzzy = await pool.query(`
      SELECT id, stock_code, name_en FROM companies WHERE name_en ILIKE '%Knowledge Atlas%' OR name_en ILIKE '%知識圖譜%'
    `);
    if (fuzzy.rows.length > 0) {
      console.log('  Fuzzy match found:');
      for (const r of fuzzy.rows) {
        console.log(`    id=${r.id} stock_code=${r.stock_code} name=${r.name_en}`);
      }
    } else {
      console.log('  No fuzzy match found either.');
    }
  } else {
    const c = company02513.rows[0];
    console.log(`  Company found: id=${c.id}, name_en=${c.name_en}, name_cn=${c.name_cn || '(none)'}`);
    const deal = await pool.query(`
      SELECT id, status, listing_date, size_hkdm, price_hkd FROM deals WHERE company_id = $1
    `, [c.id]);
    if (deal.rows.length === 0) {
      console.log('  Deal NOT FOUND for this company.');
    } else {
      for (const d of deal.rows) {
        console.log(`  Deal: id=${d.id}, status=${d.status}, listing_date=${d.listing_date}, size=${d.size_hkdm}, price=${d.price_hkd}`);
      }
    }
  }

  // ── 3. Chinese names for specific stocks ──
  header('3. Chinese names for specific stock codes');
  const cnNames = await pool.query(`
    SELECT c.stock_code, c.name_en, c.name_cn
    FROM companies c
    JOIN deals d ON d.company_id = c.id
    WHERE c.stock_code IN ('02635','09903','03378','06651','02695','02513')
    ORDER BY c.stock_code
  `);
  if (cnNames.rows.length === 0) {
    console.log('  No companies found for these stock codes.');
  } else {
    console.log('  Stock  | English Name                   | Chinese Name');
    console.log('  -------|--------------------------------|-------------');
    for (const r of cnNames.rows) {
      console.log(`  ${(r.stock_code || '?').padEnd(6)} | ${(r.name_en || '').slice(0, 30).padEnd(30)} | ${r.name_cn || '(MISSING)'}`);
    }
  }

  // ── 4. Sponsors for Illuvatar (9903) ──
  header('4. Sponsors for Illuvatar / Shanghai Iluvatar CoreX (9903)');
  const illuvatar = await pool.query(`
    SELECT c.id as company_id, c.stock_code, c.name_en, d.id as deal_id, d.status
    FROM companies c
    JOIN deals d ON d.company_id = c.id
    WHERE c.stock_code = '09903'
  `);
  if (illuvatar.rows.length === 0) {
    console.log('  Deal for 09903 NOT FOUND.');
  } else {
    const deal = illuvatar.rows[0];
    console.log(`  Company: ${deal.name_en} (id=${deal.company_id})`);
    console.log(`  Deal: id=${deal.deal_id}, status=${deal.status}`);

    const appointments = await pool.query(`
      SELECT da.id, da.roles, b.id as bank_id, b.name, b.short_name
      FROM deal_appointments da
      JOIN banks b ON b.id = da.bank_id
      WHERE da.deal_id = $1
      ORDER BY da.roles
    `, [deal.deal_id]);
    if (appointments.rows.length === 0) {
      console.log('  NO bank appointments found for this deal.');
    } else {
      console.log(`  Bank appointments (${appointments.rows.length}):`);
      for (const a of appointments.rows) {
        console.log(`    [${a.roles}] ${a.name} (short: ${a.short_name || '(none)'})`);
      }
    }

    const oc = await pool.query(`
      SELECT id, pdf_url, announcement_date FROM oc_announcements WHERE deal_id = $1
    `, [deal.deal_id]);
    if (oc.rows.length === 0) {
      console.log('  NO OC announcements found for this deal.');
    } else {
      console.log(`  OC announcements (${oc.rows.length}):`);
      for (const o of oc.rows) {
        console.log(`    id=${o.id} date=${o.announcement_date} url=${o.pdf_url}`);
      }
    }

    const prospectus = await pool.query(`
      SELECT prospectus_url FROM deals WHERE id = $1
    `, [deal.deal_id]);
    console.log(`  Prospectus URL: ${prospectus.rows[0]?.prospectus_url || '(none)'}`);
  }

  // ── 5. Suspect sponsors (6651, 3378, 2695) ──
  header('5. Suspect sponsors for 6651, 3378, 2695');
  for (const code of ['06651', '03378', '02695']) {
    const result = await pool.query(`
      SELECT c.stock_code, c.name_en, d.id as deal_id, d.status, d.prospectus_url
      FROM companies c
      JOIN deals d ON d.company_id = c.id
      WHERE c.stock_code = $1
    `, [code]);
    if (result.rows.length === 0) {
      console.log(`\n  ${code}: NOT FOUND`);
      continue;
    }
    const deal = result.rows[0];
    console.log(`\n  ${code} — ${deal.name_en} (deal_id=${deal.deal_id}, status=${deal.status})`);

    const appts = await pool.query(`
      SELECT da.roles, b.name, b.short_name
      FROM deal_appointments da
      JOIN banks b ON b.id = da.bank_id
      WHERE da.deal_id = $1
      ORDER BY da.roles
    `, [deal.deal_id]);
    if (appts.rows.length === 0) {
      console.log('    NO bank appointments.');
    } else {
      for (const a of appts.rows) {
        console.log(`    [${a.roles}] ${a.name} → short: ${a.short_name || '(none)'}`);
      }
    }

    const oc = await pool.query(`
      SELECT pdf_url FROM oc_announcements WHERE deal_id = $1 LIMIT 1
    `, [deal.deal_id]);
    console.log(`    OC PDF: ${oc.rows[0]?.pdf_url || '(none)'}`);
    console.log(`    Prospectus: ${deal.prospectus_url || '(none)'}`);
  }

  // ── 6. Unmapped banks ──
  header('6. Unmapped banks (short_name IS NULL or equals name)');
  const unmapped = await pool.query(`
    SELECT id, name, short_name
    FROM banks
    WHERE short_name IS NULL OR short_name = name
    ORDER BY name
  `);
  if (unmapped.rows.length === 0) {
    console.log('  All banks have proper short_names.');
  } else {
    console.log(`  Found ${unmapped.rows.length} unmapped banks:\n`);
    for (const b of unmapped.rows) {
      console.log(`  id=${String(b.id).padEnd(4)} | ${b.name}`);
    }
  }

  await pool.end();
  console.log('\n--- Diagnostic complete ---');
}

main().catch(err => {
  console.error('Error:', err);
  pool.end();
  process.exit(1);
});
