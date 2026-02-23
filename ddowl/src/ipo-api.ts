/**
 * IPO Tracker API Routes
 *
 * Endpoints for accessing IPO deal and bank data
 */

import { Router, Request, Response } from 'express';
import { pool } from './db/index.js';
import { normalizeBankName } from './bank-normalizer.js';

export const ipoRouter = Router();

/**
 * GET /api/ipo/pipeline
 * Returns active IPO pipeline with bank assignments
 */
ipoRouter.get('/pipeline', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT * FROM ipo_pipeline
      ORDER BY filing_date DESC
      LIMIT 100
    `);
    res.json({
      count: result.rows.length,
      deals: result.rows,
    });
  } catch (err) {
    console.error('Pipeline query error:', err);
    res.status(500).json({ error: 'Failed to fetch pipeline' });
  }
});

/**
 * GET /api/ipo/deals
 * Returns all deals with optional filters
 */
ipoRouter.get('/deals', async (req: Request, res: Response) => {
  const { status, board, bank_id, search, limit = 50 } = req.query;

  try {
    let query = `
      SELECT
        d.id,
        d.board,
        d.status,
        d.filing_date,
        d.listing_date,
        d.hkex_app_id,
        d.deal_type,
        d.shares_offered,
        d.price_hkd,
        d.size_hkdm,
        d.is_dual_listing,
        d.prospectus_url,
        c.name_en as company_name,
        c.name_cn as company_name_cn,
        c.sector,
        c.industry,
        c.sub_industry,
        c.stock_code,
        json_agg(json_build_object(
          'bank_id', b.id,
          'bank_name', b.name,
          'short_name', b.short_name,
          'roles', da.roles,
          'raw_role', da.raw_role,
          'is_lead', da.is_lead
        )) FILTER (WHERE b.id IS NOT NULL) as banks,
        array_agg(DISTINCT da.source_url) FILTER (WHERE da.source_url IS NOT NULL) as pdf_links,
        (SELECT oc.pdf_url FROM oc_announcements oc WHERE oc.deal_id = d.id ORDER BY oc.announcement_date DESC LIMIT 1) as oc_pdf_url
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN deal_appointments da ON da.deal_id = d.id
      LEFT JOIN banks b ON b.id = da.bank_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      const statuses = (status as string).split(',');
      if (statuses.length === 1) {
        query += ` AND d.status = $${paramIndex++}`;
        params.push(statuses[0]);
      } else {
        const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(',');
        query += ` AND d.status IN (${placeholders})`;
        statuses.forEach(s => { params.push(s); paramIndex++; });
      }
    }

    if (board) {
      query += ` AND d.board = $${paramIndex++}`;
      params.push(board);
    }

    if (bank_id) {
      query += ` AND EXISTS (SELECT 1 FROM deal_appointments WHERE deal_id = d.id AND bank_id = $${paramIndex++})`;
      params.push(bank_id);
    }

    if (search) {
      query += ` AND (
        c.name_en ILIKE $${paramIndex} OR
        c.name_cn ILIKE $${paramIndex} OR
        c.stock_code ILIKE $${paramIndex} OR
        c.industry ILIKE $${paramIndex} OR
        EXISTS (SELECT 1 FROM deal_appointments da2 JOIN banks b2 ON b2.id = da2.bank_id WHERE da2.deal_id = d.id AND b2.name ILIKE $${paramIndex})
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Default limit: 200 for listed/other, 500 for active
    const defaultLimit = status === 'listed' ? 200 : (status === 'active' ? 500 : 200);
    const effectiveLimit = Number(limit) || defaultLimit;

    query += `
      GROUP BY d.id, c.id
      ORDER BY COALESCE(d.listing_date, d.filing_date) DESC
      LIMIT $${paramIndex}
    `;
    params.push(effectiveLimit);

    const result = await pool.query(query, params);
    res.json({
      count: result.rows.length,
      deals: result.rows,
    });
  } catch (err) {
    console.error('Deals query error:', err);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

/**
 * GET /api/ipo/deals/:id
 * Returns single deal with full details
 */
ipoRouter.get('/deals/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const dealResult = await pool.query(`
      SELECT
        d.*,
        c.name_en as company_name,
        c.name_cn as company_name_cn,
        c.sector,
        c.incorporation_place
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      WHERE d.id = $1
    `, [id]);

    if (dealResult.rows.length === 0) {
      res.status(404).json({ error: 'Deal not found' });
      return;
    }

    const appointmentsResult = await pool.query(`
      SELECT
        da.*,
        b.name as bank_name,
        b.short_name,
        b.tier
      FROM deal_appointments da
      JOIN banks b ON b.id = da.bank_id
      WHERE da.deal_id = $1
      ORDER BY da.is_lead DESC, da.roles
    `, [id]);

    const announcementsResult = await pool.query(`
      SELECT * FROM oc_announcements
      WHERE deal_id = $1
      ORDER BY announcement_date DESC
    `, [id]);

    res.json({
      deal: dealResult.rows[0],
      appointments: appointmentsResult.rows,
      announcements: announcementsResult.rows,
    });
  } catch (err) {
    console.error('Deal detail error:', err);
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

/**
 * GET /api/ipo/banks
 * Returns all banks with deal statistics
 */
ipoRouter.get('/banks', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT * FROM bank_rankings
      ORDER BY total_deals DESC
    `);
    res.json({
      count: result.rows.length,
      banks: result.rows,
    });
  } catch (err) {
    console.error('Banks query error:', err);
    res.status(500).json({ error: 'Failed to fetch banks' });
  }
});

