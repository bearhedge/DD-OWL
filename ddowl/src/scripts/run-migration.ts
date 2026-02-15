/**
 * Combined Migration Runner
 *
 * Runs: SQL migration → Historical CSV import → Active CSV import
 *
 * Usage: npx tsx src/scripts/run-migration.ts
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:DOMRD7x7ECUny4Pc615y9w==@35.194.142.132:5432/ddowl';

async function runSqlMigration() {
  console.log('=== Step 1: Running SQL Migration ===\n');

  const sqlPath = path.join(__dirname, '../db/migrations/001_ipo_lifecycle_columns.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');

  const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(sql);
    console.log('SQL migration completed successfully.\n');
  } catch (err: any) {
    console.error('SQL migration error:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

async function runScript(scriptName: string, label: string) {
  console.log(`=== ${label} ===\n`);
  const scriptPath = path.join(__dirname, scriptName);
  execSync(`npx tsx ${scriptPath}`, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: DB_URL },
  });
  console.log('');
}

async function verify() {
  console.log('=== Verification ===\n');

  const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const listed = await pool.query("SELECT COUNT(*) FROM deals WHERE status = 'listed'");
    const active = await pool.query("SELECT COUNT(*) FROM deals WHERE status = 'active'");
    const companies = await pool.query("SELECT COUNT(*) FROM companies");
    const banks = await pool.query("SELECT COUNT(*) FROM banks");

    console.log(`Listed deals: ${listed.rows[0].count}`);
    console.log(`Active deals: ${active.rows[0].count}`);
    console.log(`Companies: ${companies.rows[0].count}`);
    console.log(`Banks: ${banks.rows[0].count}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log('IPO Lifecycle Migration\n');
  console.log(`Database: ${DB_URL.replace(/:[^:@]+@/, ':****@')}\n`);

  await runSqlMigration();
  await runScript('migrate-historical-csv.ts', 'Step 2: Importing Historical Deals');
  await runScript('migrate-active-csv.ts', 'Step 3: Importing Active Deals');
  await verify();

  console.log('\nMigration complete!');
}

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
