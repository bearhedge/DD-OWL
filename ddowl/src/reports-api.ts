import { Router, Request, Response } from 'express';
import {
  saveReport, getReport, listReports,
  updateFindingVerdict, addMissedFlag, saveEditedReport,
  setQualityRating, listChangelog, addChangelogEntry,
  getStats, getSourceRanking, getLearnings,
  deleteReport, deleteAllReports,
  type SaveReportInput,
} from './reports-db.js';
import { deleteAllSessions } from './session-store.js';

export const reportsRouter = Router();

// GET /api/reports — list all reports (with optional search)
reportsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.q as string | undefined;
    const result = await listReports({ limit, offset, search });
    res.json(result);
  } catch (err) {
    console.error('[REPORTS API] Error listing reports:', err);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// DELETE /api/reports — clear all reports, sources, and sessions
reportsRouter.delete('/', async (_req: Request, res: Response) => {
  try {
    await deleteAllReports();
    await deleteAllSessions();
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS API] Error deleting all reports:', err);
    res.status(500).json({ error: 'Failed to delete all reports' });
  }
});

// DELETE /api/reports/:id — delete single report
reportsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    await deleteReport(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS API] Error deleting report:', err);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// GET /api/reports/stats — accuracy stats
reportsRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    res.json(await getStats());
  } catch (err) {
    console.error('[REPORTS API] Error getting stats:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/reports/stats/sources — source reliability ranking
reportsRouter.get('/stats/sources', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(await getSourceRanking(limit));
  } catch (err) {
    console.error('[REPORTS API] Error getting source ranking:', err);
    res.status(500).json({ error: 'Failed to get source ranking' });
  }
});

// GET /api/reports/learnings — what DD-Owl has learned
reportsRouter.get('/learnings', async (_req: Request, res: Response) => {
  try {
    res.json(await getLearnings());
  } catch (err) {
    console.error('[REPORTS API] Error getting learnings:', err);
    res.status(500).json({ error: 'Failed to get learnings' });
  }
});

// GET /api/reports/stats/summary — CLI-friendly text summary
reportsRouter.get('/stats/summary', async (_req: Request, res: Response) => {
  try {
    const s = await getStats();
    const totalFlags = s.confirmed + s.wrong;
    const text = [
      `DD Owl — ${s.totalReports} reports`,
      `Flags found: ${totalFlags} (Confirmed: ${s.confirmed}, Wrong: ${s.wrong})`,
      `Missed flags: ${s.missed}`,
      `Accuracy: ${(s.accuracy * 100).toFixed(1)}%`,
      `Miss rate: ${(s.missRate * 100).toFixed(1)}%`,
      `Avg edit distance: ${(s.avgEditDistance * 100).toFixed(1)}%`,
      s.topConfirmedTypes.length > 0
        ? `Top flag types: ${s.topConfirmedTypes.map(t => t.eventType).join(', ')}`
        : '',
    ].filter(Boolean).join('\n');
    res.type('text/plain').send(text);
  } catch (err) {
    console.error('[REPORTS API] Error getting summary:', err);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

// GET /api/reports/changelog — list all changelog entries
reportsRouter.get('/changelog', async (_req: Request, res: Response) => {
  try {
    res.json(await listChangelog());
  } catch (err) {
    console.error('[REPORTS API] Error listing changelog:', err);
    res.status(500).json({ error: 'Failed to list changelog' });
  }
});

// POST /api/reports/changelog — add new changelog entry
reportsRouter.post('/changelog', async (req: Request, res: Response) => {
  try {
    const { date, description, category } = req.body;
    if (!date || !description) { res.status(400).json({ error: 'date and description required' }); return; }
    const id = await addChangelogEntry(date, description, category || 'prompt');
    res.json({ success: true, id });
  } catch (err) {
    console.error('[REPORTS API] Error adding changelog entry:', err);
    res.status(500).json({ error: 'Failed to add changelog entry' });
  }
});

// GET /api/reports/:id — single report with findings + missed flags
reportsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const report = await getReport(id);
    if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
    res.json(report);
  } catch (err) {
    console.error('[REPORTS API] Error getting report:', err);
    res.status(500).json({ error: 'Failed to get report' });
  }
});

// PATCH /api/reports/:id/edit — save human-edited report
reportsRouter.patch('/:id/edit', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { editedMarkdown } = req.body;
    if (!editedMarkdown) { res.status(400).json({ error: 'editedMarkdown required' }); return; }
    await saveEditedReport(id, editedMarkdown);
    const report = await getReport(id);
    res.json({ success: true, editDistance: report?.edit_distance });
  } catch (err) {
    console.error('[REPORTS API] Error saving edited report:', err);
    res.status(500).json({ error: 'Failed to save edited report' });
  }
});

// PATCH /api/reports/:id/rating — set quality rating
reportsRouter.patch('/:id/rating', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { rating } = req.body;
    if (!rating || rating < 1 || rating > 10) { res.status(400).json({ error: 'rating must be 1-10' }); return; }
    await setQualityRating(id, rating);
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS API] Error setting rating:', err);
    res.status(500).json({ error: 'Failed to set rating' });
  }
});

// PATCH /api/reports/findings/:id/verdict — mark finding as CONFIRMED or WRONG
reportsRouter.patch('/findings/:id/verdict', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { verdict, wrongReason } = req.body;
    if (!['CONFIRMED', 'WRONG'].includes(verdict)) {
      res.status(400).json({ error: 'verdict must be CONFIRMED or WRONG' }); return;
    }
    await updateFindingVerdict(id, verdict, wrongReason);
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS API] Error updating verdict:', err);
    res.status(500).json({ error: 'Failed to update verdict' });
  }
});

// POST /api/reports/:id/missed — add a missed flag
reportsRouter.post('/:id/missed', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { description, severity, eventType } = req.body;
    if (!description) { res.status(400).json({ error: 'description required' }); return; }
    const flagId = await addMissedFlag(id, { description, severity: severity || 'RED', eventType });
    res.json({ success: true, id: flagId });
  } catch (err) {
    console.error('[REPORTS API] Error adding missed flag:', err);
    res.status(500).json({ error: 'Failed to add missed flag' });
  }
});
