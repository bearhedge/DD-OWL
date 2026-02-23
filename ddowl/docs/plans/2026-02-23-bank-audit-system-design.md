# Bank Audit System Design

## Problem

The OC PDF scraper uses regex to extract banks/sponsors from messy PDFs. Errors include missing banks (e.g. Livermore filtered by generic HOLDINGS LIMITED rule), wrong roles, garbage entries, and completely missed extractions. Currently there's no way to detect these problems without manually checking each deal.

## Solution

A single endpoint `POST /api/ipo/audit-banks` that runs a two-phase audit:

### Phase 1: Heuristic Flags (instant, free)

DB queries to flag obvious problems:

| Check | Condition |
|-------|-----------|
| No banks | `deal_appointments` count = 0 |
| No sponsor | No bank with `sponsor` in roles array |
| Single bank only | Only 1 `deal_appointment` (unusual for IPOs) |
| No OC PDF | No `oc_announcements` record |

### Phase 2: LLM Verify + Auto-fix (flagged deals only)

For each flagged deal:
1. Download OC PDF text (existing PDF parser)
2. Send to DeepSeek (`deepseek-chat`) with prompt to extract all banks and roles
3. Compare LLM output vs DB records
4. Auto-write missing banks to DB
5. Report all findings and fixes

### Response Format

```json
{
  "summary": { "total_active": 45, "flagged": 12, "verified": 12, "fixed": 4 },
  "fixes": [
    { "company": "Glorysoft", "added": ["Livermore Holdings Limited"], "roles_corrected": [] }
  ],
  "still_broken": [
    { "company": "Some Corp", "reason": "No OC PDF available" }
  ]
}
```

## Tech

- DeepSeek `deepseek-chat` via `https://api.deepseek.com/v1/chat/completions` (same pattern as triage.ts, analyzer.ts)
- `DEEPSEEK_API_KEY` env var (already configured)
- Existing PDF parser (`PDFParse` from pdf-parse + pdfjs-dist cmaps)
- New module: `ddowl/src/audit-banks.ts` (heuristic queries + LLM verification logic)
- New endpoint in `ddowl/src/ipo-api.ts`
- Uses existing `normalizeBankName()` and bank upsert patterns

## Cost

Heuristics: free. LLM calls: ~$0.001-0.005 per PDF with DeepSeek. Typical audit of 10-20 flagged deals: under $0.10.
