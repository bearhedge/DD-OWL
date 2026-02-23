import { BenchmarkCase, FunnelSnapshot, IssueTrace, TraceReport } from '../types.js';

function keywordMatchesText(keywords: string[], text: string): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

export function traceFunnel(snapshot: FunnelSnapshot, benchmark: BenchmarkCase): TraceReport {
  const traces: IssueTrace[] = [];

  for (const issue of benchmark.expectedIssues) {
    const phasePresence: IssueTrace['phasePresence'] = [];
    let found = false;
    let lostAtPhase: string | undefined;
    let lostReason: string | undefined;
    let lastSeenPhase: string | undefined;

    for (const phase of snapshot.phases) {
      const matches = phase.articles.filter(a => {
        const text = `${a.title || ''} ${a.snippet || ''} ${a.clusterLabel || ''}`;
        return keywordMatchesText(issue.keywords, text);
      });

      phasePresence.push({
        phase: phase.phase,
        matchCount: matches.length,
        detail: matches.length > 0
          ? matches.slice(0, 3).map(m => m.title?.slice(0, 60)).join('; ')
          : undefined,
      });

      if (matches.length > 0) {
        lastSeenPhase = phase.phase;

        if (phase.phase === 'elimination') {
          const eliminated = matches.filter(m => m.eliminationRule);
          if (eliminated.length === matches.length) {
            lostAtPhase = 'elimination';
            lostReason = `All ${matches.length} articles eliminated (rules: ${[...new Set(eliminated.map(e => e.eliminationRule))].join(', ')})`;
          }
        }
        if (phase.phase === 'categorize') {
          const greened = matches.filter(m => m.classification === 'GREEN');
          if (greened.length === matches.length) {
            lostAtPhase = 'categorize';
            lostReason = `All ${matches.length} matching clusters classified GREEN`;
          }
        }
        if (phase.phase === 'clustering') {
          const parked = matches.filter(m => m.parked);
          if (parked.length === matches.length) {
            lostAtPhase = 'clustering';
            lostReason = `All ${matches.length} articles parked (not in top 5 per cluster)`;
          }
        }
      }

      if (phase.phase === 'consolidate' && matches.length > 0) {
        found = true;
        lostAtPhase = undefined;
        lostReason = undefined;
      }
    }

    if (!found && !lostAtPhase) {
      if (!lastSeenPhase) {
        lostAtPhase = 'gather';
        lostReason = 'No articles with matching keywords were gathered';
      } else {
        lostAtPhase = lastSeenPhase;
        lostReason = `Last seen at ${lastSeenPhase} but not in final output`;
      }
    }

    traces.push({
      issueId: issue.id,
      description: issue.description,
      found,
      lostAtPhase: found ? undefined : lostAtPhase,
      lostReason: found ? undefined : lostReason,
      phasePresence,
    });
  }

  const totalFound = traces.filter(t => t.found).length;

  return {
    subject: snapshot.subject,
    runId: snapshot.runId,
    timestamp: new Date().toISOString(),
    recall: benchmark.expectedIssues.length > 0
      ? Math.round((totalFound / benchmark.expectedIssues.length) * 100) / 100
      : 1,
    totalExpected: benchmark.expectedIssues.length,
    totalFound,
    traces,
  };
}

export function printTraceReport(report: TraceReport): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`BENCHMARK: ${report.subject}`);
  console.log(`Recall: ${report.totalFound}/${report.totalExpected} (${Math.round(report.recall * 100)}%)`);
  console.log('='.repeat(60));

  const found = report.traces.filter(t => t.found);
  const lost = report.traces.filter(t => !t.found);

  if (found.length > 0) {
    console.log(`\nFOUND (${found.length}):`);
    for (const t of found) {
      const lastPhase = t.phasePresence.filter(p => p.matchCount > 0).pop();
      console.log(`  [OK] ${t.description} → ${lastPhase?.detail?.slice(0, 50) || ''}`);
    }
  }

  if (lost.length > 0) {
    console.log(`\nLOST (${lost.length}):`);
    for (const t of lost) {
      console.log(`  [MISS] ${t.description}`);
      for (const p of t.phasePresence) {
        if (p.matchCount > 0) {
          console.log(`    ${p.phase}: ${p.matchCount} matches — ${p.detail || ''}`);
        }
      }
      console.log(`    LOST AT: ${t.lostAtPhase} — ${t.lostReason}`);
    }
  }

  console.log(`\n${'='.repeat(60)}\n`);
}