/**
 * GET /api/ipo/banks/:id
 * Returns single bank with all deals
 */
ipoRouter.get('/banks/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const bankResult = await pool.query(`
      SELECT * FROM banks WHERE id = $1
    `, [id]);

    if (bankResult.rows.length === 0) {
      res.status(404).json({ error: 'Bank not found' });
      return;
    }

    const dealsResult = await pool.query(`
      SELECT
        da.roles,
        da.is_lead,
        da.appointed_date,
        d.id as deal_id,
        d.status,
        d.board,
        d.filing_date,
        c.name_en as company_name,
        c.name_cn as company_name_cn
      FROM deal_appointments da
      JOIN deals d ON d.id = da.deal_id
      JOIN companies c ON c.id = d.company_id
      WHERE da.bank_id = $1
      ORDER BY d.filing_date DESC
    `, [id]);

    res.json({
      bank: bankResult.rows[0],
      deals: dealsResult.rows,
    });
  } catch (err) {
    console.error('Bank detail error:', err);
    res.status(500).json({ error: 'Failed to fetch bank' });
  }
});

/**
 * GET /api/ipo/stats
 * Returns dashboard summary statistics
 */
ipoRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const statsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM deals WHERE status = 'active') as active_deals,
        (SELECT COUNT(*) FROM deals WHERE status = 'listed') as listed_deals,
        (SELECT COUNT(*) FROM banks) as total_banks,
        (SELECT COUNT(*) FROM companies) as total_companies,
        (SELECT COUNT(*) FROM deal_appointments WHERE is_lead = true) as lead_appointments
    `);

    const recentDealsResult = await pool.query(`
      SELECT
        d.id,
        c.name_en as company_name,
        d.filing_date,
        d.status
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      ORDER BY d.created_at DESC
      LIMIT 5
    `);

    const topBanksResult = await pool.query(`
      SELECT bank_name, short_name, total_deals
      FROM bank_rankings
      ORDER BY total_deals DESC
      LIMIT 5
    `);

    res.json({
      summary: statsResult.rows[0],
      recentDeals: recentDealsResult.rows,
      topBanks: topBanksResult.rows,
    });
  } catch (err) {
    console.error('Stats query error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * POST /api/ipo/scrape
 * Triggers a new scrape run (manual trigger)
 */
ipoRouter.post('/scrape', async (req: Request, res: Response) => {
  try {
    // Import scraper dynamically to avoid circular deps
    const { scrapeActiveOCData, closeBrowser } = await import('./hkex-scraper.js');

    // Create scrape run record
    const runResult = await pool.query(`
      INSERT INTO scrape_runs (source, board, status)
      VALUES ('hkex', 'mainBoard', 'running')
      RETURNING id
    `);
    const runId = runResult.rows[0].id;

    // Run scraper in background
    res.json({
      message: 'Scrape started',
      runId,
      status: 'running',
    });

    // Continue scraping after response
    try {
      const data = await scrapeActiveOCData();

      let newDeals = 0;
      let newAppointments = 0;

      for (const item of data) {
        // Upsert company
        const companyResult = await pool.query(`
          INSERT INTO companies (name_en, name_cn)
          VALUES ($1, $2)
          ON CONFLICT (name_en) DO UPDATE SET name_cn = EXCLUDED.name_cn
          RETURNING id
        `, [item.company, item.companyChineseName || null]);
        const companyId = companyResult.rows[0]?.id;

        if (companyId) {
          // Upsert deal
          const dealResult = await pool.query(`
            INSERT INTO deals (company_id, filing_date, status)
            VALUES ($1, $2, 'active')
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [companyId, item.appointmentDate || null]);

          const dealId = dealResult.rows[0]?.id;
          if (dealId) {
            newDeals++;

            // Insert bank appointments
            for (const bank of item.banks) {
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
                const existingBank = await pool.query(
                  'SELECT id FROM banks WHERE name = $1',
                  [bank.bank]
                );
                bankId = existingBank.rows[0]?.id;
              }

              if (bankId) {
                // Convert role to array format (handle both old and new formats)
                const bankAny = bank as any;
                const roles = Array.isArray(bankAny.roles)
                  ? bankAny.roles.map((r: string) => r.toLowerCase())
                  : [bankAny.role?.toLowerCase() || 'other'];

                await pool.query(`
                  INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
                  VALUES ($1, $2, $3::bank_role[], $4, $5)
                  ON CONFLICT DO NOTHING
                `, [dealId, bankId, roles, bank.isLead, item.sourceUrl]);
                newAppointments++;
              }
            }
          }
        }
      }

      // Update run status
      await pool.query(`
        UPDATE scrape_runs
        SET completed_at = NOW(),
            status = 'completed',
            announcements_found = $2,
            announcements_parsed = $2,
            new_deals = $3,
            new_appointments = $4
        WHERE id = $1
      `, [runId, data.length, newDeals, newAppointments]);

      await closeBrowser();
    } catch (scrapeErr) {
      console.error('Scrape error:', scrapeErr);
      await pool.query(`
        UPDATE scrape_runs
        SET completed_at = NOW(),
            status = 'failed',
            errors = $2
        WHERE id = $1
      `, [runId, JSON.stringify({ error: String(scrapeErr) })]);
    }
  } catch (err) {
    console.error('Scrape trigger error:', err);
    res.status(500).json({ error: 'Failed to start scrape' });
  }
});

/**
 * GET /api/ipo/validations
 * Returns all validation statuses
 */
ipoRouter.get('/validations', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT deal_id, is_correct, notes, validated_at
      FROM deal_validations
      ORDER BY validated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Validations query error:', err);
    res.status(500).json({ error: 'Failed to fetch validations' });
  }
});

/**
 * POST /api/ipo/validate/:id
 * Mark a deal as correct or wrong
 */
ipoRouter.post('/validate/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_correct, notes } = req.body;

  try {
    await pool.query(`
      INSERT INTO deal_validations (deal_id, is_correct, notes, validated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (deal_id) DO UPDATE SET
        is_correct = EXCLUDED.is_correct,
        notes = EXCLUDED.notes,
        validated_at = NOW()
    `, [id, is_correct, notes || null]);

    res.json({ success: true, deal_id: id, is_correct });
  } catch (err) {
    console.error('Validation error:', err);
    res.status(500).json({ error: 'Failed to save validation' });
  }
});

/**
 * POST /api/ipo/scrape-oc
 * Triggers OC announcement scrape using hkex-scraper-v2
 */
ipoRouter.post('/scrape-oc', async (req: Request, res: Response) => {
  try {
    // Create scrape run record
    const runResult = await pool.query(`
      INSERT INTO scrape_runs (source, board, status)
      VALUES ('hkex', 'mainBoard', 'running')
      RETURNING id
    `);
    const runId = runResult.rows[0].id;

    // Return immediately
    res.json({
      message: 'Scrape started',
      runId,
      status: 'running',
    });

    // Run scraper in background
    (async () => {
      try {
        const { scrapeAllApplications, closeBrowser } = await import('./hkex-scraper-v2.js');
        const currentYear = new Date().getFullYear();
        const deals = await scrapeAllApplications({ years: [currentYear, currentYear - 1], extractBanks: true });

        let newDeals = 0;
        let newAppointments = 0;

        for (const deal of deals) {
          // Parse filing date
          let filingDate: string | null = null;
          if (deal.filingDate) {
            const parts = deal.filingDate.split('/');
            if (parts.length === 3) {
              filingDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
          }

          // Upsert company (with Chinese name if available)
          const companyResult = await pool.query(`
            INSERT INTO companies (name_en, name_cn)
            VALUES ($1, $2)
            ON CONFLICT (name_en) DO UPDATE SET
              name_cn = COALESCE(companies.name_cn, EXCLUDED.name_cn),
              updated_at = NOW()
            RETURNING id
          `, [deal.company, deal.companyCn]);
          const companyId = companyResult.rows[0].id;

          // Re-activate lapsed deal if one exists, otherwise upsert
          let dealId: number;
          let inserted = false;

          const reactivated = await pool.query(`
            UPDATE deals SET status = 'active', filing_date = $2, hkex_app_id = $3, board = $4, updated_at = NOW()
            WHERE company_id = $1 AND status = 'lapsed'
            RETURNING id
          `, [companyId, filingDate, deal.appId, deal.board]);

          if (reactivated.rows.length > 0) {
            dealId = reactivated.rows[0].id;
            newDeals++;
          } else {
            const dealResult = await pool.query(`
              INSERT INTO deals (company_id, status, filing_date, hkex_app_id, board)
              VALUES ($1, 'active', $2, $3, $4)
              ON CONFLICT (company_id) WHERE status = 'active' DO UPDATE SET
                filing_date = COALESCE(EXCLUDED.filing_date, deals.filing_date),
                hkex_app_id = COALESCE(EXCLUDED.hkex_app_id, deals.hkex_app_id),
                updated_at = NOW()
              RETURNING id, (xmax = 0) as inserted
            `, [companyId, filingDate, deal.appId, deal.board]);

            dealId = dealResult.rows[0].id;
            inserted = dealResult.rows[0].inserted;
          }

          if (inserted) newDeals++;

          // Insert OC announcement
          if (deal.ocPdfUrl) {
            await pool.query(`
              INSERT INTO oc_announcements (deal_id, announcement_date, pdf_url)
              VALUES ($1, $2, $3)
              ON CONFLICT DO NOTHING
            `, [dealId, filingDate, deal.ocPdfUrl]);
          }

          // Insert bank appointments
          for (const bank of deal.banks) {
            const { canonical: shortName } = normalizeBankName(bank.bank);
            const bankResult = await pool.query(`
              INSERT INTO banks (name, short_name)
              VALUES ($1, $2)
              ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
              RETURNING id
            `, [bank.bank, shortName]);
            const bankId = bankResult.rows[0].id;

            await pool.query(`
              INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead)
              VALUES ($1, $2, $3::bank_role[], $4)
              ON CONFLICT (deal_id, bank_id) DO UPDATE SET
                roles = EXCLUDED.roles,
                is_lead = EXCLUDED.is_lead
            `, [dealId, bankId, bank.roles, bank.isLead]);
            newAppointments++;
          }
        }

        await pool.query(`
          UPDATE scrape_runs SET
            completed_at = NOW(),
            status = 'completed',
            announcements_found = $2,
            announcements_parsed = $2,
            new_deals = $3,
            new_appointments = $4
          WHERE id = $1
        `, [runId, deals.length, newDeals, newAppointments]);

        await closeBrowser();
      } catch (err) {
        console.error('Scrape-oc error:', err);
        await pool.query(`
          UPDATE scrape_runs SET
            completed_at = NOW(),
            status = 'failed',
            errors = $2
          WHERE id = $1
        `, [runId, JSON.stringify({ error: String(err) })]);
      }
    })();
  } catch (err) {
    console.error('Scrape-oc trigger error:', err);
    res.status(500).json({ error: 'Failed to start scrape' });
  }
});

/**
 * GET /api/ipo/scrape-runs/:id
 * Returns scrape run status for polling
 */
ipoRouter.get('/scrape-runs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM scrape_runs WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Scrape run not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Scrape run query error:', err);
    res.status(500).json({ error: 'Failed to fetch scrape run' });
  }
});

/**
 * POST /api/ipo/rescrape-missing-banks
 * Re-scrapes OC PDFs for deals that have zero bank appointments
 */
ipoRouter.post('/rescrape-missing-banks', async (req: Request, res: Response) => {
  try {
    // Find deals with no bank appointments
    const missingResult = await pool.query(`
      SELECT d.id as deal_id, c.name_en as company_name, d.hkex_app_id,
             oc.pdf_url
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN deal_appointments da ON da.deal_id = d.id
      LEFT JOIN oc_announcements oc ON oc.deal_id = d.id
      WHERE d.status = 'active'
      GROUP BY d.id, c.name_en, d.hkex_app_id, oc.pdf_url
      HAVING COUNT(da.id) = 0
    `);

    const missing = missingResult.rows;

    if (missing.length === 0) {
      res.json({ message: 'No deals with missing banks', count: 0 });
      return;
    }

    // Process synchronously so Cloud Run keeps the request alive
    const { extractBanksFromPdfUrl } = await import('./hkex-scraper-v2.js');

    let updated = 0;
    const results: { company: string; banksFound: number; chineseName: string | null; pdfUrl: string | null }[] = [];

    for (const deal of missing) {
      if (!deal.pdf_url) {
        results.push({ company: deal.company_name, banksFound: -1, chineseName: null, pdfUrl: null });
        continue;
      }

      console.log(`Re-scraping: ${deal.company_name}`);
      const { banks, chineseName } = await extractBanksFromPdfUrl(deal.pdf_url, deal.company_name);

      // Save Chinese name if found
      if (chineseName) {
        await pool.query(`
          UPDATE companies SET name_cn = $2, updated_at = NOW()
          WHERE id = (SELECT company_id FROM deals WHERE id = $1)
          AND name_cn IS NULL
        `, [deal.deal_id, chineseName]);
        console.log(`  Chinese name: ${chineseName}`);
      }

      if (banks.length > 0) {
        for (const bank of banks) {
          const { canonical: shortName } = normalizeBankName(bank.bank);
          const bankResult = await pool.query(`
            INSERT INTO banks (name, short_name) VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
            RETURNING id
          `, [bank.bank, shortName]);
          const bankId = bankResult.rows[0].id;

          await pool.query(`
            INSERT INTO deal_appointments (deal_id, bank_id, roles, is_lead, source_url)
            VALUES ($1, $2, $3::bank_role[], $4, $5)
            ON CONFLICT (deal_id, bank_id) DO UPDATE SET
              roles = EXCLUDED.roles,
              is_lead = EXCLUDED.is_lead
          `, [deal.deal_id, bankId, bank.roles, bank.isLead, deal.pdf_url]);
        }
        updated++;
        console.log(`  Found ${banks.length} banks for ${deal.company_name}`);
      }

      results.push({ company: deal.company_name, banksFound: banks.length, chineseName, pdfUrl: deal.pdf_url });
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Re-scrape complete: ${updated}/${missing.length} deals updated`);
    res.json({
      message: `Re-scrape complete: ${updated}/${missing.length} deals updated`,
      total: missing.length,
      updated,
      results,
    });
  } catch (err) {
    console.error('Re-scrape error:', err);
    res.status(500).json({ error: 'Failed to re-scrape' });
  }
});

/**
 * POST /api/ipo/extract-chinese-names
 * Extracts Chinese company names from OC PDFs for deals missing name_cn
 */
ipoRouter.post('/extract-chinese-names', async (req: Request, res: Response) => {
  try {
    const missingResult = await pool.query(`
      SELECT d.id as deal_id, c.name_en as company_name, c.id as company_id,
             COALESCE(
               oc.pdf_url,
               (SELECT da.source_url FROM deal_appointments da WHERE da.deal_id = d.id AND da.source_url IS NOT NULL LIMIT 1)
             ) as pdf_url
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN oc_announcements oc ON oc.deal_id = d.id
      WHERE d.status IN ('active', 'withdrawn', 'lapsed', 'rejected')
        AND c.name_cn IS NULL
        AND (oc.pdf_url IS NOT NULL OR EXISTS (
          SELECT 1 FROM deal_appointments da WHERE da.deal_id = d.id AND da.source_url IS NOT NULL
        ))
      ORDER BY d.filing_date DESC
    `);

    const deals = missingResult.rows;
    if (deals.length === 0) {
      res.json({ message: 'All deals already have Chinese names', count: 0 });
      return;
    }

    const { extractBanksFromPdfUrl } = await import('./hkex-scraper-v2.js');

    let extracted = 0;
    const results: { company: string; chineseName: string | null; pdfUrl: string }[] = [];

    for (const deal of deals) {
      console.log(`Extracting Chinese name: ${deal.company_name}`);
      const { chineseName } = await extractBanksFromPdfUrl(deal.pdf_url, deal.company_name);

      if (chineseName) {
        await pool.query(`
          UPDATE companies SET name_cn = $1, updated_at = NOW()
          WHERE id = $2 AND name_cn IS NULL
        `, [chineseName, deal.company_id]);
        extracted++;
        console.log(`  → ${chineseName}`);
      }

      results.push({ company: deal.company_name, chineseName, pdfUrl: deal.pdf_url });
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Chinese name extraction complete: ${extracted}/${deals.length}`);
    res.json({
      message: `Extracted ${extracted}/${deals.length} Chinese names`,
      total: deals.length,
      extracted,
      results,
    });
  } catch (err) {
    console.error('Chinese name extraction error:', err);
    res.status(500).json({ error: 'Failed to extract Chinese names' });
  }
});

/**
 * POST /api/ipo/batch-update-chinese-names
 * Accepts JSON array of { appId, companyCn } to update companies.name_cn
 */
ipoRouter.post('/batch-update-chinese-names', async (req: Request, res: Response) => {
  try {
    const { force } = req.query;
    const updates: { appId: string; companyCn: string }[] = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'Expected array of { appId, companyCn }' });
      return;
    }

    let updated = 0;
    const results: { appId: string; company: string; companyCn: string }[] = [];

    for (const { appId, companyCn } of updates) {
      if (!appId || !companyCn) continue;
      const query = force
        ? `UPDATE companies SET name_cn = $1, updated_at = NOW()
           WHERE id = (SELECT company_id FROM deals WHERE hkex_app_id = $2 LIMIT 1)
           RETURNING name_en`
        : `UPDATE companies SET name_cn = $1, updated_at = NOW()
           WHERE id = (SELECT company_id FROM deals WHERE hkex_app_id = $2 LIMIT 1)
             AND name_cn IS NULL
           RETURNING name_en`;
      const result = await pool.query(query, [companyCn, appId]);

      if (result.rows.length > 0) {
        updated++;
        results.push({ appId, company: result.rows[0].name_en, companyCn });
      }
    }

    res.json({ message: `Updated ${updated}/${updates.length} Chinese names`, updated, results });
  } catch (err) {
    console.error('Batch update Chinese names error:', err);
    res.status(500).json({ error: 'Failed to batch update Chinese names' });
  }
});

/**
 * POST /api/ipo/populate-bank-short-names
 * Backfills short_name for all banks using the KNOWN_BANKS normalizer
 */
ipoRouter.post('/populate-bank-short-names', async (req: Request, res: Response) => {
  try {
    const banksResult = await pool.query(`SELECT id, name FROM banks WHERE short_name IS NULL`);
    const banks = banksResult.rows;

    if (banks.length === 0) {
      res.json({ message: 'All banks already have short names', updated: 0 });
      return;
    }

    let updated = 0;
    const mappings: { name: string; shortName: string }[] = [];
    const errors: { name: string; error: string }[] = [];

    for (const bank of banks) {
      try {
        const { canonical } = normalizeBankName(bank.name);
        await pool.query(`UPDATE banks SET short_name = $1, updated_at = NOW() WHERE id = $2`, [canonical, bank.id]);
        mappings.push({ name: bank.name, shortName: canonical });
        updated++;
      } catch (err) {
        console.error(`Failed to update bank ${bank.id} "${bank.name}":`, err);
        errors.push({ name: bank.name, error: String(err) });
      }
    }

    res.json({
      message: `Updated ${updated}/${banks.length} bank short names${errors.length ? `, ${errors.length} errors` : ''}`,
      updated,
      mappings,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Populate bank short names error:', err);
    res.status(500).json({ error: 'Failed to populate bank short names' });
  }
});

/**
 * POST /api/ipo/batch-add-deal-banks
 * Batch add banks and OC PDF URLs for deals identified by hkex_app_id.
 * Body: [{ hkexAppId, ocPdfUrl, banks: [{ name, role }] }]
 */
ipoRouter.post('/batch-add-deal-banks', async (req: Request, res: Response) => {
  try {
    const items: { hkexAppId: string; ocPdfUrl?: string; banks: { name: string; role: string }[] }[] = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Expected array of { hkexAppId, ocPdfUrl?, banks }' });
      return;
    }

    const { normalizeRole, isLeadRole } = await import('./role-normalizer.js');

    let dealsUpdated = 0;
    let banksAdded = 0;
    let appointmentsAdded = 0;
    let ocLinksAdded = 0;
    const results: { hkexAppId: string; company?: string; banksAdded: number; ocLink: boolean; error?: string }[] = [];

    for (const item of items) {
      // Find deal by hkex_app_id
      const dealResult = await pool.query(`
        SELECT d.id as deal_id, c.name_en as company_name
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE d.hkex_app_id = $1
      `, [item.hkexAppId]);

      if (dealResult.rows.length === 0) {
        results.push({ hkexAppId: item.hkexAppId, banksAdded: 0, ocLink: false, error: 'Deal not found' });
        continue;
      }

      const { deal_id: dealId, company_name: companyName } = dealResult.rows[0];
      let itemBanksAdded = 0;

      // Upsert OC PDF URL
      let ocAdded = false;
      if (item.ocPdfUrl) {
        const ocResult = await pool.query(`
          INSERT INTO oc_announcements (deal_id, pdf_url)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [dealId, item.ocPdfUrl]);
        // If ON CONFLICT DO NOTHING hit, check if already exists
        if (ocResult.rows.length > 0) {
          ocAdded = true;
          ocLinksAdded++;
        } else {
          // Already exists — still count as success
          ocAdded = true;
        }
      }

      // Upsert banks and appointments
      for (const bank of item.banks) {
        const roles = normalizeRole(bank.role);
        const isLead = isLeadRole(roles);
        const { canonical: shortName } = normalizeBankName(bank.name);

        const bankResult = await pool.query(`
          INSERT INTO banks (name, short_name)
          VALUES ($1, $2)
          ON CONFLICT (name) DO UPDATE SET short_name = COALESCE(banks.short_name, EXCLUDED.short_name), updated_at = NOW()
          RETURNING id
        `, [bank.name, shortName]);
        const bankId = bankResult.rows[0].id;
        banksAdded++;

        await pool.query(`
          INSERT INTO deal_appointments (deal_id, bank_id, roles, raw_role, is_lead, source_url)
          VALUES ($1, $2, $3::bank_role[], $4, $5, $6)
          ON CONFLICT (deal_id, bank_id) DO UPDATE SET
            roles = EXCLUDED.roles,
            raw_role = EXCLUDED.raw_role,
            is_lead = EXCLUDED.is_lead,
            source_url = COALESCE(EXCLUDED.source_url, deal_appointments.source_url)
        `, [dealId, bankId, roles, bank.role, isLead, item.ocPdfUrl || null]);
        appointmentsAdded++;
        itemBanksAdded++;
      }

      dealsUpdated++;
      results.push({ hkexAppId: item.hkexAppId, company: companyName, banksAdded: itemBanksAdded, ocLink: ocAdded });
    }

    res.json({
      message: `Updated ${dealsUpdated}/${items.length} deals, ${appointmentsAdded} appointments, ${ocLinksAdded} OC links`,
      dealsUpdated,
      banksAdded,
      appointmentsAdded,
      ocLinksAdded,
      results,
    });
  } catch (err) {
    console.error('Batch add deal banks error:', err);
    res.status(500).json({ error: 'Failed to batch add deal banks' });
  }
});

/**
 * POST /api/ipo/deduplicate-banks
 * Finds banks with same short_name but different IDs, keeps lowest-id as canonical,
 * reassigns deal_appointments, and deletes duplicate bank rows.
 */
ipoRouter.post('/deduplicate-banks', async (req: Request, res: Response) => {
  try {
    const { dry_run } = req.query;
    const isDryRun = dry_run === 'true' || dry_run === '1';

    // Find duplicate groups
    const dupsResult = await pool.query(`
      SELECT short_name, array_agg(id ORDER BY id) as ids, array_agg(name ORDER BY id) as names
      FROM banks
      WHERE short_name IS NOT NULL
      GROUP BY short_name
      HAVING COUNT(*) > 1
    `);

    const groups = dupsResult.rows;
    if (groups.length === 0) {
      res.json({ message: 'No duplicate banks found', groups: 0 });
      return;
    }

    let appointmentsReassigned = 0;
    let banksDeleted = 0;
    const details: { shortName: string; canonicalId: number; duplicateIds: number[]; appointmentsMoved: number }[] = [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const group of groups) {
        const [canonicalId, ...duplicateIds] = group.ids as number[];

        if (duplicateIds.length === 0) continue;

        // For each duplicate, reassign its deal_appointments to canonical
        let movedCount = 0;
        for (const dupId of duplicateIds) {
          // Check for conflicts: if canonical already has an appointment for a deal
          // that the duplicate also has, delete the duplicate's appointment
          const conflicts = await client.query(`
            SELECT da1.deal_id FROM deal_appointments da1
            WHERE da1.bank_id = $1
            AND EXISTS (SELECT 1 FROM deal_appointments da2 WHERE da2.deal_id = da1.deal_id AND da2.bank_id = $2)
          `, [dupId, canonicalId]);

          if (conflicts.rows.length > 0) {
            const conflictDealIds = conflicts.rows.map((r: any) => r.deal_id);
            if (!isDryRun) {
              await client.query(`
                DELETE FROM deal_appointments WHERE bank_id = $1 AND deal_id = ANY($2::int[])
              `, [dupId, conflictDealIds]);
            }
          }

          // Reassign remaining appointments from duplicate to canonical
          if (!isDryRun) {
            const reassigned = await client.query(`
              UPDATE deal_appointments SET bank_id = $1 WHERE bank_id = $2 RETURNING id
            `, [canonicalId, dupId]);
            movedCount += reassigned.rowCount || 0;
          } else {
            const countResult = await client.query(`
              SELECT COUNT(*) as cnt FROM deal_appointments WHERE bank_id = $1
            `, [dupId]);
            movedCount += parseInt(countResult.rows[0].cnt);
          }

          // Delete the duplicate bank
          if (!isDryRun) {
            await client.query(`DELETE FROM banks WHERE id = $1`, [dupId]);
            banksDeleted++;
          } else {
            banksDeleted++;
          }
        }

        appointmentsReassigned += movedCount;
        details.push({
          shortName: group.short_name,
          canonicalId,
          duplicateIds,
          appointmentsMoved: movedCount,
        });
      }

      if (!isDryRun) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      message: `${isDryRun ? '[DRY RUN] ' : ''}Deduplicated ${groups.length} bank groups: ${banksDeleted} banks deleted, ${appointmentsReassigned} appointments reassigned`,
      isDryRun,
      groups: groups.length,
      banksDeleted,
      appointmentsReassigned,
      details,
    });
  } catch (err) {
    console.error('Deduplicate banks error:', err);
    res.status(500).json({ error: 'Failed to deduplicate banks' });
  }
});

// Fix deal_appointments: reassign a deal's bank to the correct bank_id
ipoRouter.post('/fix-deal-bank', async (req: Request, res: Response) => {
  try {
    const { dealId, oldBankId, newBankId } = req.body;
    if (!dealId || !oldBankId || !newBankId) {
      return res.status(400).json({ error: 'dealId, oldBankId, newBankId required' });
    }

    // Check if new bank already assigned to this deal
    const existing = await pool.query(
      `SELECT id FROM deal_appointments WHERE deal_id = $1 AND bank_id = $2`,
      [dealId, newBankId]
    );

    let result;
    if (existing.rows.length > 0) {
      // New bank already exists for this deal, just delete the old one
      result = await pool.query(
        `DELETE FROM deal_appointments WHERE deal_id = $1 AND bank_id = $2 RETURNING id`,
        [dealId, oldBankId]
      );
      res.json({ action: 'deleted_old', deleted: result.rowCount });
    } else {
      // Update the deal_appointments row to point to the correct bank
      result = await pool.query(
        `UPDATE deal_appointments SET bank_id = $1 WHERE deal_id = $2 AND bank_id = $3 RETURNING id`,
        [newBankId, dealId, oldBankId]
      );
      res.json({ action: 'reassigned', updated: result.rowCount });
    }
  } catch (err) {
    console.error('Fix deal bank error:', err);
    res.status(500).json({ error: 'Failed to fix deal bank' });
  }
});

/**
 * POST /api/ipo/audit-banks
 * Runs heuristic checks + LLM verification + auto-fix for bank data quality.
 * Phase 1: flags deals with 0 banks, no sponsor, single bank, no OC PDF.
 * Phase 2: for flagged deals, re-parses PDFs and uses DeepSeek to verify, auto-writes fixes.
 */
ipoRouter.post('/audit-banks', async (req: Request, res: Response) => {
  try {
    const { auditBanks } = await import('./audit-banks.js');
    const result = await auditBanks(pool);
    res.json(result);
  } catch (err) {
    console.error('Audit banks error:', err);
    res.status(500).json({ error: 'Failed to audit banks' });
  }
});

export default ipoRouter;
