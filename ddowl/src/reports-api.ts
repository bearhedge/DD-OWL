import { Router, Request, Response } from 'express';
import {
  saveReport, getReport, listReports,
  updateFindingVerdict, addMissedFlag, saveEditedReport,
  getStats, getSourceRanking, getLearnings,
  type SaveReportInput,
} from './reports-db.js';

export const reportsRouter = Router();

// GET /api/reports — list all reports (with optional search)
reportsRouter.get('/', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const search = req.query.q as string | undefined;
  const result = listReports({ limit, offset, search });
  res.json(result);
});

// GET /api/reports/stats — accuracy stats
reportsRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getStats());
});

// GET /api/reports/stats/sources — source reliability ranking
reportsRouter.get('/stats/sources', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(getSourceRanking(limit));
});

// GET /api/reports/learnings — what DD-Owl has learned
reportsRouter.get('/learnings', (_req: Request, res: Response) => {
  res.json(getLearnings());
});

// GET /api/reports/stats/summary — CLI-friendly text summary
reportsRouter.get('/stats/summary', (_req: Request, res: Response) => {
  const s = getStats();
  const totalFlags = s.confirmed + s.wrong;
  const text = [
    `DD Owl — ${s.totalReports} reports`,
    `Flags found: ${totalFlags} (Confirmed: ${s.confirmed}, Wrong: ${s.wrong})`,
    `Missed flags: ${s.missed}`,
    `Accuracy: ${(s.accuracy * 100).toFixed(1)}%`,
    `Miss rate: ${(s.missRate * 100).toFixed(1)}%`,
    `Avg edit distance: ${(s.avgEditDistance * 100).toFixed(1)}%`,
    `Total cost: $${s.totalCostUsd.toFixed(2)}`,
    s.topConfirmedTypes.length > 0
      ? `Top flag types: ${s.topConfirmedTypes.map(t => t.eventType).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
  res.type('text/plain').send(text);
});

// GET /api/reports/:id — single report with findings + missed flags
reportsRouter.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const report = getReport(id);
  if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
  res.json(report);
});

// PATCH /api/reports/:id/edit — save human-edited report
reportsRouter.patch('/:id/edit', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { editedMarkdown } = req.body;
  if (!editedMarkdown) { res.status(400).json({ error: 'editedMarkdown required' }); return; }
  saveEditedReport(id, editedMarkdown);
  const report = getReport(id);
  res.json({ success: true, editDistance: report?.edit_distance });
});

// PATCH /api/reports/findings/:id/verdict — mark finding as CONFIRMED or WRONG
reportsRouter.patch('/findings/:id/verdict', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { verdict, wrongReason } = req.body;
  if (!['CONFIRMED', 'WRONG'].includes(verdict)) {
    res.status(400).json({ error: 'verdict must be CONFIRMED or WRONG' }); return;
  }
  updateFindingVerdict(id, verdict, wrongReason);
  res.json({ success: true });
});

// POST /api/reports/:id/missed — add a missed flag
reportsRouter.post('/:id/missed', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { description, severity, eventType } = req.body;
  if (!description) { res.status(400).json({ error: 'description required' }); return; }
  const flagId = addMissedFlag(id, { description, severity: severity || 'RED', eventType });
  res.json({ success: true, id: flagId });
});
