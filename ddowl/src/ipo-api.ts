/**
 * IPO Tracker API Routes
 *
 * Endpoints for accessing IPO deal and bank data
 */

import { Router, Request, Response } from 'express';
import { pool } from './db/index.js';

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
        array_agg(DISTINCT da.source_url) FILTER (WHERE da.source_url IS NOT NULL) as pdf_links
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN deal_appointments da ON da.deal_id = d.id
      LEFT JOIN banks b ON b.id = da.bank_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND d.status = $${paramIndex++}`;
      params.push(status);
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

    // Default limit: 200 for listed, 500 for active
    const defaultLimit = status === 'listed' ? 200 : (status === 'active' ? 500 : 50);
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
              // Upsert bank
              const bankResult = await pool.query(`
                INSERT INTO banks (name)
                VALUES ($1)
                ON CONFLICT (name) DO NOTHING
                RETURNING id
              `, [bank.bank]);

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
        const deals = await scrapeAllApplications({ years: [2026, 2025], extractBanks: true });

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

          // Upsert company
          const companyResult = await pool.query(`
            INSERT INTO companies (name_en)
            VALUES ($1)
            ON CONFLICT (name_en) DO UPDATE SET updated_at = NOW()
            RETURNING id
          `, [deal.company]);
          const companyId = companyResult.rows[0].id;

          // Upsert deal
          const dealResult = await pool.query(`
            INSERT INTO deals (company_id, status, filing_date, hkex_app_id, board)
            VALUES ($1, 'active', $2, $3, $4)
            ON CONFLICT (company_id) WHERE status = 'active' DO UPDATE SET
              filing_date = COALESCE(EXCLUDED.filing_date, deals.filing_date),
              hkex_app_id = COALESCE(EXCLUDED.hkex_app_id, deals.hkex_app_id),
              updated_at = NOW()
            RETURNING id, (xmax = 0) as inserted
          `, [companyId, filingDate, deal.appId, deal.board]);

          const dealId = dealResult.rows[0].id;
          if (dealResult.rows[0].inserted) newDeals++;

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
            const bankResult = await pool.query(`
              INSERT INTO banks (name)
              VALUES ($1)
              ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
              RETURNING id
            `, [bank.bank]);
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
    const results: { company: string; banksFound: number; chineseName: string | null }[] = [];

    for (const deal of missing) {
      if (!deal.pdf_url) {
        results.push({ company: deal.company_name, banksFound: -1, chineseName: null });
        continue;
      }

      console.log(`Re-scraping: ${deal.company_name}`);
      const { banks, chineseName } = await extractBanksFromPdfUrl(deal.pdf_url);

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
          const bankResult = await pool.query(`
            INSERT INTO banks (name) VALUES ($1)
            ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
            RETURNING id
          `, [bank.bank]);
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

      results.push({ company: deal.company_name, banksFound: banks.length, chineseName });
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
             oc.pdf_url
      FROM deals d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN oc_announcements oc ON oc.deal_id = d.id
      WHERE d.status = 'active' AND c.name_cn IS NULL AND oc.pdf_url IS NOT NULL
      ORDER BY d.filing_date DESC
    `);

    const deals = missingResult.rows;
    if (deals.length === 0) {
      res.json({ message: 'All active deals already have Chinese names', count: 0 });
      return;
    }

    const { extractBanksFromPdfUrl } = await import('./hkex-scraper-v2.js');

    let extracted = 0;
    const results: { company: string; chineseName: string | null }[] = [];

    for (const deal of deals) {
      console.log(`Extracting Chinese name: ${deal.company_name}`);
      const { chineseName } = await extractBanksFromPdfUrl(deal.pdf_url);

      if (chineseName) {
        await pool.query(`
          UPDATE companies SET name_cn = $1, updated_at = NOW()
          WHERE id = $2 AND name_cn IS NULL
        `, [chineseName, deal.company_id]);
        extracted++;
        console.log(`  → ${chineseName}`);
      }

      results.push({ company: deal.company_name, chineseName });
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
 * POST /api/ipo/check-listings
 * Checks active deals against HKEX securities list for newly listed companies
 */
ipoRouter.post('/check-listings', async (req: Request, res: Response) => {
  try {
    const { checkListings } = await import('./listing-detector.js');
    const result = await checkListings(pool);
    res.json(result);
  } catch (err) {
    console.error('Check listings error:', err);
    res.status(500).json({ error: 'Failed to check listings' });
  }
});

export default ipoRouter;
