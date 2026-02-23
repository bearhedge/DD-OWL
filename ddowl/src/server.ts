import 'dotenv/config';

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION] Promise:', promise, 'Reason:', reason);
  // Don't exit - let the server continue running
});

process.on('uncaughtException', (error: any) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  // Don't exit for non-fatal errors (network and stream errors)
  if (error.message?.includes('ECONNRESET') || error.message?.includes('ETIMEDOUT') ||
      error.code === 'ERR_STREAM_WRITE_AFTER_END' || error.code === 'ERR_STREAM_DESTROYED') {
    console.log('[RECOVERY] Ignoring network/stream error, continuing...');
    return;
  }
});

import express, { Request, Response } from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { SEARCH_TEMPLATES, CHINESE_TEMPLATES, ENGLISH_TEMPLATES, SITE_TEMPLATES, ENGLISH_SITE_TEMPLATES, TEMPLATE_CATEGORIES, buildSearchQuery, buildSearchQueryWithVariants, isChineseName, detectScript, LANGUAGE_CONFIG, selectSupplementaryTemplates, inferGeographyFromName } from './searchStrings.js';
import { searchAllPages, searchAllEngines, SearchProgressCallback, searchAll, BatchSearchResult, searchGoogle } from './searcher.js';
import { getSerperKeyManager } from './serperKeyManager.js';
import { isBaiduAvailable } from './baiduSearcher.js';
import { fetchPageContent, analyzeWithLLM, closeBrowser, quickScan } from './analyzer.js';
import { triageSearchResults, TriageResult, categorizeAll, CategorizedResult } from './triage.js';
import { consolidateFindings } from './consolidator.js';
import { generateFullReport, generateCleanWriteUp, generateWriteUp } from './reportGenerator.js';
import { RawFinding, ConsolidatedFinding, SearchResult, SubjectProfile, ProfileFact } from './types.js';
import { extractFinding, isSameFinding, mergeFindings, Finding } from './extract.js';
import { detectCategory } from './searchStrings.js';
import { DDOwlReport, DDOwlReportV2, Issue, AnalyzedResult } from './types.js';
import { ipoRouter } from './ipo-api.js';
import { initWSServer, getWSServer } from './ws-server.js';
import { getQueueStats } from './database.js';
import { generatePersonReport, generateCompanyReport, saveReport } from './report.js';
import { getSessionStatus, getSessionResults, clearSession } from './research-session.js';
import { getResearchStatus, startPersonResearch, stopPersonResearch } from './person-research.js';
import { generateWordReport } from './word-report.js';
import { loadHistory, markRunClean, getRunDiff } from './run-tracker.js';
import { validateDeals } from './validator.js';
import { initLogDirectories, saveScreeningLog as saveLog, loadScreeningLog as loadLog, listScreeningLogs, saveBenchmarkResult, loadBenchmarkResults, saveFunnelSnapshot } from './logging/storage.js';
import { MetricsTracker } from './metrics/tracker.js';
import { evaluateBenchmark, getBenchmarkCase } from './metrics/benchmarks.js';
import { traceFunnel, printTraceReport } from './metrics/tracer.js';
import { FunnelPhaseSnapshot, FunnelSnapshot } from './types.js';
import { eliminateObviousNoise, getEliminationBreakdown, EliminationResult, EliminationBreakdown, EliminatedResult, llmBatchTitleDedupe, TitleDedupeProgress } from './eliminator.js';
import { getChineseVariantsLLM } from './utils/chinese.js';
import { createSession, getSession, updateSession, deleteSession, ScreeningSession, DetectedCompany } from './session-store.js';
import { clusterByIncidentLLM, ClusteringResult, ClusterProgressCallback, IncidentCluster } from './deduplicator.js';
import { initReportsDb, saveReport as saveReportToDb, saveReportMarkdown, type CleanEntityResult } from './reports-db.js';
import { reportsRouter } from './reports-api.js';
// URL validation to filter out corrupted URLs (e.g., Baidu tracking URLs)
function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    // Must be http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Filter out known bad patterns
    if (url.includes('nourl.') || url.includes('.baidu.com/link')) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ref', 'source'];
    trackingParams.forEach(param => parsed.searchParams.delete(param));
    // Remove trailing slash
    let normalized = parsed.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url; // Return original if URL parsing fails
  }
}

function deduplicateResults<T extends { url: string }>(results: T[]): { unique: T[]; duplicateCount: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicateCount = 0;

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.url);
    if (!seen.has(normalizedUrl)) {
      seen.add(normalizedUrl);
      unique.push(result);
    } else {
      duplicateCount++;
    }
  }

  return { unique, duplicateCount };
}

/**
 * Extract Chinese characters from a title (for similarity comparison)
 */
function extractChineseChars(title: string): string {
  return title
    .replace(/[-_|–—].{0,20}$/, '')     // Remove site suffix
    .replace(/[^\u4e00-\u9fff]/g, '');   // Keep only Chinese chars
}

/**
 * Check if two Chinese titles are about the same story using bigram overlap.
 * Requires ≥50% shared bigrams — catches "华住被约谈季琦" vs "季琦华住被约谈".
 */
function areSimilarChineseTitles(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return a === b;

  // Build bigram sets
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  // Count intersection
  let shared = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) shared++;
  }

  const minSize = Math.min(bigramsA.size, bigramsB.size);
  return minSize > 0 && (shared / minSize) >= 0.5;
}

/**
 * Group results by similar titles to avoid analyzing the same story 20 times.
 * Uses bigram overlap for Chinese titles (catches reworded duplicates).
 * Keeps max N per group, parks rest for manual review.
 */
function groupByTitleSimilarity<T extends { title: string; url: string }>(
  results: T[],
  maxPerGroup: number = 5
): { toAnalyze: T[]; parked: T[] } {
  // Each group: { key: string, chars: string, items: T[] }
  const groups: { chars: string; items: T[] }[] = [];

  for (const result of results) {
    const chars = extractChineseChars(result.title);

    // Non-Chinese titles: use domain+prefix as before
    if (chars.length < 3) {
      try {
        const domain = new URL(result.url).hostname;
        const fallbackKey = `${domain}_${result.title.slice(0, 20)}`;
        const existing = groups.find(g => g.chars === fallbackKey);
        if (existing) {
          existing.items.push(result);
        } else {
          groups.push({ chars: fallbackKey, items: [result] });
        }
      } catch {
        const misc = groups.find(g => g.chars === '_misc');
        if (misc) misc.items.push(result);
        else groups.push({ chars: '_misc', items: [result] });
      }
      continue;
    }

    // Chinese titles: find existing group with high bigram overlap
    let matched = false;
    for (const group of groups) {
      if (group.chars.length >= 3 && areSimilarChineseTitles(chars, group.chars)) {
        group.items.push(result);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push({ chars, items: [result] });
    }
  }

  const toAnalyze: T[] = [];
  const parked: T[] = [];

  for (const group of groups) {
    toAnalyze.push(...group.items.slice(0, maxPerGroup));
    parked.push(...group.items.slice(maxPerGroup));
  }

  return { toAnalyze, parked };
}

// ============================================================
// PHASE 1.5: COMPANY EXPANSION HELPERS
// Extract associated companies from SFC/registry pages and search for adverse media
// ============================================================

/**
 * Extract company names from SFC/registry pages in search results
 */
function extractCompaniesFromResults(results: BatchSearchResult[]): DetectedCompany[] {
  const companies: DetectedCompany[] = [];

  // Patterns for SFC/registry URLs
  const registryPatterns = [
    /sfc\.hk/i,
    /employproof\.org\/eplicensed/i,
    /hksecwiki\.com/i,
    /hkma\.gov\.hk/i,
    /apps\.sfc\.hk/i,
  ];

  for (const result of results) {
    const isRegistry = registryPatterns.some(p => p.test(result.url));
    if (!isRegistry) continue;

    // Extract company from title - Pattern: "COMPANY_EN COMPANY_CN" or just Chinese
    // Example: "TransAsia Private Capital 寰亞資本管理- 開戶優惠"
    const titleMatch = result.title.match(/^([A-Za-z\s]+(?:Limited|Ltd|Capital|Private|Securities|Asset|Management)?)\s*([\u4e00-\u9fff]+)/i);
    if (titleMatch) {
      const english = titleMatch[1].trim();
      const chinese = titleMatch[2].trim();
      // Only add if we have a meaningful company name (not just single chars)
      if ((english.length > 3 || chinese.length >= 2) && !companies.find(c => c.chinese === chinese)) {
        companies.push({
          english: english,
          chinese: chinese,
          source: result.url
        });
      }
    }

    // Also check snippet for company patterns
    // Look for patterns like "寰亞資本管理有限公司" or "TransAsia Private Capital Limited"
    const snippet = result.snippet || '';
    const snippetMatch = snippet.match(/([\u4e00-\u9fff]{2,}(?:資本|资本|證券|证券|投資|投资|管理|基金|控股)(?:有限公司|管理)?)/);
    if (snippetMatch && !companies.find(c => c.chinese === snippetMatch[1])) {
      // Try to find English name nearby in snippet
      const engMatch = snippet.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\s*(?:Limited|Ltd|Capital|Private|Securities)?/);
      companies.push({
        english: engMatch?.[1] || '',
        chinese: snippetMatch[1],
        source: result.url
      });
    }
  }

  // Dedupe by Chinese name
  const seen = new Set<string>();
  return companies.filter(c => {
    if (seen.has(c.chinese)) return false;
    seen.add(c.chinese);
    return true;
  });
}

/**
 * Search for adverse media about a company
 */
async function searchCompanyAdverseMedia(
  company: DetectedCompany,
  signal?: AbortSignal
): Promise<BatchSearchResult[]> {
  const results: BatchSearchResult[] = [];

  // Build queries with adverse keywords
  const queries: string[] = [];

  if (company.english && company.english.length > 3) {
    queries.push(`"${company.english}" lawsuit OR sued OR debt OR scandal OR fraud`);
  }
  if (company.chinese && company.chinese.length >= 2) {
    queries.push(`"${company.chinese}" 訴訟 OR 醜聞 OR 債務 OR 欺詐 OR 調查 OR 違規`);
  }

  for (const query of queries) {
    if (signal?.aborted) break;
    try {
      const searchResults = await searchGoogle(query, 1, 10, signal);
      for (const r of searchResults) {
        results.push({
          url: r.link,  // SearchResult uses 'link' not 'url'
          title: r.title,
          snippet: r.snippet || '',
          query: query,
        });
      }
    } catch (e) {
      console.error(`[COMPANY_EXPANSION] Search failed for ${company.chinese}:`, e);
    }
  }

  // Dedupe by URL
  const seen = new Set<string>();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Check if the screening subject is a company (vs an individual)
 */
function isCompanyScreening(name: string): boolean {
  const companyIndicators = [
    /公司$/, /集团$/, /集團$/, /Corp/i, /Inc\b/i, /Ltd/i, /Limited/i, /Group/i,
    /Corporation/i, /Holdings/i, /Enterprise/i, /Co\.$/i, /LLC/i, /PLC/i,
    /有限$/, /股份$/
  ];
  return companyIndicators.some(p => p.test(name));
}

/**
 * Deduplicate companies by normalizing English/Chinese names
 */
function deduplicateCompanies(companies: DetectedCompany[]): DetectedCompany[] {
  const seen = new Set<string>();
  return companies.filter(c => {
    const key = (c.chinese || c.english || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize log directories
initLogDirectories();

// Track active screenings to prevent duplicates
const activeScreenings = new Map<string, AbortController>();

// Helper to check if a session has been paused by the user
async function isSessionPaused(sessionId: string): Promise<boolean> {
  try {
    const session = await getSession(sessionId);
    return session?.isPaused === true;
  } catch (e) {
    console.error(`[PAUSE CHECK] Error checking pause state for ${sessionId}:`, e);
    return false;
  }
}

// Initialize reports database
initReportsDb()
  .then(() => console.log('[REPORTS] Database initialized'))
  .catch((err) => console.error('[REPORTS] Failed to initialize database:', err));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// IPO Tracker API routes
app.use('/api/ipo', ipoRouter);
app.use('/api/reports', reportsRouter);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ddowl' });
});

// Main screening endpoint with Server-Sent Events
app.get('/api/screen', async (req: Request, res: Response) => {
  const subjectName = req.query.name as string;

  if (!subjectName || subjectName.trim().length < 2) {
    res.status(400).json({ error: 'Please provide a valid name (2+ characters)' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const redFlags: AnalyzedResult[] = [];
    const amberFlags: AnalyzedResult[] = [];
    let greenCount = 0;
    let totalAnalyzed = 0;
    const seenUrls = new Set<string>();

    // Process each search template
    for (let i = 0; i < SEARCH_TEMPLATES.length; i++) {
      const template = SEARCH_TEMPLATES[i];
      const query = buildSearchQuery(template, subjectName);

      sendEvent({
        type: 'progress',
        searchIndex: i + 1,
        totalSearches: SEARCH_TEMPLATES.length,
        currentTerm: query.slice(0, 80),
      });

      // Search with pagination (Google + Baidu)
      const searchResults = await searchAllEngines(query, 5, 2);

      // Analyze each result
      for (const result of searchResults) {
        // Skip duplicates
        if (seenUrls.has(result.link)) continue;
        seenUrls.add(result.link);

        // Skip PDFs and other non-HTML content
        const lowerUrl = result.link.toLowerCase();
        if (lowerUrl.endsWith('.pdf') || lowerUrl.endsWith('.doc') || lowerUrl.endsWith('.docx')) {
          continue;
        }

        // Send fetch event
        sendEvent({
          type: 'fetch',
          url: result.link,
          title: result.title,
        });

        // Fetch page content with error handling
        let content = '';
        try {
          content = await fetchPageContent(result.link);
        } catch (fetchErr) {
          console.error(`Fetch failed for ${result.link}:`, fetchErr);
          continue;
        }

        if (content.length > 50) {
          // Send analyze event
          sendEvent({
            type: 'analyze',
            url: result.link,
            title: result.title,
          });

          // Analyze with LLM (with error handling)
          let analysis;
          try {
            analysis = await analyzeWithLLM(content, subjectName, query);
          } catch (llmErr) {
            console.error(`LLM analysis failed for ${result.link}:`, llmErr);
            continue;
          }
          totalAnalyzed++;

          const analyzed: AnalyzedResult = {
            url: result.link,
            title: result.title,
            snippet: result.snippet,
            isAdverse: analysis.isAdverse,
            severity: analysis.severity,
            headline: analysis.headline,
            summary: analysis.summary,
            searchTerm: query,
            category: detectCategory(query),
          };

          if (analyzed.severity === 'RED') {
            redFlags.push(analyzed);
            sendEvent({ type: 'result', result: analyzed });
          } else if (analyzed.severity === 'AMBER') {
            amberFlags.push(analyzed);
            sendEvent({ type: 'result', result: analyzed });
          } else {
            greenCount++;
          }
        }

        // Small delay to avoid overwhelming APIs
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Generate final report
    const report: DDOwlReport = {
      subject: subjectName,
      timestamp: new Date().toISOString(),
      searchesCompleted: SEARCH_TEMPLATES.length,
      totalResultsAnalyzed: totalAnalyzed,
      flags: {
        red: redFlags,
        amber: amberFlags,
        green: greenCount,
      },
      recommendedAction: determineAction(redFlags.length, amberFlags.length),
    };

    sendEvent({ type: 'complete', report });
    res.end();
  } catch (error) {
    console.error('Screening error:', error);
    sendEvent({ type: 'error', message: 'Screening failed. Please try again.' });
    res.end();
  }
});

function determineAction(redCount: number, amberCount: number): string {
  if (redCount > 0) {
    return 'ESCALATE - Red flags detected. Requires immediate L1 review.';
  }
  if (amberCount > 3) {
    return 'REVIEW - Multiple amber flags. Recommend L1 review.';
  }
  if (amberCount > 0) {
    return 'MONITOR - Minor flags detected. Document and proceed with caution.';
  }
  return 'CLEAR - No adverse information found. Proceed with standard onboarding.';
}

// V2 API - New extraction pipeline with footnote citations
app.get('/api/screen/v2', async (req: Request, res: Response) => {
  const subjectName = req.query.name as string;

  if (!subjectName || subjectName.trim().length < 2) {
    res.status(400).json({ error: 'Please provide a valid name (2+ characters)' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const findings: Finding[] = [];
    const processedUrls = new Set<string>();
    let articlesAnalyzed = 0;

    // Process each search template
    for (let i = 0; i < SEARCH_TEMPLATES.length; i++) {
      const template = SEARCH_TEMPLATES[i];
      const query = buildSearchQuery(template, subjectName);

      sendEvent({
        type: 'progress',
        searchIndex: i + 1,
        totalSearches: SEARCH_TEMPLATES.length,
        currentTerm: query.slice(0, 80),
      });

      // Search all pages with dual engines (Google + Baidu)
      const searchResults = await searchAllEngines(query, 10, 3);

      // Process all results from this search
      for (const result of searchResults) {
        if (processedUrls.has(result.link)) continue;
        processedUrls.add(result.link);

        // Skip PDFs and other non-HTML content
        const lowerUrl = result.link.toLowerCase();
        if (lowerUrl.endsWith('.pdf') || lowerUrl.endsWith('.doc') || lowerUrl.endsWith('.docx')) {
          continue;
        }

        sendEvent({
          type: 'fetch',
          url: result.link,
          title: result.title,
        });

        let content = '';
        try {
          content = await fetchPageContent(result.link);
        } catch (fetchErr) {
          console.error(`Fetch failed for ${result.link}:`, fetchErr);
          continue;
        }
        if (content.length < 100) continue;

        sendEvent({
          type: 'analyze',
          url: result.link,
        });

        articlesAnalyzed++;
        let finding;
        try {
          finding = await extractFinding(content, subjectName, result.link, result.title);
        } catch (extractErr) {
          console.error(`Extract failed for ${result.link}:`, extractErr);
          continue;
        }

        if (finding.isRelevant) {
          findings.push(finding);
          sendEvent({
            type: 'finding',
            issueType: finding.issueType,
            headline: finding.headline,
            source: finding.sourcePublisher,
          });
        }

        // Small delay
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Deduplicate findings
    sendEvent({ type: 'status', message: 'Consolidating findings...' });

    const grouped: Finding[][] = [];
    for (const finding of findings) {
      let matched = false;
      for (const group of grouped) {
        if (isSameFinding(group[0], finding)) {
          group.push(finding);
          matched = true;
          break;
        }
      }
      if (!matched) {
        grouped.push([finding]);
      }
    }

    // Merge with citations
    const merged = await Promise.all(grouped.map(g => mergeFindings(g)));

    // Build issues array
    const issues: Issue[] = merged.map(f => ({
      issueType: f.issueType || 'other',
      headline: f.headline || '',
      narrative: f.narrative || '',
      sources: [f.sourceUrl],
    }));

    // Determine overall risk
    const hasRed = issues.some(i =>
      ['criminal', 'fraud', 'corruption', 'sanctions'].includes(i.issueType)
    );
    const hasAmber = issues.some(i =>
      ['regulatory', 'civil', 'insider_trading'].includes(i.issueType)
    );

    const overallRisk: 'RED' | 'AMBER' | 'GREEN' = hasRed ? 'RED' : hasAmber ? 'AMBER' : 'GREEN';

    // Generate report
    const report: DDOwlReportV2 = {
      subject: subjectName,
      timestamp: new Date().toISOString(),
      searchesCompleted: SEARCH_TEMPLATES.length,
      articlesAnalyzed,
      issues,
      overallRisk,
      recommendedAction: determineActionV2(issues.length, overallRisk),
    };

    sendEvent({ type: 'complete', report });
    res.end();
  } catch (error) {
    console.error('Screening error:', error);
    sendEvent({ type: 'error', message: 'Screening failed. Please try again.' });
    res.end();
  }
});

function determineActionV2(issueCount: number, risk: 'RED' | 'AMBER' | 'GREEN'): string {
  if (risk === 'RED') {
    return 'ESCALATE - Serious adverse findings. Requires immediate L1 review.';
  }
  if (risk === 'AMBER') {
    return 'REVIEW - Adverse findings detected. Recommend L1 review.';
  }
  if (issueCount > 0) {
    return 'MONITOR - Minor issues found. Document and proceed with caution.';
  }
  return 'CLEAR - No adverse information found. Proceed with standard onboarding.';
}

// V3 API - Smart 3-stage triage screening
app.get('/api/screen/v3', async (req: Request, res: Response) => {
  const subjectName = req.query.name as string;
  const resumeFrom = parseInt(req.query.resumeFrom as string) || 0;

  if (!subjectName || subjectName.trim().length < 2) {
    res.status(400).json({ error: 'Name required (2+ chars)' });
    return;
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  // Disable per-request socket timeout for SSE (Cloud Run manages lifecycle)
  req.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // Collect all events for logging
  const eventLog: any[] = [];
  const sendEvent = (data: any) => {
    const event = { timestamp: new Date().toISOString(), ...data };
    eventLog.push(event);
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Connection closed (Cloud Run timeout, client disconnect) - silently ignore
      // Progress is saved to Redis independently, so lost SSE events are OK
    }
  };

  // Heartbeat (1s for robust connection stability)
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    // Force flush to bypass proxy buffering
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
    heartbeatCount++;
    if (heartbeatCount % 30 === 0) {
      console.log(`[V3] [HEARTBEAT] ${heartbeatCount} pings sent for ${subjectName}`);
    }
  }, 1000);

  try {
    const allFindings: RawFinding[] = [];
    const triageLog: any[] = [];
    const processedUrls = new Set<string>();
    let totalSearchResults = 0;
    let totalSkippedDuplicates = 0;
    let totalFetched = 0;
    let totalAnalyzed = 0;
    let totalCleared = 0;

    // Initialize metrics tracker
    const tracker = new MetricsTracker(subjectName);

    for (let i = 0; i < SEARCH_TEMPLATES.length; i++) {
      try {
        // Skip queries already completed before reconnect
        if (i < resumeFrom) {
          sendEvent({
            type: 'query_skipped',
            queryIndex: i + 1,
            reason: 'Already processed before reconnect'
          });
          continue;
        }

        const template = SEARCH_TEMPLATES[i];
        const query = buildSearchQuery(template, subjectName);

        // Stage 0: Search
        sendEvent({
          type: 'query_start',
          queryIndex: i + 1,
          totalQueries: SEARCH_TEMPLATES.length,
          query: query
        });

        // Progress callback to send page-by-page results to frontend
        const searchProgress: SearchProgressCallback = (event) => {
          if (event.type === 'page_results' && event.results && event.results.length > 0) {
            sendEvent({
              type: 'search_page',
              engine: event.engine,
              page: event.page,
              maxPages: event.maxPages,
              results: event.results.map(r => ({ title: r.title, url: r.link })),
              totalSoFar: event.totalSoFar
            });
          } else if (event.type === 'page_end' && event.results?.length === 0) {
            sendEvent({
              type: 'search_page_empty',
              engine: event.engine,
              page: event.page,
              message: `No more results after page ${(event.page || 1) - 1}`
            });
          }
        };

        const searchResults = await searchAllEngines(query, 20, 10, searchProgress);
      totalSearchResults += searchResults.length;
      tracker.recordQuery(searchResults.length);

      sendEvent({
        type: 'search_results',
        queryIndex: i + 1,
        found: searchResults.length
      });

      if (searchResults.length === 0) continue;

      // Filter out already-processed URLs (deduplication)
      const newResults = searchResults.filter(r => !processedUrls.has(r.link));
      const duplicatesSkipped = searchResults.length - newResults.length;
      totalSkippedDuplicates += duplicatesSkipped;

      if (duplicatesSkipped > 0) {
        sendEvent({
          type: 'duplicates_skipped',
          count: duplicatesSkipped,
          total: searchResults.length
        });
      }

      if (newResults.length === 0) continue;

      // Stage 1: Triage - classify each result
      sendEvent({ type: 'triage_start', count: newResults.length });

      const triage = await triageSearchResults(
        newResults.map(r => ({ title: r.title, snippet: r.snippet, url: r.link })),
        subjectName
      );

      // Mark all triaged URLs as processed
      for (const item of [...triage.green, ...triage.yellow, ...triage.red]) {
        processedUrls.add(item.url);
      }

      // Send each item's classification with reason
      for (const item of triage.green) {
        sendEvent({
          type: 'triage_item',
          classification: 'GREEN',
          title: item.title,
          reason: item.reason,
          action: 'SKIP'
        });
      }
      for (const item of triage.yellow) {
        sendEvent({
          type: 'triage_item',
          classification: 'YELLOW',
          title: item.title,
          reason: item.reason,
          action: 'QUICK_SCAN'
        });
      }
      for (const item of triage.red) {
        sendEvent({
          type: 'triage_item',
          classification: 'RED',
          title: item.title,
          reason: item.reason,
          action: 'ANALYZE'
        });
      }

      triageLog.push({
        query: query.slice(0, 60),
        red: triage.red.length,
        yellow: triage.yellow.length,
        green: triage.green.length
      });

      sendEvent({
        type: 'triage_summary',
        red: triage.red.length,
        yellow: triage.yellow.length,
        green: triage.green.length,
        skipped: triage.green.length,
        toInvestigate: triage.red.length + triage.yellow.length
      });

      tracker.recordTriage(triage.red.length, triage.yellow.length, triage.green.length);

      // Count cleared results
      totalCleared += triage.green.length;

      // Stage 2: Quick scan YELLOW results
      const toAnalyze: TriageResult[] = [...triage.red];

      for (const item of triage.yellow) {
        sendEvent({
          type: 'quick_scan_start',
          url: item.url,
          title: item.title,
          triageReason: item.reason
        });

        const scan = await quickScan(item.url, subjectName);
        totalFetched++;

        sendEvent({
          type: 'quick_scan_result',
          url: item.url,
          title: item.title,
          shouldAnalyze: scan.shouldAnalyze,
          reason: scan.reason,
          action: scan.shouldAnalyze ? 'ANALYZE' : 'SKIP'
        });

        if (scan.shouldAnalyze) {
          toAnalyze.push(item);
        } else {
          totalCleared++;
        }
      }

      // Stage 3: Deep analysis
      for (const item of toAnalyze) {
        sendEvent({
          type: 'analyze_start',
          url: item.url,
          title: item.title,
          fromTriage: item.classification
        });

        try {
          const content = await fetchPageContent(item.url);
          totalFetched++;

          if (content.length < 100) {
            // Don't silently clear - flag for manual review since triage thought it was worth investigating
            // But skip if URL is invalid
            if (!isValidUrl(item.url)) {
              console.warn(`[WARN] Skipping invalid URL: ${item.url}`);
              totalCleared++;
              continue;
            }
            allFindings.push({
              url: item.url,
              title: item.title,
              severity: item.classification === 'RED' ? 'RED' : 'AMBER',
              headline: item.title,
              summary: `${item.reason}. Source: ${item.title}. Full article content was not accessible at time of screening.`,
              triageClassification: item.classification,
              fetchFailed: true,
              snippetBased: true
            });
            sendEvent({
              type: 'analyze_result',
              url: item.url,
              title: item.title,
              isAdverse: true,
              severity: item.classification === 'RED' ? 'RED' : 'AMBER',
              headline: item.title,
              summary: `${item.reason}. Source: ${item.title}.`,
              action: 'FLAG_MANUAL_REVIEW'
            });
            continue;
          }

          const analysis = await analyzeWithLLM(content, subjectName, query);
          totalAnalyzed++;

          sendEvent({
            type: 'analyze_result',
            url: item.url,
            title: item.title,
            isAdverse: analysis.isAdverse,
            severity: analysis.severity,
            headline: analysis.headline,
            summary: analysis.summary,
            action: analysis.isAdverse ? 'FLAG' : 'CLEAR'
          });

          if (analysis.isAdverse) {
            // Skip invalid URLs
            if (!isValidUrl(item.url)) {
              console.warn(`[WARN] Skipping invalid URL: ${item.url}`);
              totalCleared++;
            } else {
              allFindings.push({
                url: item.url,
                title: item.title,
                severity: analysis.severity as 'RED' | 'AMBER',
                headline: analysis.headline,
                summary: analysis.summary,
                triageClassification: item.classification
              });
            }
          } else {
            totalCleared++;
          }
        } catch (err) {
          console.error(`Analysis failed for ${item.url}:`, err);
          sendEvent({
            type: 'analyze_error',
            url: item.url,
            error: 'Failed to fetch/analyze'
          });
        }
      }

        // Rate limit delay: wait 3 seconds before next query to avoid API throttling
        if (i < SEARCH_TEMPLATES.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (queryError: any) {
        // Isolate per-query errors - don't crash the entire screening
        console.error(`Query ${i + 1} failed:`, queryError);
        sendEvent({
          type: 'query_error',
          queryIndex: i + 1,
          error: queryError.message || 'Unknown error'
        });
        // Continue to next query
      }
    }

    // Consolidate findings (deduplicate same incidents from multiple sources)
    clearInterval(heartbeat);

    let consolidatedFindings: ConsolidatedFinding[] = [];
    if (allFindings.length > 0) {
      sendEvent({ type: 'consolidating', count: allFindings.length });
      consolidatedFindings = await consolidateFindings(allFindings, subjectName, []);
      tracker.recordConsolidation(allFindings.length, consolidatedFindings.length);
      sendEvent({
        type: 'consolidated',
        before: allFindings.length,
        after: consolidatedFindings.length
      });
    }

    // REVIEW items count as AMBER - they need manual review
    const redFindings = consolidatedFindings.filter(f => f.severity === 'RED');
    const amberFindings = consolidatedFindings.filter(f => f.severity === 'AMBER' || f.severity === 'REVIEW');

    sendEvent({
      type: 'complete',
      stats: {
        totalSearchResults,
        totalSkippedDuplicates,
        totalFetched,
        totalAnalyzed,
        totalCleared,
        findings: consolidatedFindings.length,
        red: redFindings.length,
        amber: amberFindings.length
      },
      findings: consolidatedFindings,
      triageLog
    });

    // Finalize metrics
    const metrics = tracker.finalize();

    // Evaluate against benchmark if applicable
    const benchmarkResult = evaluateBenchmark(subjectName, consolidatedFindings, metrics.runId);
    if (benchmarkResult) {
      saveBenchmarkResult(benchmarkResult);
      sendEvent({
        type: 'benchmark',
        recall: benchmarkResult.recall,
        matched: benchmarkResult.matchedIssues,
        missed: benchmarkResult.missedIssues,
      });
    }

    // Save complete screening log
    try {
      const logPath = saveLog(subjectName, metrics.runId, {
        metrics,
        findings: consolidatedFindings,
        eventLog,
        triageLog,
      });
      console.log(`[LOG] Saved screening log to ${logPath}`);
    } catch (logError) {
      console.error('[LOG] Failed to save screening log:', logError);
    }

    res.end();
  } catch (error) {
    clearInterval(heartbeat);
    console.error('V3 screening error:', error);
    sendEvent({ type: 'error', message: 'Screening failed' });
    res.end();
  } finally {
    await closeBrowser();
  }
});

// ============================================================
// V4 API - BATCH ARCHITECTURE
// Gather all URLs → Categorize in one LLM call → Fetch flagged → Analyze
// ============================================================

app.get('/api/screen/v4', async (req: Request, res: Response) => {
  const subjectName = req.query.name as string;
  const variationsParam = req.query.variations as string;
  const languageParam = (req.query.language as string) || 'chinese';
  const languages = languageParam.split(',').map(l => l.trim()).filter(Boolean);
  // Backward compat: 'both' → ['chinese', 'english']
  if (languages.length === 1 && languages[0] === 'both') {
    languages.splice(0, 1, 'chinese', 'english');
  }
  const incomingSessionId = req.query.sessionId as string;
  const lastSeenBatch = parseInt(req.query.lastBatch as string) || 0;
  const lastSeenArticle = parseInt(req.query.lastArticle as string) || 0;
  const subjectContext = (req.query.context as string) || '';
  if (subjectContext) {
    console.log(`[V4] Entity context provided: "${subjectContext}"`);
  }

  // Benchmark funnel tracing
  const benchmarkCase = getBenchmarkCase(subjectName);
  const isBenchmarkRun = !!benchmarkCase;
  const funnelPhases: FunnelPhaseSnapshot[] = [];

  // Session-based reconnection (preferred) - restore state from Redis
  let existingSession: ScreeningSession | null = null;
  if (incomingSessionId) {
    existingSession = await getSession(incomingSessionId);
    if (existingSession) {
      console.log(`[V4] Resuming session ${incomingSessionId} from phase ${existingSession.currentPhase}, index ${existingSession.currentIndex}`);
    } else {
      console.log(`[V4] Session ${incomingSessionId} not found in Redis, starting fresh`);
    }
  }

  // Legacy fallback: Parse restored findings from URL (base64 encoded)
  let restoredFindings: RawFinding[] = existingSession?.findings || [];
  const findingsParam = req.query.findings as string;
  if (!existingSession && findingsParam) {
    try {
      const decoded = Buffer.from(findingsParam, 'base64').toString('utf-8');
      restoredFindings = JSON.parse(decoded);
      console.log(`[V4] Restored ${restoredFindings.length} findings from URL param (legacy)`);
    } catch (e) {
      console.error('[V4] Failed to parse restored findings:', e);
    }
  }

  // Legacy fallback: Parse restored search results from URL
  let restoredResults: BatchSearchResult[] = existingSession?.gatheredResults || [];
  const resultsParam = req.query.results as string;
  if (!existingSession && resultsParam) {
    try {
      const decoded = Buffer.from(resultsParam, 'base64').toString('utf-8');
      restoredResults = JSON.parse(decoded);
      console.log(`[V4] Restored ${restoredResults.length} search results from URL param (legacy)`);
    } catch (e) {
      console.error('[V4] Failed to parse restored results:', e);
    }
  }

  // Cancel any existing screening for this subject
  const screeningKey = subjectName.toLowerCase();
  if (activeScreenings.has(screeningKey)) {
    console.log(`[V4] Cancelling existing screening for: ${subjectName}`);
    activeScreenings.get(screeningKey)!.abort();
    activeScreenings.delete(screeningKey);
  }

  if (!subjectName || subjectName.trim().length < 2) {
    res.status(400).json({ error: 'Name required (2+ chars)' });
    return;
  }

  // SSE setup — IMMEDIATELY send headers so client gets heartbeats within 1s
  // This MUST be before any async work (getSession, getChineseVariantsLLM, etc.)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  // Disable per-request socket timeout for SSE (Cloud Run manages lifecycle)
  req.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  const eventLog: any[] = [];
  const sendEvent = (data: any) => {
    const event = { timestamp: new Date().toISOString(), ...data };
    eventLog.push(event);
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Connection closed (Cloud Run timeout, client disconnect) - silently ignore
      // Progress is saved to Redis independently, so lost SSE events are OK
    }
  };

  // Heartbeat (1s for robust connection stability)
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      // Force flush to bypass proxy buffering
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    } catch (err) {
      // Connection closed - stop heartbeat to prevent repeated errors
      clearInterval(heartbeat);
      return;
    }
    heartbeatCount++;
    if (heartbeatCount % 30 === 0) { // Log every 30 seconds
      console.log(`[V4] [HEARTBEAT] ${heartbeatCount} pings sent for ${subjectName}`);
    }
  }, 1000);

  // Abort controller for cancelling operations on client disconnect
  const abortController = new AbortController();
  const { signal } = abortController;

  // Register this screening (for deduplication)
  activeScreenings.set(screeningKey, abortController);

  // Handle client disconnect
  res.on('close', () => {
    console.log(`[V4] Client disconnected for: ${subjectName}`);
    abortController.abort();
    clearInterval(heartbeat);
  });

  // Parse name variations (comma-separated), always include main name
  const nameVariations = [subjectName];
  if (variationsParam) {
    variationsParam.split(',').forEach(v => {
      const trimmed = v.trim();
      if (trimmed && trimmed !== subjectName) nameVariations.push(trimmed);
    });
  }

  // For Chinese language: auto-generate Simplified/Traditional variants using DeepSeek LLM
  // Skip on reconnect — variants are already stored in the session
  // Only run LLM on Chinese names (not English name variations)
  if (!existingSession && languages.includes('chinese')) {
    const currentNames = [...nameVariations].filter(n => isChineseName(n));
    for (const name of currentNames) {
      const variants = await getChineseVariantsLLM(name);
      for (const variant of variants) {
        if (!nameVariations.includes(variant)) {
          nameVariations.push(variant);
        }
      }
    }
  }
  // On reconnect, use stored variations from session
  if (existingSession?.variations) {
    nameVariations.length = 0;
    nameVariations.push(...existingSession.variations);
  }

  // Build per-language template entries: each entry has template, names, and hl
  interface TemplateEntry {
    template: string;
    names: string[];
    hl: string;
  }

  const templateEntries: TemplateEntry[] = [];

  // Step 1: For each explicitly selected language, add templates with appropriate names
  for (const lang of languages) {
    const cfg = LANGUAGE_CONFIG[lang];
    if (!cfg) continue;

    if (lang === 'chinese') {
      // Chinese templates only for CJK names
      const cjkNames = nameVariations.filter(n => isChineseName(n));
      if (cjkNames.length > 0) {
        for (const t of [...cfg.templates, ...cfg.siteTemplates]) {
          templateEntries.push({ template: t, names: cjkNames, hl: cfg.hl });
        }
      }
    } else if (lang === 'english') {
      // English templates only for non-CJK names
      const nonCjkNames = nameVariations.filter(n => !isChineseName(n));
      if (nonCjkNames.length > 0) {
        for (const t of [...cfg.templates, ...cfg.siteTemplates]) {
          templateEntries.push({ template: t, names: nonCjkNames, hl: cfg.hl });
        }
      }
    } else {
      // Other languages: use templates for ALL name variations
      for (const t of [...cfg.templates, ...cfg.siteTemplates]) {
        templateEntries.push({ template: t, names: nameVariations, hl: cfg.hl });
      }
    }
  }

  // Step 2: Auto-detect scripts from name variations and add missing language templates
  const detectedLangs = new Set<string>();
  for (const name of nameVariations) {
    detectedLangs.add(detectScript(name));
  }
  for (const detected of detectedLangs) {
    if (languages.includes(detected)) continue; // Already explicitly selected
    if (detected === 'english') continue; // Handled in step 3
    const cfg = LANGUAGE_CONFIG[detected];
    if (!cfg) continue;
    // Only apply to names matching this script
    const matchingNames = nameVariations.filter(n => detectScript(n) === detected);
    if (matchingNames.length > 0) {
      for (const t of [...cfg.templates, ...cfg.siteTemplates]) {
        templateEntries.push({ template: t, names: matchingNames, hl: cfg.hl });
      }
    }
  }

  // Step 3: Auto-include English for Latin-script names if not explicitly selected
  if (!languages.includes('english')) {
    const latinNames = nameVariations.filter(n => detectScript(n) === 'english');
    if (latinNames.length > 0) {
      const engCfg = LANGUAGE_CONFIG['english'];
      for (const t of [...engCfg.templates, ...engCfg.siteTemplates]) {
        templateEntries.push({ template: t, names: latinNames, hl: 'en' });
      }
    }
  }

  // Derive selectedTemplates for progress tracking / session compat
  const selectedTemplates = templateEntries.map(e => e.template);

  try {
    const tracker = new MetricsTracker(subjectName);
    const startTime = Date.now();

    // Generate unique connection ID to prevent stale connections from updating session
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Session handling: reuse existing session on reconnect, or create new
    let sessionId: string;
    let skipGather = false;
    let skipElimination = false;
    let skipTitleDedupe = false;
    let skipCluster = false;
    let skipCategorize = false;
    let skipConsolidate = false;
    let skipSubsidiaryAndSupplementary = false;
    let analyzeStartIndex = 0;
    let gatherStartIndex = 0;  // For mid-gather resume
    let companyExpansionStartIndex = 0;  // For mid-company-expansion resume
    let restoredDetectedCompanies: DetectedCompany[] | null = null;  // For mid-company-expansion resume
    let clusterStartBatchIndex = 0;  // For mid-clustering resume
    let restoredClusterBatchResults: IncidentCluster[] | null = null;  // For mid-clustering resume
    let categorizeBatchStartIndex = 0;  // For mid-categorize resume
    let restoredCategorizePartialResults: { red: CategorizedResult[]; amber: CategorizedResult[]; green: CategorizedResult[] } | null = null;  // For mid-categorize resume
    let restoredCategorized: { red: CategorizedResult[]; amber: CategorizedResult[]; green: CategorizedResult[] } | null = null;
    let restoredPassed: BatchSearchResult[] | null = null;
    let restoredConsolidated: ConsolidatedFinding[] | null = null;
    let parkedArticles: BatchSearchResult[] = [];  // Track parked duplicates for consolidation
    let clusterStats = { totalClusters: 0, articlesToAnalyze: 0, articlesParked: 0 };  // For funnel summary
    let passedEliminationCount = 0;  // Snapshot before clustering overwrites `passed`

    if (existingSession && incomingSessionId) {
      // Reconnection: reuse existing session
      sessionId = incomingSessionId;

      // Take ownership of the session - this will prevent the old connection from updating it
      console.log(`[V4] Taking ownership: sessionId=${sessionId.slice(0,8)}, newConnId=${connectionId.slice(0,8)}`);
      const beforeOwnership = await getSession(sessionId);
      console.log(`[V4] Before ownership: index=${beforeOwnership?.currentIndex}, findings=${beforeOwnership?.findings?.length}, phase=${beforeOwnership?.currentPhase}`);
      await updateSession(sessionId, { connectionId });
      const afterOwnership = await getSession(sessionId);
      console.log(`[V4] After ownership: index=${afterOwnership?.currentIndex}, findings=${afterOwnership?.findings?.length}, phase=${afterOwnership?.currentPhase}`);
      console.log(`[V4] Took ownership of session with connectionId: ${connectionId}`);

      // CRITICAL: Re-fetch session after taking ownership to get the latest state.
      // The old connection may have updated the session (currentIndex, findings, phase, etc.)
      // between when we first read it and when we took ownership.
      // Without this re-fetch, we would use stale data for restoration.
      const freshSession = await getSession(sessionId);
      if (freshSession) {
        existingSession = freshSession;
        console.log(`[V4] Refreshed session: phase=${freshSession.currentPhase}, index=${freshSession.currentIndex}, findings=${freshSession.findings?.length || 0}`);
      }

      // Get phase from refreshed session (not stale data)
      const phase = existingSession.currentPhase;
      console.log(`[V4] Restoring from phase: ${phase}`);

      // Mid-gather resume: if we have partial gather progress, resume from there
      if (phase === 'gather' && existingSession.gatherIndex && existingSession.gatherIndex > 0) {
        gatherStartIndex = existingSession.gatherIndex;
        restoredResults = existingSession.gatheredResults || [];
        console.log(`[V4] Resuming gather from query ${gatherStartIndex + 1}, restored ${restoredResults.length} results`);
        sendEvent({
          type: 'phase_resumed',
          phase: 'gather',
          message: `Resuming gather from query ${gatherStartIndex + 1}`,
          resultsRestored: restoredResults.length
        });
      }

      // Mid-company-expansion resume: if we have partial company expansion progress
      if (phase === 'gather' && existingSession.companyExpansionIndex && existingSession.companyExpansionIndex > 0) {
        companyExpansionStartIndex = existingSession.companyExpansionIndex;
        restoredResults = existingSession.gatheredResults || [];
        restoredDetectedCompanies = existingSession.detectedCompanies || null;
        // Skip the gather phase since company expansion means gather is done
        skipGather = true;
        console.log(`[V4] Resuming company expansion from company ${companyExpansionStartIndex + 1}, restored ${restoredResults.length} results`);
        sendEvent({
          type: 'phase_resumed',
          phase: 'company_expansion',
          message: `Resuming company expansion from company ${companyExpansionStartIndex + 1}`,
          resultsRestored: restoredResults.length
        });
      }

      // Mid-clustering resume: if we have partial clustering progress
      if (phase === 'cluster' && existingSession.clusterBatchIndex && existingSession.clusterBatchIndex > 0) {
        clusterStartBatchIndex = existingSession.clusterBatchIndex;
        restoredClusterBatchResults = existingSession.clusterBatchResults || null;
        skipGather = true;
        skipElimination = true;
        restoredResults = existingSession.gatheredResults;
        restoredPassed = existingSession.passedElimination;
        console.log(`[V4] Resuming clustering from batch ${clusterStartBatchIndex + 1}, ${restoredClusterBatchResults?.length || 0} clusters so far`);
        console.log(`[V4] DEBUG: clusterStartBatchIndex set to ${clusterStartBatchIndex} from session.clusterBatchIndex=${existingSession.clusterBatchIndex}`);
        sendEvent({
          type: 'phase_resumed',
          phase: 'cluster',
          message: `Resuming clustering from batch ${clusterStartBatchIndex + 1}`,
          clustersRestored: restoredClusterBatchResults?.length || 0
        });
      }

      // Mid-categorize resume: if we have partial categorization progress
      if (phase === 'categorize' && existingSession.categorizeBatchIndex && existingSession.categorizeBatchIndex > 0) {
        categorizeBatchStartIndex = existingSession.categorizeBatchIndex;
        restoredCategorizePartialResults = existingSession.categorizePartialResults || null;
        skipGather = true;
        skipElimination = true;
        skipCluster = true;
        restoredResults = existingSession.gatheredResults;
        restoredPassed = existingSession.passedElimination;
        console.log(`[V4] Resuming categorize from batch ${categorizeBatchStartIndex + 1}, ${restoredCategorizePartialResults?.red.length || 0} red, ${restoredCategorizePartialResults?.amber.length || 0} amber, ${restoredCategorizePartialResults?.green.length || 0} green so far`);
        sendEvent({
          type: 'phase_resumed',
          phase: 'categorize',
          message: `Resuming categorize from batch ${categorizeBatchStartIndex + 1}`,
          partialResults: {
            red: restoredCategorizePartialResults?.red.length || 0,
            amber: restoredCategorizePartialResults?.amber.length || 0,
            green: restoredCategorizePartialResults?.green.length || 0
          }
        });
      }

      // Set skip flags based on current phase (NO phase_skipped events - just set flags)
      if (phase === 'eliminate' || phase === 'categorize' || phase === 'analyze' || phase === 'consolidate' || phase === 'complete') {
        skipGather = true;
        skipSubsidiaryAndSupplementary = true;
        restoredResults = existingSession.gatheredResults;
      }

      if (phase === 'cluster' || phase === 'categorize' || phase === 'analyze' || phase === 'consolidate' || phase === 'complete') {
        skipElimination = true;
        skipTitleDedupe = true;  // Skip title dedupe if past elimination phase
        skipSubsidiaryAndSupplementary = true;
        // Only skip cluster if we're past it (categorize or later), not if we're mid-cluster
        if (phase !== 'cluster') {
          skipCluster = true;
        }
        restoredPassed = existingSession.passedElimination;
      }

      // If phase is 'eliminate' but we already have passedElimination results,
      // skip elimination. Only skip title_dedupe if it's marked complete.
      if (phase === 'eliminate' && existingSession.passedElimination && existingSession.passedElimination.length > 0) {
        console.log(`[V4] Phase is 'eliminate' but passedElimination exists (${existingSession.passedElimination.length} results) - skipping elimination`);
        skipElimination = true;
        restoredPassed = existingSession.passedElimination;

        if (existingSession.titleDedupeComplete) {
          console.log(`[V4] titleDedupeComplete=true, skipping title_dedupe`);
          skipTitleDedupe = true;
        } else {
          console.log(`[V4] titleDedupeComplete=false, will run title_dedupe`);
        }
      }

      if (phase === 'analyze' || phase === 'consolidate' || phase === 'complete') {
        skipCategorize = true;
        restoredCategorized = existingSession.categorized;
        restoredFindings = existingSession.findings || [];
        // Safety: ensure currentIndex is a valid number, default to 0 if missing
        analyzeStartIndex = typeof existingSession.currentIndex === 'number' ? existingSession.currentIndex : 0;
        if (analyzeStartIndex === 0 && phase === 'analyze') {
          console.warn(`[V4] WARNING: currentIndex was ${existingSession.currentIndex} (type: ${typeof existingSession.currentIndex}), starting analysis from beginning`);
          console.warn(`[V4] Session keys: ${Object.keys(existingSession).join(', ')}`);
          console.warn(`[V4] Session findings: ${existingSession.findings?.length || 0}, phase: ${existingSession.currentPhase}`);
        } else {
          console.log(`[V4] Resuming analyze from index ${analyzeStartIndex}, ${restoredFindings.length} findings restored`);
        }
        sendEvent({ type: 'analyze_resume', fromIndex: analyzeStartIndex, totalFindings: restoredFindings.length });
      }

      // If we're in consolidate phase and already have results, skip consolidation
      if ((phase === 'consolidate' || phase === 'complete') && existingSession.consolidatedFindings) {
        skipConsolidate = true;
        restoredConsolidated = existingSession.consolidatedFindings;
        analyzeStartIndex = restoredCategorized ? (restoredCategorized.red.length + restoredCategorized.amber.length) : 0;
        console.log(`[V4] Restoring ${restoredConsolidated.length} consolidated findings from session`);
      }

      // If screening is already complete, skip everything and return cached results
      if (phase === 'complete') {
        console.log(`[V4] Screening already complete, returning cached results`);
      }
    } else {
      // New screening: create fresh session
      sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      await createSession(sessionId, {
        name: subjectName,
        variations: nameVariations,
        language: languageParam,
        gatheredResults: [],
        categorized: { red: [], amber: [], green: [] },
        passedElimination: [],
        currentPhase: 'gather',
        currentIndex: 0,
        findings: [],
        connectionId,  // Track which connection owns this session
      });
    }

    // Send session ID to client (for reconnection tracking)
    sendEvent({ type: 'session', sessionId });

    // If reconnecting, send status so user knows where we are
    if (existingSession && incomingSessionId) {
      const phase = existingSession.currentPhase;
      const phaseName = phase === 'gather' ? 'gathering' : phase === 'eliminate' ? 'filtering' : phase === 'cluster' ? 'clustering' : phase === 'categorize' ? 'categorizing' : phase === 'analyze' ? 'analyzing' : 'consolidating';
      const currentBatch = existingSession.categorizeBatchIndex || 0;
      const currentArticle = existingSession.currentIndex || 0;
      const totalArticles = existingSession.categorized ? (existingSession.categorized.red.length + existingSession.categorized.amber.length) : 0;
      const progress = phase === 'analyze' ? `${currentArticle}/${totalArticles}` : '';

      // Calculate what was missed while disconnected
      const missedBatches = currentBatch > lastSeenBatch ? `batches ${lastSeenBatch + 1}-${currentBatch}` : null;
      const missedArticles = currentArticle > lastSeenArticle ? `articles ${lastSeenArticle + 1}-${currentArticle}` : null;

      let missedMessage = '';
      if (missedBatches || missedArticles) {
        const missed = [missedBatches, missedArticles].filter(Boolean).join(', ');
        missedMessage = `While disconnected: completed ${missed}. `;
      }

      sendEvent({
        type: 'reconnect_status',
        phase,
        phaseName,
        progress,
        message: `${missedMessage}Connection restored. Resuming ${phaseName} phase${progress ? ` at ${progress}` : ''}...`,
        findingsCount: existingSession.findings.length,
        // Include missed progress details for client to display
        missedBatches: currentBatch > lastSeenBatch ? { from: lastSeenBatch + 1, to: currentBatch } : null,
        missedArticles: currentArticle > lastSeenArticle ? { from: lastSeenArticle + 1, to: currentArticle } : null,
      });
    }

    // URL tracking for analysis - includes search query for each URL
    const urlTracker = {
      gathered: [] as { url: string; title: string; snippet: string; query: string }[],
      programmaticElimination: {
        passed: [] as { url: string; title: string; query: string }[],
        bypassed: [] as { url: string; title: string; query: string }[],  // .gov.cn domains
        eliminated: {
          noise_domain: [] as { url: string; title: string; query: string }[],
          noise_title_pattern: [] as { url: string; title: string; query: string }[],
          name_char_separation: [] as { url: string; title: string; query: string }[],
          missing_dirty_word: [] as { url: string; title: string; query: string }[],
        },
      },
      categorized: {
        red: [] as { url: string; title: string; query: string; reason: string }[],
        amber: [] as { url: string; title: string; query: string; reason: string }[],
        green: [] as { url: string; title: string; query: string; reason: string }[],
      },
      eliminated: [] as { url: string; query: string; reason: string }[],
      processed: [] as { url: string; title: string; query: string; result: 'ADVERSE' | 'CLEARED' | 'FAILED' | 'FURTHER'; severity?: string; headline?: string }[],
    };

    // ========================================
    // PHASE 1: GATHER ALL URLs
    // ========================================
    // Initialize with restored results if mid-gather resume, otherwise empty
    let allResults: BatchSearchResult[] = gatherStartIndex > 0 ? [...restoredResults] : [];

    if (skipGather) {
      // Skip gather phase - use restored results from session
      // CRITICAL: We must skip even if restoredResults is empty, otherwise we'd restart
      // gather and OVERWRITE currentPhase back to 'gather', destroying session state
      allResults = restoredResults || [];
      console.log(`[V4] Skipped gather phase, using ${allResults.length} restored results`);
    } else {
      const totalSearches = selectedTemplates.length - gatherStartIndex;
      const cjkNames = nameVariations.filter(n => isChineseName(n));
      const nonCjkNames = nameVariations.filter(n => !isChineseName(n));
      const nameDisplay: string[] = [];
      if (cjkNames.length > 0) nameDisplay.push(`${cjkNames.length} Chinese (${cjkNames.join(', ')})`);
      if (nonCjkNames.length > 0) nameDisplay.push(`${nonCjkNames.length} English (${nonCjkNames.join(', ')})`);
      const nameVariantsDisplay = nameDisplay.length > 0 ? nameDisplay.join(' + ') : nameVariations[0];
      const resumeInfo = gatherStartIndex > 0 ? ` (resuming from query ${gatherStartIndex + 1})` : '';
      sendEvent({
        type: 'phase',
        phase: 1,
        name: 'GATHER',
        message: `Gathering results for ${nameVariantsDisplay}, ${selectedTemplates.length} templates${resumeInfo}...`
      });

      // Search with all name variants combined using OR in each query
      let searchesDone = gatherStartIndex;

      // Start from gatherStartIndex to skip already-completed queries on mid-gather resume
      for (let i = gatherStartIndex; i < selectedTemplates.length; i++) {

      // Check if user paused the session
      if (await isSessionPaused(sessionId)) {
        // Save current position before exiting so resume starts here
        await updateSession(sessionId, { gatheredResults: allResults, gatherIndex: i }, connectionId);
        console.log(`[V4] Session ${sessionId} paused at gather query ${i + 1}/${selectedTemplates.length}, saved gatherIndex=${i}`);
        sendEvent({ type: 'paused', phase: 'gather', queryIndex: i + 1 });
        clearInterval(heartbeat);
        activeScreenings.delete(screeningKey);
        return;
      }

      const entry = templateEntries[i];
      const template = entry.template;
      const entryNames = entry.names;

      // Build query with per-template name variants using OR
      let query: string;
      if (entryNames.length === 1) {
        query = template.replace('{NAME}', entryNames[0]);
      } else {
        const orClause = '(' + entryNames.map(n => `"${n}"`).join(' OR ') + ')';
        query = template.replace('"{NAME}"', orClause);
      }

      // Search Google (Serper) - up to 20 pages
      const MAX_PAGES = 20;
      const googleResults: SearchResult[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        // Check if aborted
        if (signal.aborted) {
          console.log(`[V4] Search aborted for: ${subjectName}`);
          activeScreenings.delete(screeningKey);
          return;
        }

        const pageResults = await searchGoogle(query, page, 10, signal, entry.hl);

        sendEvent({
          type: 'search_page',
          engine: 'google',
          queryIndex: i + 1,
          totalQueries: selectedTemplates.length,
          page,
          pageResults: pageResults.length,
        });

        if (pageResults.length === 0) break;
        googleResults.push(...pageResults);
        if (pageResults.length < 10) break;
        await new Promise(r => setTimeout(r, 200));
      }

      for (const r of googleResults) {
        allResults.push({
          url: r.link,
          title: r.title,
          snippet: r.snippet,
          query: template,
        });
      }

      searchesDone++;
      sendEvent({
        type: 'search_progress',
        queryIndex: i + 1,
        totalQueries: selectedTemplates.length,
        query,
        resultsFound: googleResults.length,
        totalSoFar: allResults.length,
      });
      tracker.recordQuery(googleResults.length);

      // Save progress after EACH query completes (for mid-gather resume)
      await updateSession(sessionId, {
        gatheredResults: allResults,
        gatherIndex: i + 1,  // 1-indexed: completed queries
        currentPhase: 'gather'
      }, connectionId);

      await new Promise(r => setTimeout(r, 500));
    }

    // If all queries were skipped (reconnection) and we have restored results, use them
    if (allResults.length === 0 && restoredResults.length > 0) {
      console.log(`[V4] Using ${restoredResults.length} restored results from reconnection`);
      allResults.push(...restoredResults);
    }

    // Track all gathered URLs with full details AND send per-result events for auditing
    for (let i = 0; i < allResults.length; i++) {
      const r = allResults[i];
      urlTracker.gathered.push({ url: r.url, title: r.title, snippet: r.snippet, query: r.query });

      // Find which template this result came from
      const templateIndex = selectedTemplates.findIndex(t => r.query === t || r.query.includes(t.replace('{NAME}', '')));
      const category = TEMPLATE_CATEGORIES[templateIndex] || `Query ${templateIndex + 1}`;

      // Send per-result event for detailed audit logging
      sendEvent({
        type: 'search_result',
        index: i + 1,
        total: allResults.length,
        category,
        url: r.url,
        title: r.title,
        snippet: (r.snippet || '').substring(0, 200),
      });
    }

      sendEvent({
        type: 'gather_complete',
        totalResults: allResults.length,
        duration: Date.now() - startTime,
        results: allResults, // Include results for reconnection persistence
      });

      // Update session with gathered results (Redis) - clear gatherIndex to indicate gather is fully complete
      await updateSession(sessionId, { gatheredResults: allResults, currentPhase: 'eliminate', gatherIndex: undefined }, connectionId);
    } // End of gather phase else block

    // ========================================
    // PHASE 1.5: COMPANY EXPANSION
    // Detect associated companies from SFC/registry pages and search for their adverse media
    // ========================================
    // Run company expansion if: (1) fresh gather completed, OR (2) resuming mid-company-expansion
    const shouldRunCompanyExpansion = (!skipGather && allResults.length > 0) || companyExpansionStartIndex > 0;

    if (shouldRunCompanyExpansion) {
      // Use restored companies if resuming mid-company-expansion, otherwise extract from results + profile seed
      let detectedCompanies: DetectedCompany[];
      if (restoredDetectedCompanies) {
        detectedCompanies = restoredDetectedCompanies;
      } else {
        const registryCompanies = extractCompaniesFromResults(allResults);
        detectedCompanies = deduplicateCompanies(registryCompanies);
      }

      if (detectedCompanies.length > 0) {
        const resumeInfo = companyExpansionStartIndex > 0 ? ` (resuming from company ${companyExpansionStartIndex + 1})` : '';
        sendEvent({
          type: 'phase',
          phase: '1.5',
          name: 'COMPANY_EXPANSION',
          message: `Detected ${detectedCompanies.length} associated companies from registry pages${resumeInfo}`
        });

        console.log(`[V4] [COMPANY_EXPANSION] Detected companies:`, detectedCompanies.map(c => c.chinese || c.english));

        // Start from companyExpansionStartIndex to skip already-completed companies on resume
        for (let compIdx = companyExpansionStartIndex; compIdx < detectedCompanies.length; compIdx++) {
          // Check if user paused the session
          if (await isSessionPaused(sessionId)) {
            // Save current position before exiting so resume starts here
            await updateSession(sessionId, {
              gatheredResults: allResults,
              companyExpansionIndex: compIdx,
              detectedCompanies
            }, connectionId);
            console.log(`[V4] Session ${sessionId} paused at company expansion ${compIdx + 1}/${detectedCompanies.length}, saved companyExpansionIndex=${compIdx}`);
            sendEvent({ type: 'paused', phase: 'company_expansion', companyIndex: compIdx + 1 });
            clearInterval(heartbeat);
            activeScreenings.delete(screeningKey);
            return;
          }

          const company = detectedCompanies[compIdx];
          if (signal.aborted) break;

          const companyName = company.chinese || company.english;
          sendEvent({
            type: 'progress',
            message: `Searching adverse media for ${companyName} (${compIdx + 1}/${detectedCompanies.length})...`
          });

          const companyResults = await searchCompanyAdverseMedia(company, signal);

          if (companyResults.length > 0) {
            sendEvent({
              type: 'progress',
              message: `Found ${companyResults.length} results for ${companyName}`
            });

            // Tag results as company-sourced and add to allResults
            for (const r of companyResults) {
              (r as any).sourceCompany = companyName;
              // Only add if URL not already in results
              if (!allResults.find(existing => existing.url === r.url)) {
                allResults.push(r);
              }
            }
          } else {
            sendEvent({
              type: 'progress',
              message: `No adverse media found for ${companyName}`
            });
          }

          // Save progress after EACH company (for mid-company-expansion resume)
          await updateSession(sessionId, {
            gatheredResults: allResults,
            detectedCompanies,
            companyExpansionIndex: compIdx + 1,  // 1-indexed: completed companies
            currentPhase: 'gather'  // Still in gather phase during company expansion
          }, connectionId);
        }

        sendEvent({
          type: 'phase_complete',
          phase: '1.5',
          count: allResults.length,
          companies: detectedCompanies.map(c => ({ english: c.english, chinese: c.chinese })),
          message: `Company expansion complete. Total results: ${allResults.length}`
        });

        // Update session with expanded results - clear companyExpansionIndex to indicate expansion is complete
        await updateSession(sessionId, { gatheredResults: allResults, detectedCompanies, companyExpansionIndex: undefined }, connectionId);
      }
    }

    if (allResults.length === 0) {
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      sendEvent({ type: 'complete', stats: { totalResults: 0, findings: 0 }, findings: [] });
      res.end();
      return;
    }

    // ========================================
    // PHASE 0.9: BIOGRAPHICAL SEARCH (clean name query for entity resolution)
    // ========================================
    let bioResults: { title: string; snippet: string }[] = [];
    if (!existingSession?.profile) {
      try {
        const bioHl = isChineseName(subjectName) ? 'zh-cn' : 'en';
        const bioSearchResults = await searchGoogle(`"${subjectName}"`, 1, 10, undefined, bioHl);
        bioResults = bioSearchResults.map(r => ({ title: r.title, snippet: r.snippet }));
        console.log(`[V4] Bio search: ${bioResults.length} results for "${subjectName}"`);
      } catch (err: any) {
        console.error(`[V4] Bio search failed (non-fatal): ${err?.message}`);
      }
    }

    // ========================================
    // PHASE 1.9: PROFILE SEED (from search snippets)
    // ========================================
    let subjectProfile: SubjectProfile = {
      primaryName: subjectName,
      nameVariants: [...nameVariations],
      gender: 'unknown',
      nationality: [],
      ageRange: '',
      currentRole: null,
      pastRoles: [],
      industry: [],
      licenses: [],
      associatedCompanies: [],
      associatedPeople: [],
      confidence: 'low',
      sources: [],
      lastUpdated: Date.now(),
    };

    // On reconnect, restore profile from session
    if (existingSession?.profile) {
      subjectProfile = existingSession.profile;
      console.log(`[V4] Restored profile from session, confidence: ${subjectProfile.confidence}`);
      sendEvent({ type: 'profile_seed', profile: subjectProfile });
    } else {
      // Build preliminary profile from search snippets (1 LLM call)
      try {
        const profileInputResults = [
          ...bioResults,
          ...allResults.slice(0, 100 - bioResults.length),
        ].slice(0, 100);

        const snippetSummary = profileInputResults.map((r, i) =>
          `[${i + 1}] ${r.title} — ${r.snippet || ''}`
        ).join('\n');

        const isCompanyProfile = isCompanyScreening(subjectName);
        const profilePrompt = isCompanyProfile
          ? `You are a due diligence analyst. Given these search results about company "${subjectName}", extract a company profile.

SEARCH RESULTS:
${snippetSummary}

For well-known public companies, you may use your general knowledge to fill industry and nationality even if not explicitly stated in the search results.

OUTPUT FORMAT (JSON only):
{
  "nationality": ["China"],
  "operatingRegions": ["China", "India", "EU"],
  "industry": ["technology", "consumer electronics", "electric vehicles"],
  "currentRole": null,
  "pastRoles": [],
  "associatedCompanies": [{"name": "Xiaomi India", "relationship": "subsidiary"}],
  "associatedPeople": [{"name": "Lei Jun", "relationship": "CEO"}]
}

For nationality, provide the headquarters jurisdiction. For industry, list all relevant sectors.`
          : `You are a due diligence analyst. Given these search results about "${subjectName}", extract a preliminary subject profile.
${subjectContext ? `
VERIFIED CONTEXT (from the requesting analyst — treat as ground truth):
${subjectContext}

Use this context to identify the correct individual in the search results. Prioritize results that match this context.
` : ''}
SEARCH RESULTS:
${snippetSummary}

Extract ONLY facts that appear in multiple results or are stated clearly. Mark uncertain facts.

OUTPUT FORMAT (JSON only):
{
  "gender": "male" | "female" | "unknown",
  "nationality": ["Hong Kong", ...] or [],
  "ageRange": "40s" or "born 1982" or "",
  "currentRole": { "title": "CFO", "company": "XYZ Corp", "since": "2020" } or null,
  "pastRoles": [{ "title": "Director", "company": "ABC Ltd", "period": "2015-2019" }],
  "industry": ["finance", "real estate"] or [],
  "licenses": ["SFC Type 9"] or [],
  "associatedCompanies": [{ "name": "XYZ Corp", "relationship": "director" }],
  "associatedPeople": [{ "name": "John Smith", "relationship": "business partner" }]
}

If you cannot determine a field with reasonable confidence, use the default empty value. Do NOT guess.`;

        const dsKey = process.env.DEEPSEEK_API_KEY || '';
        if (dsKey) {
          const profileResponse = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
              model: 'deepseek-chat',
              messages: [{ role: 'user', content: profilePrompt }],
              temperature: 0.1,
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${dsKey}`,
              },
              timeout: 15000,
            }
          );

          const profileText = profileResponse.data.choices?.[0]?.message?.content || '';
          const cleanText = profileText.replace(/```json\s*/gi, '').replace(/```/g, '');
          const jsonMatch = cleanText.match(/\{[\s\S]*\}/);

          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            subjectProfile.gender = parsed.gender || 'unknown';
            subjectProfile.nationality = parsed.nationality || [];
            subjectProfile.ageRange = parsed.ageRange || '';
            subjectProfile.currentRole = parsed.currentRole || null;
            subjectProfile.pastRoles = parsed.pastRoles || [];
            subjectProfile.industry = parsed.industry || [];
            subjectProfile.licenses = parsed.licenses || [];
            subjectProfile.associatedCompanies = parsed.associatedCompanies || [];
            subjectProfile.associatedPeople = parsed.associatedPeople || [];
            subjectProfile.lastUpdated = Date.now();

            // Compute confidence from how many fields the LLM actually populated
            let filledFields = 0;
            if (subjectProfile.gender && subjectProfile.gender !== 'unknown') filledFields++;
            if (subjectProfile.nationality.length > 0) filledFields++;
            if (subjectProfile.ageRange) filledFields++;
            if (subjectProfile.currentRole) filledFields++;
            if (subjectProfile.pastRoles.length > 0) filledFields++;
            if (subjectProfile.industry.length > 0) filledFields++;
            if (subjectProfile.associatedCompanies.length > 0) filledFields++;
            if (subjectProfile.associatedPeople.length > 0) filledFields++;
            if (filledFields >= 5) subjectProfile.confidence = 'high';
            else if (filledFields >= 3) subjectProfile.confidence = 'medium';
            // else stays 'low'

            console.log(`[V4] Profile seed extracted: gender=${subjectProfile.gender}, role=${subjectProfile.currentRole?.title}, companies=${subjectProfile.associatedCompanies.length}, confidence=${subjectProfile.confidence} (${filledFields}/8 fields)`);
          }
        } else {
          console.log(`[V4] No DeepSeek API key - skipping profile seed`);
        }
      } catch (err: any) {
        console.error(`[V4] Profile seed extraction failed (non-fatal): ${err?.message}`);
        // Profile stays at defaults — will be enriched during analyze
      }

      // Save profile to session and send to client
      await updateSession(sessionId, { profile: subjectProfile }, connectionId);
      sendEvent({ type: 'profile_seed', profile: subjectProfile });
    }

    // ========================================
    // PHASE 1.95: SUBSIDIARY EXTRACTION & SUPPLEMENTARY SEARCH
    // Extracts subsidiaries (LLM), then runs profile-guided supplementary searches
    // with core subsidiary names included in OR clauses (language-separated)
    // ========================================
    let extractedSubsidiaries: { name: string; chinese?: string; relationship: string; significance?: string }[] = [];

    const DEEPSEEK_KEY_SUB = process.env.DEEPSEEK_API_KEY || '';
    if (isCompanyScreening(subjectName) && DEEPSEEK_KEY_SUB && !skipSubsidiaryAndSupplementary) {
      try {
        console.log(`[V4] [SUBSIDIARY] Running subsidiary extraction for company: ${subjectName}`);
        sendEvent({ type: 'phase', phase: '1.95', name: 'SUBSIDIARY_EXTRACTION', message: `Extracting known subsidiaries for ${subjectName}...` });

        const subsidiaryPrompt = `List all known subsidiaries, regional entities, and affiliated companies of "${subjectName}".
Include:
- Regional subsidiaries (e.g., "Company India", "Company Taiwan", "Company Technology India Pvt Ltd")
- Payment/fintech subsidiaries
- Recently acquired companies
- Entities with different names that are known subsidiaries
- Short-form trading names commonly used

Return JSON array: [{"name": "...", "chinese": "...", "relationship": "subsidiary|affiliate|regional_entity", "significance": "core|minor"}]

Mark as "core" subsidiaries that are major operating entities (regional HQs, primary business units, entities with independent regulatory exposure). Mark as "minor" smaller or dormant entities.
Only include entities you are confident about. Do NOT guess. Return [] if unsure.`;

        const subResp = await axios.post(
          'https://api.deepseek.com/v1/chat/completions',
          {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: subsidiaryPrompt }],
            temperature: 0.1,
          },
          {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY_SUB}` },
            timeout: 30000,
          }
        );

        const subRaw = subResp.data.choices?.[0]?.message?.content || '';
        const subText = subRaw.replace(/```json\s*/gi, '').replace(/```/g, '');
        const subMatch = subText.match(/\[[\s\S]*\]/);
        if (subMatch) {
          extractedSubsidiaries = JSON.parse(subMatch[0]) as { name: string; chinese?: string; relationship: string; significance?: string }[];
          if (extractedSubsidiaries.length > 0) {
            console.log(`[V4] [SUBSIDIARY] Found ${extractedSubsidiaries.length} subsidiaries:`, extractedSubsidiaries.map(s => s.name));

            // Add to profile's associatedCompanies
            for (const sub of extractedSubsidiaries) {
              if (!subjectProfile.associatedCompanies.some(c => c.name === sub.name)) {
                subjectProfile.associatedCompanies.push({ name: sub.name, relationship: sub.relationship || 'subsidiary' });
              }
            }

            await updateSession(sessionId, { profile: subjectProfile }, connectionId);
            sendEvent({ type: 'subsidiary_extraction', count: extractedSubsidiaries.length, subsidiaries: extractedSubsidiaries.map(s => s.name) });
          }
        }
      } catch (err: any) {
        console.error(`[V4] [SUBSIDIARY] Extraction failed (non-fatal): ${err?.message}`);
      }
    }

    // Supplementary profile-guided search (still within Phase 1.95)
    const isCompany = isCompanyScreening(subjectName);
    const geoHints = inferGeographyFromName(subjectName);
    const supplementary = selectSupplementaryTemplates(
      { industry: subjectProfile.industry, nationality: subjectProfile.nationality },
      isCompany,
      geoHints
    );

    if (supplementary.length > 0 && !skipSubsidiaryAndSupplementary) {
      console.log(`[V4] [SUPPLEMENTARY] Selected ${supplementary.length} supplementary templates: ${supplementary.map(t => t.id).join(', ')}`);
      sendEvent({ type: 'phase', phase: '1.95', name: 'SUPPLEMENTARY_SEARCH', message: `Running ${supplementary.length} profile-guided supplementary searches...`, total: supplementary.length });

      // Build augmented name lists with core subsidiary names (language-separated)
      const coreSubsidiaries = extractedSubsidiaries.filter(s => s.significance === 'core');
      const suppCjkNames = [...nameVariations.filter(n => isChineseName(n))];
      const suppNonCjkNames = [...nameVariations.filter(n => !isChineseName(n))];

      for (const sub of coreSubsidiaries) {
        if (sub.chinese && isChineseName(sub.chinese) && !suppCjkNames.includes(sub.chinese)) {
          suppCjkNames.push(sub.chinese);
        }
        if (sub.name && !isChineseName(sub.name) && !suppNonCjkNames.includes(sub.name)) {
          suppNonCjkNames.push(sub.name);
        }
      }

      if (coreSubsidiaries.length > 0) {
        console.log(`[V4] [SUPPLEMENTARY] Augmented with ${coreSubsidiaries.length} core subsidiaries. CJK names: ${suppCjkNames.length}, Non-CJK names: ${suppNonCjkNames.length}`);
      }

      const SUPP_MAX_PAGES = 10;  // Supplementary = 10 pages
      let suppResultCount = 0;

      for (let tIdx = 0; tIdx < supplementary.length; tIdx++) {
        if (signal.aborted) break;
        const tmpl = supplementary[tIdx];

        // Select appropriate name variants based on template language
        const relevantNames = tmpl.language === 'zh' ? suppCjkNames : suppNonCjkNames;
        if (relevantNames.length === 0) continue;

        const query = buildSearchQueryWithVariants(tmpl.template, relevantNames);

        sendEvent({ type: 'progress', message: `Supplementary search ${tIdx + 1}/${supplementary.length}: ${tmpl.category}` });

        for (let page = 1; page <= SUPP_MAX_PAGES; page++) {
          if (signal.aborted) break;
          try {
            const pageResults = await searchGoogle(query, page, 10, signal, tmpl.hl);
            sendEvent({
              type: 'search_page',
              engine: 'google',
              queryIndex: tIdx + 1,
              totalQueries: supplementary.length,
              page,
              pageResults: pageResults.length,
              supplementary: true,
              templateId: tmpl.id,
            });
            if (pageResults.length === 0) break;
            for (const r of pageResults) {
              if (!allResults.find(existing => existing.url === r.link)) {
                allResults.push({
                  url: r.link,
                  title: r.title,
                  snippet: r.snippet || '',
                  query: `[SUPP:${tmpl.id}] ${tmpl.template}`
                });
                suppResultCount++;
              }
            }
            if (pageResults.length < 10) break;
            await new Promise(r => setTimeout(r, 200));
          } catch (err) {
            console.error(`[V4] [SUPPLEMENTARY] Search failed for ${tmpl.id} page ${page}:`, err);
            break;
          }
        }

        const templateResults = allResults.filter(r => r.query === `[SUPP:${tmpl.id}] ${tmpl.template}`).length;
        sendEvent({
          type: 'search_progress',
          queryIndex: tIdx + 1,
          totalQueries: supplementary.length,
          query: `[SUPP] ${tmpl.category}`,
          resultsFound: templateResults,
          totalSoFar: allResults.length,
          supplementary: true,
        });
        console.log(`[V4] [SUPPLEMENTARY] ${tmpl.id} (${tIdx + 1}/${supplementary.length}): ${templateResults} new results`);
      }

      if (suppResultCount > 0) {
        console.log(`[V4] [SUPPLEMENTARY] Added ${suppResultCount} new results. Total: ${allResults.length}`);
        await updateSession(sessionId, { gatheredResults: allResults }, connectionId);
      }

      sendEvent({
        type: 'phase_complete',
        phase: '1.95',
        count: suppResultCount,
        templates: supplementary.length,
        message: `Supplementary search complete. ${suppResultCount} new results from ${supplementary.length} templates.`
      });
    }

    // ========================================
    // PHASE 2: PROGRAMMATIC ELIMINATION (FREE)
    // ========================================
    let passed: BatchSearchResult[];
    let progEliminated: EliminatedResult[] = [];
    let bypassed: EliminatedResult[] = [];
    let breakdown: EliminationBreakdown;

    if (skipElimination && restoredPassed) {
      // Skip elimination phase - use restored results from session
      passed = restoredPassed;
      breakdown = { gov_domain_bypass: 0, noise_domain: 0, trash_domain: 0, noise_title_pattern: 0, name_char_separation: 0, missing_dirty_word: 0, part_of_longer_name: 0 };
      console.log(`[V4] Skipped elimination phase, using ${passed.length} restored passed results`);
    } else {
      sendEvent({ type: 'phase', phase: 2, name: 'PROGRAMMATIC_ELIMINATION', message: `Running programmatic filters on ${allResults.length} results...` });

      const elimStart = Date.now();
      const elimResult = eliminateObviousNoise(allResults, subjectName);
      passed = elimResult.passed;
      progEliminated = elimResult.eliminated;
      bypassed = elimResult.bypassed;
      breakdown = getEliminationBreakdown(progEliminated, bypassed);

    if (isBenchmarkRun) {
      funnelPhases.push({
        phase: 'elimination',
        articles: [
          ...passed.map(a => ({ url: a.url, title: a.title, snippet: a.snippet })),
          ...progEliminated.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, eliminationRule: a.reason })),
        ],
      });
    }

    // Track programmatic elimination results AND send per-item events for auditing
    const ruleNames: Record<string, string> = {
      'noise_domain': 'Rule 1: Noise domain (job site/aggregator)',
      'trash_domain': 'Rule 1b: Trash domain (SEO spam/broken site)',
      'noise_title_pattern': 'Rule 2: Job posting keyword in title',
      'name_char_separation': 'Rule 3: Name characters separated',
      'missing_dirty_word': 'Rule 4: Missing dirty word',
      'part_of_longer_name': 'Rule 5: Part of longer name (different person)',
      'gov_domain_bypass': 'Bypass: Government domain (.gov.cn)',
    };

    let elimIndex = 0;
    const totalItems = passed.length + bypassed.length + progEliminated.length;

    for (const r of passed) {
      urlTracker.programmaticElimination.passed.push({ url: r.url, title: r.title, query: r.query });
      elimIndex++;
      sendEvent({
        type: 'elimination_item',
        index: elimIndex,
        total: totalItems,
        status: 'PASSED',
        url: r.url,
        title: r.title,
        rule: null,
      });
    }
    for (const r of bypassed) {
      urlTracker.programmaticElimination.bypassed.push({ url: r.url, title: r.title, query: r.query });
      elimIndex++;
      sendEvent({
        type: 'elimination_item',
        index: elimIndex,
        total: totalItems,
        status: 'BYPASSED',
        url: r.url,
        title: r.title,
        rule: ruleNames[r.reason] || r.reason,
      });
    }
    // Adverse keywords for spotlight checks
    const ADVERSE_KEYWORDS = ['罚款', '处罚', '诈骗', '逮捕', '判刑', '洗钱', '制裁', '黑名单',
      'penalty', 'fraud', 'arrested', 'convicted', 'sanctions', 'blacklist', 'investigation',
      '贿赂', '腐败', '非法', '拘留'];

    for (const r of progEliminated) {
      const bucket = urlTracker.programmaticElimination.eliminated[r.reason as keyof typeof urlTracker.programmaticElimination.eliminated];
      if (bucket) {
        bucket.push({ url: r.url, title: r.title, query: r.query });
      }
      elimIndex++;
      sendEvent({
        type: 'elimination_item',
        index: elimIndex,
        total: totalItems,
        status: 'ELIMINATED',
        url: r.url,
        title: r.title,
        rule: ruleNames[r.reason] || r.reason,
      });

      // Spotlight: eliminated article contains adverse keywords — possible false positive
      const textToCheck = (r.title + ' ' + (r.snippet || '')).toLowerCase();
      const matched = ADVERSE_KEYWORDS.filter(kw => textToCheck.includes(kw.toLowerCase()));
      if (matched.length > 0) {
        console.log(`[SPOTLIGHT] Eliminated article HAS adverse keywords: "${r.title.slice(0, 60)}" (rule: ${ruleNames[r.reason] || r.reason}, keywords: ${matched.join(',')})`);
      }
    }

      sendEvent({
        type: 'programmatic_elimination_complete',
        before: allResults.length,
        after: passed.length,
        eliminated: progEliminated.length,
        govBypassed: bypassed.length,
        breakdown,
        duration: Date.now() - elimStart,
      });
    } // End of elimination phase else block
    passedEliminationCount = passed.length;  // Snapshot before clustering/dedupe overwrite

    if (passed.length === 0) {
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      sendEvent({ type: 'complete', stats: { totalResults: allResults.length, programmaticEliminated: progEliminated.length, findings: 0 }, findings: [] });
      res.end();
      return;
    }

    // ========================================
    // PHASE 2.1: LLM TITLE DEDUPLICATION
    // Batch dedupe before clustering to save LLM costs
    // ========================================
    let titleDedupeDuplicates: typeof passed = [];

    // Check if user paused before title dedupe
    if (await isSessionPaused(sessionId)) {
      console.log(`[V4] Session ${sessionId} paused before title dedupe phase`);
      sendEvent({ type: 'paused', phase: 'title_dedupe' });
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      return;
    }

    // Skip title dedupe if resuming from a later phase
    if (skipTitleDedupe) {
      // Silently skip - no need to log phase_skipped to client
      console.log(`[V4] Skipped title dedupe phase, resuming from later phase`);
    } else if (passed.length >= 50) {
      // Only run if we have enough articles (worth the LLM cost)
      sendEvent({
        type: 'phase',
        phase: '2.1',
        name: 'TITLE_DEDUPE',
        message: `Batch deduplicating ${passed.length} titles...`
      });

      const titleDedupeStart = Date.now();
      const dedupeResult = await llmBatchTitleDedupe(passed, async (progress: TitleDedupeProgress) => {
        sendEvent({
          type: 'title_dedupe_progress',
          batchNumber: progress.batchNumber,
          totalBatches: progress.totalBatches,
          processedSoFar: progress.processedSoFar,
          totalItems: progress.totalItems,
          duplicatesFound: progress.duplicatesFound,
        });
        // Save progress for mid-title_dedupe resume
        await updateSession(sessionId, {
          titleDedupeBatchIndex: progress.batchNumber
        }, connectionId);
      });

      titleDedupeDuplicates = dedupeResult.duplicates;
      passed = dedupeResult.unique;

      // Mark title dedupe as complete
      await updateSession(sessionId, {
        titleDedupeComplete: true,
        passedElimination: passed
      }, connectionId);

      sendEvent({
        type: 'title_dedupe_complete',
        before: dedupeResult.unique.length + dedupeResult.duplicates.length,
        after: dedupeResult.unique.length,
        duplicatesRemoved: dedupeResult.duplicates.length,
        groupsFound: dedupeResult.groups.length,
        duration: Date.now() - titleDedupeStart,
      });

      console.log(`[V4] Title dedupe complete: ${dedupeResult.unique.length} unique, ${dedupeResult.duplicates.length} duplicates removed`);
    } else {
      // Not enough articles for LLM dedupe - skip silently (server log only)
      console.log(`[V4] Only ${passed.length} articles, skipping LLM title dedupe`);
    }

    // Update session with elimination + dedupe results (Redis)
    // Only update phase if not skipping (don't overwrite 'analyze' with 'cluster' on resume)
    if (!skipTitleDedupe) {
      await updateSession(sessionId, { passedElimination: passed, currentPhase: 'cluster' }, connectionId);
    }

    if (passed.length === 0) {
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      sendEvent({ type: 'complete', stats: { totalResults: allResults.length, programmaticEliminated: progEliminated.length, titleDedupeDuplicates: titleDedupeDuplicates.length, findings: 0 }, findings: [] });
      res.end();
      return;
    }

    // ========================================
    // PHASE 2.5: INCIDENT CLUSTERING (LLM batch)
    // ========================================
    // Check if user paused before starting clustering
    if (await isSessionPaused(sessionId)) {
      console.log(`[V4] Session ${sessionId} paused before clustering phase`);
      sendEvent({ type: 'paused', phase: 'cluster' });
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      return;
    }

    if (skipCluster && restoredPassed) {
      // Skip clustering - already done in previous session (no phase_skipped event - cleaner logs)
      passed = restoredPassed;
      console.log(`[V4] Skipped clustering phase, using restored passed results (${passed.length} articles)`);
    } else {
      // Calculate remaining batches for resume message
      const CLUSTER_BATCH_SIZE = 40;
      const totalClusterBatches = Math.ceil(passed.length / CLUSTER_BATCH_SIZE);
      const remainingClusterBatches = totalClusterBatches - clusterStartBatchIndex;

      if (clusterStartBatchIndex > 0) {
        console.log(`[V4] Resuming clustering from batch ${clusterStartBatchIndex + 1}/${totalClusterBatches}, ${remainingClusterBatches} batches remaining`);
        sendEvent({
          type: 'phase',
          phase: '2.5',
          name: 'INCIDENT_CLUSTERING',
          message: `Resuming clustering from batch ${clusterStartBatchIndex + 1}: ${remainingClusterBatches} batches remaining...`
        });
      } else {
        sendEvent({
          type: 'phase',
          phase: '2.5',
          name: 'INCIDENT_CLUSTERING',
          message: `Clustering ${passed.length} articles by incident...`
        });
      }

      const clusterStart = Date.now();

      // Progress callback for clustering - sends SSE events AND saves to session for resume
      const clusterProgress: ClusterProgressCallback = async (progress) => {
        if (progress.type === 'batch_start') {
          sendEvent({
            type: 'cluster_batch_start',
            batch: progress.batch,
            totalBatches: progress.totalBatches,
            articlesInBatch: progress.articlesInBatch,
            message: progress.message,
          });
          // Save batch index at START to ensure resume works even if batch doesn't complete
          if (typeof progress.currentBatchIndex === 'number') {
            await updateSession(sessionId, {
              clusterBatchIndex: progress.currentBatchIndex,
              currentPhase: 'cluster'
            }, connectionId);
            console.log(`[V4] DEBUG: Saved clusterBatchIndex=${progress.currentBatchIndex} on batch_start`);
          }
        } else if (progress.type === 'batch_complete') {
          sendEvent({
            type: 'cluster_batch_complete',
            batch: progress.batch,
            totalBatches: progress.totalBatches,
            clustersFound: progress.clustersFound,
            clusterLabels: progress.clusterLabels,
            message: progress.message,
          });

          // Save cluster progress for mid-clustering resume
          if (progress.clustersSoFar) {
            await updateSession(sessionId, {
              clusterBatchIndex: progress.batch,
              clusterBatchResults: progress.clustersSoFar,
              currentPhase: 'cluster'
            }, connectionId);
          }
        } else if (progress.type === 'merge_complete') {
          sendEvent({
            type: 'cluster_merge_complete',
            totalClusters: progress.totalClusters,
            clusterLabels: progress.clusterLabels,
            message: progress.message,
          });
        }
      };

      console.log(`[V4] DEBUG: Calling clusterByIncidentLLM with clusterStartBatchIndex=${clusterStartBatchIndex}, restoredClusters=${restoredClusterBatchResults?.length || 0}`);
      const clusterResult = await clusterByIncidentLLM(passed, subjectName, 5, clusterProgress, clusterStartBatchIndex, restoredClusterBatchResults);

      // Send cluster summary
      sendEvent({
        type: 'incident_clusters',
        totalArticles: clusterResult.stats.totalArticles,
        totalClusters: clusterResult.stats.totalClusters,
        articlesToAnalyze: clusterResult.stats.articlesToAnalyze,
        articlesParked: clusterResult.stats.articlesParked,
        clusters: clusterResult.clusters.map(c => ({ label: c.label, count: c.articles.length })),
        duration: Date.now() - clusterStart,
      });

      // Hoist clustering stats for funnel summary
      clusterStats = { totalClusters: clusterResult.stats.totalClusters, articlesToAnalyze: clusterResult.stats.articlesToAnalyze, articlesParked: clusterResult.stats.articlesParked };

      // Park redundant articles (visible in UI as "further links")
      // Store parked articles for later inclusion in consolidated findings
      parkedArticles = clusterResult.parked;
      for (const item of clusterResult.parked) {
        sendEvent({
          type: 'further_link',
          url: item.url,
          title: item.title,
          reason: 'Duplicate incident - covered by higher-tier source',
          isParked: true,  // Don't show as AMBER - just informational
        });
      }

      if (isBenchmarkRun && clusterResult) {
        funnelPhases.push({
          phase: 'clustering',
          articles: [
            ...clusterResult.toAnalyze.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, clusterId: (a as any).clusterId, clusterLabel: (a as any).clusterLabel })),
            ...clusterResult.parked.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, clusterId: (a as any).clusterId, clusterLabel: (a as any).clusterLabel, parked: true })),
          ],
        });
      }

      // Continue with deduplicated results - clear cluster progress fields
      passed = clusterResult.toAnalyze;
      await updateSession(sessionId, {
        passedElimination: passed,
        currentPhase: 'categorize',
        clusterBatchIndex: undefined,
        clusterBatchResults: undefined
      }, connectionId);
    }

    if (passed.length === 0) {
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      sendEvent({ type: 'complete', stats: { totalResults: allResults.length, programmaticEliminated: progEliminated.length, findings: 0 }, findings: [] });
      res.end();
      return;
    }

    // ========================================
    // PHASE 3: CATEGORIZE (batched LLM calls with progress)
    // ========================================
    // Check if user paused before starting categorization
    if (await isSessionPaused(sessionId)) {
      console.log(`[V4] Session ${sessionId} paused before categorize phase`);
      sendEvent({ type: 'paused', phase: 'categorize' });
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      return;
    }

    let categorized: { red: CategorizedResult[]; amber: CategorizedResult[]; green: CategorizedResult[] };

    if (skipCategorize && restoredCategorized) {
      // Skip categorize phase - use restored results from session
      categorized = restoredCategorized;
      console.log(`[V4] Skipped categorize phase, using restored categorization (${categorized.red.length} RED, ${categorized.amber.length} AMBER)`);
    } else {
      const categorizeStart = Date.now();

      // Calculate items to skip for mid-categorize resume
      const CATEGORIZE_BATCH_SIZE = 50;
      const itemsToSkip = categorizeBatchStartIndex * CATEGORIZE_BATCH_SIZE;
      const remainingItems = passed.slice(itemsToSkip);

      // Track partial results for mid-categorize resume
      // Start with restored partial results if resuming
      const partialCategorized: { red: CategorizedResult[]; amber: CategorizedResult[]; green: CategorizedResult[] } =
        restoredCategorizePartialResults || { red: [], amber: [], green: [] };

      if (categorizeBatchStartIndex > 0) {
        console.log(`[V4] Resuming categorize from batch ${categorizeBatchStartIndex + 1}, skipping ${itemsToSkip} items, ${remainingItems.length} remaining`);
        sendEvent({
          type: 'phase',
          phase: 3,
          name: 'CATEGORIZE',
          message: `Resuming categorize from batch ${categorizeBatchStartIndex + 1}: ${remainingItems.length} items remaining...`
        });
      } else {
        sendEvent({ type: 'phase', phase: 3, name: 'CATEGORIZE', message: `Categorizing ${passed.length} results...` });
      }

      // Categorize remaining items
      const newCategorized = await categorizeAll(remainingItems, subjectName, subjectProfile, async (progress) => {
        // Adjust batch number to account for skipped batches
        const adjustedBatchNumber = progress.batchNumber + categorizeBatchStartIndex;
      // Accumulate results for session persistence
      partialCategorized.red.push(...progress.batchResult.red);
      partialCategorized.amber.push(...progress.batchResult.amber);
      partialCategorized.green.push(...progress.batchResult.green);

      // Send individual categorized_item events AS THEY HAPPEN (not after all batches)
      for (const item of progress.batchResult.red) {
        sendEvent({ type: 'categorized_item', category: 'RED', title: item.title, snippet: item.snippet, query: item.query, reason: item.reason, url: item.url, entityMatch: item.entityMatch, entityReason: item.entityReason });
      }
      for (const item of progress.batchResult.amber) {
        sendEvent({ type: 'categorized_item', category: 'AMBER', title: item.title, snippet: item.snippet, query: item.query, reason: item.reason, url: item.url, entityMatch: item.entityMatch, entityReason: item.entityReason });
      }
      // Don't log GREEN items to reduce noise - there are many

      // Send batch progress summary (use adjusted batch number for consistency)
      const adjustedTotalBatches = progress.totalBatches + categorizeBatchStartIndex;
      const adjustedProcessedSoFar = progress.processedSoFar + itemsToSkip;
      sendEvent({
        type: 'categorize_batch_complete',
        batch: adjustedBatchNumber,
        totalBatches: adjustedTotalBatches,
        processedSoFar: adjustedProcessedSoFar,
        totalItems: passed.length,  // Use total items, not just remaining
        batchRed: progress.batchResult.red.length,
        batchAmber: progress.batchResult.amber.length,
        batchGreen: progress.batchResult.green.length,
      });

      // Save categorize progress for mid-categorize resume (use adjusted batch number)
      await updateSession(sessionId, {
        categorizePartialResults: { ...partialCategorized },
        categorizeBatchIndex: adjustedBatchNumber,
        currentPhase: 'categorize'
      }, connectionId);
    });

      // Merge new results with any restored partial results
      // partialCategorized already contains both restored + newly categorized items
      categorized = partialCategorized;

      if (isBenchmarkRun) {
        funnelPhases.push({
          phase: 'categorize',
          articles: [
            ...categorized.red.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, clusterId: (a as any).clusterId, clusterLabel: (a as any).clusterLabel, classification: 'RED' })),
            ...categorized.amber.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, clusterId: (a as any).clusterId, clusterLabel: (a as any).clusterLabel, classification: 'AMBER' })),
            ...categorized.green.map(a => ({ url: a.url, title: a.title, snippet: a.snippet, clusterId: (a as any).clusterId, clusterLabel: (a as any).clusterLabel, classification: 'GREEN' })),
          ],
        });
      }

      sendEvent({
        type: 'categorize_complete',
        red: categorized.red.length,
        amber: categorized.amber.length,
        green: categorized.green.length,
        duration: Date.now() - categorizeStart,
      });

      // === DEDUPLICATE before analyze ===
      const redDedupe = deduplicateResults(categorized.red);
      const amberDedupe = deduplicateResults(categorized.amber);

      categorized.red = redDedupe.unique;
      categorized.amber = amberDedupe.unique;

      const totalDuplicates = redDedupe.duplicateCount + amberDedupe.duplicateCount;
      if (totalDuplicates > 0) {
        console.log(`[V4] Deduplication: removed ${redDedupe.duplicateCount} red, ${amberDedupe.duplicateCount} amber duplicates`);
        sendEvent({
          type: 'dedupe',
          redRemoved: redDedupe.duplicateCount,
          amberRemoved: amberDedupe.duplicateCount,
          redCount: categorized.red.length,
          amberCount: categorized.amber.length,
        });
      }

      // === TITLE SIMILARITY GROUPING ===
      // Group similar titles, keep max 5 per story, park rest for manual review
      const redGrouped = groupByTitleSimilarity(categorized.red, 5);
      const amberGrouped = groupByTitleSimilarity(categorized.amber, 5);

      const titleParkedCount = redGrouped.parked.length + amberGrouped.parked.length;
      if (titleParkedCount > 0) {
        console.log(`[V4] Title grouping: parked ${redGrouped.parked.length} red, ${amberGrouped.parked.length} amber similar stories`);
        sendEvent({
          type: 'title_grouped',
          redParked: redGrouped.parked.length,
          amberParked: amberGrouped.parked.length,
          redAnalyze: redGrouped.toAnalyze.length,
          amberAnalyze: amberGrouped.toAnalyze.length,
        });

        // Send parked items as further_link events
        for (const item of redGrouped.parked) {
          sendEvent({
            type: 'further_link',
            url: item.url,
            title: item.title,
            reason: 'Similar story covered',
            originalCategory: 'RED',
            triageReason: item.reason,
            isParked: true,  // Don't show as AMBER
          });
        }
        for (const item of amberGrouped.parked) {
          sendEvent({
            type: 'further_link',
            url: item.url,
            title: item.title,
            reason: 'Similar story covered',
            originalCategory: 'AMBER',
            triageReason: item.reason,
            isParked: true,  // Don't show as AMBER
          });
        }
      }

      // Update categorized with grouped results
      categorized.red = redGrouped.toAnalyze;
      categorized.amber = amberGrouped.toAnalyze;

      // Update session with deduplicated categorized results - clear categorize progress fields
      await updateSession(sessionId, {
        categorized,
        currentPhase: 'analyze',
        currentIndex: 0,  // Explicitly initialize for analyze phase to prevent undefined on reconnect
        findings: [],  // Explicitly initialize findings for analyze phase
        categorizeBatchIndex: undefined,
        categorizePartialResults: undefined
      }, connectionId);
    } // End of categorize phase else block

    tracker.recordTriage(categorized.red.length, categorized.amber.length, categorized.green.length);

    // Track categorizations (events already sent during batch processing above)
    for (const item of categorized.red) {
      urlTracker.categorized.red.push({ url: item.url, title: item.title, query: item.query, reason: item.reason });
    }
    for (const item of categorized.amber) {
      urlTracker.categorized.amber.push({ url: item.url, title: item.title, query: item.query, reason: item.reason });
    }
    for (const item of categorized.green) {
      urlTracker.categorized.green.push({ url: item.url, title: item.title, query: item.query, reason: item.reason });
    }

    // ========================================
    // PHASE 4: FETCH & ANALYZE flagged only
    // ========================================
    const toProcess = [...categorized.red, ...categorized.amber];

    if (toProcess.length === 0) {
      clearInterval(heartbeat);
      activeScreenings.delete(screeningKey);
      sendEvent({ type: 'complete', stats: { totalResults: allResults.length, findings: 0 }, findings: [] });
      res.end();
      return;
    }

    sendEvent({ type: 'phase', phase: 4, name: 'ANALYZE', message: `Analyzing ${toProcess.length} flagged results...` });

    // Initialize with restored findings from previous connection
    const allFindings: RawFinding[] = [...restoredFindings];
    if (restoredFindings.length > 0) {
      console.log(`[V4] Starting analysis with ${restoredFindings.length} restored findings`);
    }
    if (analyzeStartIndex > 0) {
      console.log(`[V4] Resuming analysis from index ${analyzeStartIndex}`);
    }
    const processedUrls = new Set<string>();

    // Eagerly save current progress at analyze phase start so a quick re-disconnect preserves position
    if (analyzeStartIndex > 0 || restoredFindings.length > 0) {
      try {
        await updateSession(sessionId, { currentIndex: analyzeStartIndex, findings: allFindings }, connectionId);
        console.log(`[V4] Eager save at analyze start: currentIndex=${analyzeStartIndex}, findings=${allFindings.length}`);
      } catch (saveErr) {
        console.error(`[V4] Failed eager save at analyze start:`, saveErr);
      }
    }

    for (let i = analyzeStartIndex; i < toProcess.length; i++) {
      // Check if aborted (client reconnected, starting new screening)
      if (signal.aborted) {
        console.log(`[V4] Analyze aborted at ${i + 1}/${toProcess.length} for: ${subjectName}`);
        // Save progress before aborting so next reconnect resumes from here
        try {
          await updateSession(sessionId, { currentIndex: i, findings: allFindings }, connectionId);
          console.log(`[V4] Saved progress on abort: currentIndex=${i}`);
        } catch (saveErr) {
          console.error(`[V4] Failed to save progress on abort:`, saveErr);
        }
        activeScreenings.delete(screeningKey);
        return;
      }

      // Check if response stream is still alive (prevents zombie processing)
      if (res.destroyed || res.writableEnded) {
        console.log(`[V4] Response stream dead at article ${i + 1}/${toProcess.length}, stopping`);
        try {
          await updateSession(sessionId, { currentIndex: i, findings: allFindings }, connectionId);
        } catch (e) { /* ignore */ }
        activeScreenings.delete(screeningKey);
        return;
      }

      // Check if user paused the session
      if (await isSessionPaused(sessionId)) {
        // Save current position before exiting so resume starts here
        await updateSession(sessionId, { currentIndex: i, findings: allFindings }, connectionId);
        console.log(`[V4] Session ${sessionId} paused at analyze ${i + 1}/${toProcess.length}, saved currentIndex=${i}`);
        sendEvent({ type: 'paused', phase: 'analyze', articleIndex: i + 1 });
        clearInterval(heartbeat);
        activeScreenings.delete(screeningKey);
        return;
      }

      const item = toProcess[i];

      // Skip duplicates
      if (processedUrls.has(item.url)) {
        urlTracker.eliminated.push({ url: item.url, query: item.query, reason: 'duplicate' });
        sendEvent({
          type: 'analyze_skip',
          index: i + 1,
          total: toProcess.length,
          url: item.url,
          title: item.title,
          reason: 'duplicate'
        });
        // Save progress before continue to ensure reconnect resumes from correct position
        await updateSession(sessionId, { currentIndex: i + 1, findings: allFindings }, connectionId);
        continue;
      }
      processedUrls.add(item.url);

      // Skip invalid URLs
      if (!isValidUrl(item.url)) {
        urlTracker.eliminated.push({ url: item.url, query: item.query, reason: 'invalid_url' });
        sendEvent({
          type: 'analyze_skip',
          index: i + 1,
          total: toProcess.length,
          url: item.url,
          title: item.title,
          reason: 'invalid_url'
        });
        // Save progress before continue to ensure reconnect resumes from correct position
        await updateSession(sessionId, { currentIndex: i + 1, findings: allFindings }, connectionId);
        continue;
      }

      sendEvent({
        type: 'analyze_start',
        index: i + 1,
        total: toProcess.length,
        url: item.url,
        title: item.title,
        category: item.category,
      });

      try {
        // Timeout wrapper: max 45 seconds for fetch+analyze combined
        const ANALYZE_TIMEOUT_MS = 45000;
        const controller = new AbortController();
        const analyzeTimeout = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);

        // Helper to run fetch+analyze with abort signal
        const analyzeArticle = async (signal: AbortSignal) => {
          const content = await fetchPageContent(item.url, signal);
          tracker.recordFetch(content.length > 100);

          if (content.length < 100) {
            return { content: '', analysis: null };
          }

          const analysis = await analyzeWithLLM(content, subjectName, item.query, item.url, {
            companies: subjectProfile.associatedCompanies.map(c => c.name),
            role: subjectProfile.currentRole?.title,
            associates: subjectProfile.associatedPeople.map(p => p.name),
          });
          return { content, analysis };
        };

        let result: { content: string; analysis: any };
        try {
          result = await analyzeArticle(controller.signal);
        } catch (abortErr: any) {
          if (abortErr?.name === 'AbortError' || controller.signal.aborted) {
            throw new Error('FETCH_TIMEOUT');
          }
          throw abortErr;
        } finally {
          clearTimeout(analyzeTimeout);
        }

        if (!result.analysis) {
          // Flag for manual review if triage thought it was important
          urlTracker.processed.push({ url: item.url, title: item.title, query: item.query, result: 'FAILED', headline: item.title });
          allFindings.push({
            url: item.url,
            title: item.title,
            severity: item.category === 'RED' ? 'RED' : 'AMBER',
            headline: item.title,
            summary: `${item.reason}. Source: ${item.title}. Full article content was not accessible at time of screening.`,
            triageClassification: item.category,
            fetchFailed: true,
            snippetBased: true,
            clusterId: item.clusterId,
            clusterLabel: item.clusterLabel,
          });
          // Save progress before continue to ensure reconnect resumes from correct position
          await updateSession(sessionId, { currentIndex: i + 1, findings: allFindings }, connectionId);
          continue;
        }

        const analysis = result.analysis;
        tracker.recordAnalysis(analysis.isAdverse, analysis.severity as 'RED' | 'AMBER');

        sendEvent({
          type: 'analyze_result',
          url: item.url,
          title: item.title,
          isAdverse: analysis.isAdverse,
          severity: analysis.severity,
          headline: analysis.headline,
          matchConfidence: analysis.matchConfidence,
          matchReasons: analysis.matchReasons,
          clusterId: item.clusterId,
          clusterLabel: item.clusterLabel,
          // Include accumulated findings for client to restore on reconnect
          _findings: allFindings,
        });

        // Merge profile facts from this article
        if (analysis.profileFacts && analysis.profileFacts.length > 0) {
          let profileUpdated = false;
          const updates: ProfileFact[] = [];

          for (const fact of analysis.profileFacts) {
            const source: ProfileFact = {
              field: fact.field,
              value: fact.value,
              articleUrl: item.url,
              snippet: fact.evidence,
            };

            if (fact.field === 'currentRole' && !subjectProfile.currentRole && fact.value) {
              try {
                const parts = fact.value.match(/(.+?)\s+(?:of|at)\s+(.+)/i);
                if (parts) {
                  subjectProfile.currentRole = { title: parts[1], company: parts[2] };
                  profileUpdated = true;
                  updates.push(source);
                }
              } catch {}
            } else if (fact.field === 'associatedCompany' && fact.value) {
              if (!subjectProfile.associatedCompanies.some(c => c.name === fact.value)) {
                subjectProfile.associatedCompanies.push({ name: fact.value, relationship: 'associated' });
                profileUpdated = true;
                updates.push(source);
              }
            } else if (fact.field === 'associatedPerson' && fact.value) {
              if (!subjectProfile.associatedPeople.some(p => p.name === fact.value)) {
                subjectProfile.associatedPeople.push({ name: fact.value, relationship: 'associated' });
                profileUpdated = true;
                updates.push(source);
              }
            }

            subjectProfile.sources.push(source);
          }

          // Cap sources to prevent Redis session bloat
          if (subjectProfile.sources.length > 50) {
            subjectProfile.sources = subjectProfile.sources.slice(-50);
          }

          // Update confidence based on corroborating facts
          const factCount = subjectProfile.sources.length;
          if (factCount >= 5) subjectProfile.confidence = 'high';
          else if (factCount >= 3) subjectProfile.confidence = 'medium';
          subjectProfile.lastUpdated = Date.now();

          if (profileUpdated) {
            sendEvent({ type: 'profile_update', updates });
          }
        }

        if (analysis.isAdverse) {
          urlTracker.processed.push({ url: item.url, title: item.title, query: item.query, result: 'ADVERSE', severity: analysis.severity, headline: analysis.headline });
          allFindings.push({
            url: item.url,
            title: item.title,
            severity: analysis.severity as 'RED' | 'AMBER',
            headline: analysis.headline,
            summary: analysis.summary,
            triageClassification: item.category,
            clusterId: item.clusterId,
            clusterLabel: item.clusterLabel,
            matchConfidence: analysis.matchConfidence,
            matchReasons: analysis.matchReasons,
            articleContent: result.content?.slice(0, 6000) || undefined,
          });
        } else {
          // LLM said "Clear" - but if triage flagged RED/AMBER, we should preserve for manual review
          // The original categorization was based on title/snippet which may have real info
          // that the LLM couldn't verify (403 error, paywall, garbage content, etc.)

          if (item.category === 'RED' || item.category === 'AMBER') {
            // Detect suspicious content patterns
            const fetchedContent = result.content || '';
            const contentLower = fetchedContent.toLowerCase();
            const isShortContent = fetchedContent.length < 500;
            const isErrorPage = contentLower.includes('403') || contentLower.includes('forbidden') ||
                               contentLower.includes('access denied') || contentLower.includes('not found') ||
                               contentLower.includes('page not available') || contentLower.includes('无法访问');
            const subjectInContent = nameVariations.some((v: string) => fetchedContent.includes(v)) ||
              contentLower.includes(subjectName.toLowerCase());

            // Determine reason for further review - use clearer wording
            let furtherReason = 'Unverified - needs manual review';
            if (isShortContent) furtherReason = 'Content too short to verify';
            else if (isErrorPage) furtherReason = 'Error page - needs manual check';
            else if (!subjectInContent) furtherReason = 'Subject not in content - verify manually';

            // Log explicitly so it's visible in Cloud Logs
            console.log(`[SPOTLIGHT] FURTHER: "${item.title.slice(0, 60)}" (category: ${item.category}, reason: ${furtherReason}, triage: ${item.reason})`);

            urlTracker.processed.push({ url: item.url, title: item.title, query: item.query, result: 'FURTHER', headline: furtherReason });
            // Only send further_link event (not analyze_result to avoid duplicate logs)
            sendEvent({
              type: 'further_link',
              url: item.url,
              title: item.title,
              reason: furtherReason,
              originalCategory: item.category,
              triageReason: item.reason,
            });
          } else {
            urlTracker.processed.push({ url: item.url, title: item.title, query: item.query, result: 'CLEARED' });
          }
        }
      } catch (err: any) {
        const isTimeout = err?.message === 'FETCH_TIMEOUT';
        const isStreamError = err?.code === 'ERR_STREAM_DESTROYED' || err?.code === 'ERR_STREAM_WRITE_AFTER_END';
        if (isStreamError) {
          // Connection closed mid-article - not an article error, just a disconnect
          console.log(`[V4] Connection closed during analysis of ${item.url}`);
        } else {
          urlTracker.processed.push({ url: item.url, title: item.title, query: item.query, result: 'FAILED', headline: isTimeout ? 'Timeout (2min)' : 'Fetch/analyze error' });
          console.error(`[V4] Analysis ${isTimeout ? 'timed out' : 'failed'} for ${item.url}:`, err);
          sendEvent({ type: 'analyze_error', url: item.url, error: isTimeout ? 'Timeout (2min) - skipped' : 'Failed to fetch/analyze' });
        }
      }

      // Save progress AFTER this article is fully processed (for mid-analyze resume)
      // Use i + 1 so on resume we start with the NEXT article, not re-analyze this one
      try {
        const profileUpdate = ((i + 1) % 5 === 0) ? { profile: subjectProfile } : {};
        const saved = await updateSession(sessionId, { currentIndex: i + 1, findings: allFindings, ...profileUpdate }, connectionId);
        if (!saved) {
          console.warn(`[V4] PROGRESS_SAVE_FAILED: article ${i + 1}/${toProcess.length}, updateSession returned false`);
        }
      } catch (saveErr) {
        console.error(`[V4] PROGRESS_SAVE_ERROR: article ${i + 1}/${toProcess.length}:`, saveErr);
        // Don't rethrow - continue analyzing even if progress save fails
      }
    }

    // ========================================
    // PHASE 5: CONSOLIDATE
    // ========================================
    let consolidatedFindings: ConsolidatedFinding[] = [];

    // Include snippet-based (fetchFailed) findings in consolidation instead of separating them
    // They now have meaningful titles and summaries from triage metadata
    const snippetBasedCount = allFindings.filter(f => f.fetchFailed).length;
    if (snippetBasedCount > 0) {
      console.log(`[V4] Including ${snippetBasedCount} snippet-based findings in consolidation (previously excluded as unverified)`);
    }

    if (skipConsolidate && restoredConsolidated) {
      // Restored from session - use existing consolidated findings
      consolidatedFindings = restoredConsolidated;
      console.log(`[V4] Skipped consolidate phase, using ${consolidatedFindings.length} restored findings`);
    } else if (allFindings.length > 0) {
      sendEvent({ type: 'phase', phase: 5, name: 'CONSOLIDATE', message: `Consolidating ${allFindings.length} findings...` });

      // Update session to consolidate phase BEFORE starting (for reconnection tracking)
      await updateSession(sessionId, { currentPhase: 'consolidate' }, connectionId);

      consolidatedFindings = await consolidateFindings(allFindings, subjectName, parkedArticles);
      tracker.recordConsolidation(allFindings.length, consolidatedFindings.length);

      // Store consolidated results in session (for reconnection)
      await updateSession(sessionId, { consolidatedFindings }, connectionId);

      sendEvent({
        type: 'eliminate_complete',
        before: allFindings.length,
        after: consolidatedFindings.length,
      });
    }

    // NOW stop heartbeat (after consolidation is done)
    clearInterval(heartbeat);

    // Final stats (REVIEW items count as AMBER - they need manual review)
    const redFindings = consolidatedFindings.filter(f => f.severity === 'RED');
    const amberFindings = consolidatedFindings.filter(f => f.severity === 'AMBER' || f.severity === 'REVIEW');
    const totalDuration = Date.now() - startTime;

    // Build clean results map for entities without findings
    // Group green categorized results by their query (name variation)
    const cleanResults: Record<string, CleanEntityResult[]> = {};
    for (const item of categorized.green) {
      // Find which name variation this result belongs to
      const matchedVariation = nameVariations.find(nv =>
        item.query.toLowerCase().includes(nv.toLowerCase())
      ) || item.query;
      if (!cleanResults[matchedVariation]) {
        cleanResults[matchedVariation] = [];
      }
      cleanResults[matchedVariation].push({
        url: item.url,
        title: item.title,
        snippet: item.snippet,
      });
    }
    // Remove entities that have findings (they'll be handled as flagged)
    const findingSources = new Set(consolidatedFindings.flatMap(f => f.sources.map(s => s.url)));
    for (const [entity, results] of Object.entries(cleanResults)) {
      const hasFindings = results.some(r => findingSources.has(r.url));
      if (hasFindings) {
        delete cleanResults[entity];
      }
    }

    // Build summary breakdown
    const eliminatedByDuplicate = urlTracker.eliminated.filter(e => e.reason === 'duplicate').length;
    const eliminatedByInvalid = urlTracker.eliminated.filter(e => e.reason === 'invalid_url').length;
    const processedAdverse = urlTracker.processed.filter(p => p.result === 'ADVERSE').length;
    const processedCleared = urlTracker.processed.filter(p => p.result === 'CLEARED').length;
    const processedFailed = urlTracker.processed.filter(p => p.result === 'FAILED').length;

    sendEvent({
      type: 'complete',
      stats: {
        // Phase 1: Gather
        gathered: allResults.length,
        // Phase 2: Programmatic Elimination
        programmaticElimination: {
          before: allResults.length,
          after: passed.length,
          eliminated: progEliminated.length,
          govBypassed: bypassed.length,
          breakdown,
        },
        // Phase 3: Categorize
        categorized: {
          red: categorized.red.length,
          amber: categorized.amber.length,
          green: categorized.green.length,
        },
        // Phase 4: Analyze
        eliminated: {
          total: urlTracker.eliminated.length,
          duplicate: eliminatedByDuplicate,
          invalid: eliminatedByInvalid,
        },
        processed: {
          total: urlTracker.processed.length,
          adverse: processedAdverse,
          cleared: processedCleared,
          failed: processedFailed,
        },
        // Phase 5: Consolidate
        consolidated: {
          before: allFindings.length,
          after: consolidatedFindings.length,
        },
        // Final findings
        findings: consolidatedFindings.length,
        red: redFindings.length,
        amber: amberFindings.length,
        // Timing
        durationMs: totalDuration,
        durationMin: (totalDuration / 60000).toFixed(1),
      },
      findings: consolidatedFindings,
      unverifiedFindings: [],  // Snippet-based findings are now included in consolidated findings
      nameVariations,
      cleanResults,
      profile: subjectProfile,
    });

    // ═══ PIPELINE FUNNEL SUMMARY (Cloud Logs) ═══
    console.log(`[PIPELINE] ═══ FUNNEL: ${subjectName} ═══`);
    console.log(`[PIPELINE] Search:       ${allResults.length} articles gathered`);
    console.log(`[PIPELINE] Elimination:  ${allResults.length} → ${passedEliminationCount} passed (${progEliminated.length} eliminated: domain=${breakdown.noise_domain + breakdown.trash_domain}, title=${breakdown.noise_title_pattern}, keyword=${breakdown.missing_dirty_word}, name_sep=${breakdown.name_char_separation})`);
    console.log(`[PIPELINE] Clustering:   ${clusterStats.totalClusters} clusters → ${clusterStats.articlesToAnalyze} to analyze (${clusterStats.articlesParked} parked)`);
    console.log(`[PIPELINE] Categorize:   RED:${categorized.red.length} AMBER:${categorized.amber.length} GREEN:${categorized.green.length}`);
    console.log(`[PIPELINE] Analyze:      ${urlTracker.processed.length} processed → ADVERSE:${processedAdverse} CLEARED:${processedCleared} FURTHER:${urlTracker.processed.filter(p => p.result === 'FURTHER').length} FAILED:${processedFailed}`);
    console.log(`[PIPELINE] Consolidate:  ${allFindings.length} → ${consolidatedFindings.length} findings`);
    console.log(`[PIPELINE] ═══ FINAL: ${consolidatedFindings.length} findings (${redFindings.length} RED, ${amberFindings.length} AMBER) in ${(totalDuration / 60000).toFixed(1)} min ═══`);

    // Save final profile to session
    await updateSession(sessionId, { profile: subjectProfile }, connectionId);

    // Save log with full URL tracking
    const metrics = tracker.finalize();
    try {
      const logPath = saveLog(subjectName, metrics.runId, {
        metrics,
        findings: consolidatedFindings,
        urlTracker,  // Full URL tracking: gathered, categorized, eliminated, processed
        eventLog,
      });
      console.log(`[V4] Saved log to ${logPath}`);
    } catch (logError) {
      console.error('[V4] Failed to save log:', logError);
    }

    // Auto-save to reports database
    try {
      // Use sessionId as runId so reconnections upsert instead of creating duplicates
      const stableRunId = sessionId;
      const reportId = await saveReportToDb({
        runId: stableRunId,
        subjectName,
        screenedAt: metrics.startTime,
        language: languageParam || 'zh',
        nameVariations: nameVariations || [],
        findings: consolidatedFindings.map((f: ConsolidatedFinding) => ({
          severity: f.severity as 'RED' | 'AMBER' | 'REVIEW',
          headline: f.headline,
          eventType: f.eventType || 'unknown',
          summary: f.summary,
          dateRange: f.dateRange,
          sourceCount: f.sourceCount,
          sourceUrls: f.sources,
        })),
        cleanResults: Object.keys(cleanResults).length > 0 ? cleanResults : undefined,
        screeningStats: {
          gathered: allResults.length,
          programmaticElimination: {
            before: allResults.length,
            after: passed.length,
            eliminated: progEliminated.length,
            govBypassed: bypassed.length,
          },
          categorized: {
            red: categorized.red.length,
            amber: categorized.amber.length,
            green: categorized.green.length,
          },
          processed: {
            total: urlTracker.processed.length,
            adverse: urlTracker.processed.filter(p => p.result === 'ADVERSE').length,
            cleared: urlTracker.processed.filter(p => p.result === 'CLEARED').length,
            failed: urlTracker.processed.filter(p => p.result === 'FAILED').length,
          },
          consolidated: {
            before: allFindings.length,
            after: consolidatedFindings.length,
          },
        },
        costUsd: metrics.totalCostUSD,
        durationMs: metrics.durationMs || 0,
        queriesExecuted: metrics.queriesExecuted,
        totalSearchResults: metrics.totalSearchResults,
      });
      console.log(`[REPORTS] Saved report #${reportId} for ${subjectName}`);
      // Store runId and cleanResults in session so generate-report can access them
      await updateSession(sessionId, { runId: stableRunId, cleanResults } as any, connectionId);
    } catch (reportErr) {
      console.error('[REPORTS] Failed to save to database:', reportErr);
    }

    // Benchmark evaluation
    const benchmarkResult = evaluateBenchmark(subjectName, consolidatedFindings, metrics.runId);
    if (benchmarkResult) {
      saveBenchmarkResult(benchmarkResult);
      sendEvent({
        type: 'benchmark',
        recall: benchmarkResult.recall,
        matched: benchmarkResult.matchedIssues,
        missed: benchmarkResult.missedIssues,
      });
    }

    // Benchmark funnel trace
    if (isBenchmarkRun && benchmarkCase) {
      funnelPhases.push({
        phase: 'consolidate',
        articles: consolidatedFindings.map(f => ({
          url: f.sources?.[0]?.url || '', title: f.headline, snippet: f.summary,
        })),
      });

      const snapshot: FunnelSnapshot = {
        subject: subjectName,
        runId: metrics.runId,
        timestamp: new Date().toISOString(),
        phases: funnelPhases,
      };
      saveFunnelSnapshot(snapshot);
      const traceReport = traceFunnel(snapshot, benchmarkCase);
      printTraceReport(traceReport);
    }

    activeScreenings.delete(screeningKey);
    // Keep session for resume - mark as completed instead of deleting
    await updateSession(sessionId, { currentPhase: 'complete' }, connectionId);
    res.end();
  } catch (error) {
    clearInterval(heartbeat);
    activeScreenings.delete(screeningKey);
    // IMPORTANT: Do NOT delete the session here. Errors often happen because
    // Cloud Run killed the SSE connection (5-min timeout). The session contains
    // valuable progress (currentIndex, findings) that the next reconnect needs.
    console.error('[V4] Screening error:', error);
    sendEvent({ type: 'error', message: 'Screening failed' });
    res.end();
  } finally {
    await closeBrowser();
  }
});

// Serve frontend
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/ipo', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/ipo.html'));
});

app.get('/screening', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/reports', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/reports.html'));
});

app.get('/verify-import', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/verify-import.html'));
});

// ============================================================
// SESSION STATUS API - Check if a screening session exists
// Used for resume functionality when user reopens page
// ============================================================
app.get('/api/session/:sessionId/status', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const session = await getSession(sessionId);

    if (!session) {
      res.json({ exists: false });
      return;
    }

    // Calculate progress info
    let progress = '';
    if (session.currentPhase === 'gather') {
      progress = `${session.gatheredResults?.length || 0} URLs gathered`;
    } else if (session.currentPhase === 'eliminate' || session.currentPhase === 'cluster') {
      progress = `${session.passedElimination?.length || session.gatheredResults?.length || 0} articles`;
    } else if (session.currentPhase === 'categorize') {
      const red = session.categorized?.red?.length || 0;
      const amber = session.categorized?.amber?.length || 0;
      progress = `${red} RED, ${amber} AMBER flagged`;
    } else if (session.currentPhase === 'analyze') {
      const total = (session.categorized?.red?.length || 0) + (session.categorized?.amber?.length || 0);
      progress = `${session.currentIndex || 0}/${total} articles analyzed`;
    } else if (session.currentPhase === 'consolidate') {
      progress = `${session.findings?.length || 0} findings to consolidate`;
    } else if (session.currentPhase === 'complete') {
      progress = `${session.consolidatedFindings?.length || session.findings?.length || 0} findings`;
    }

    // Count RED and AMBER findings for stats display
    // Use consolidatedFindings for completed sessions, fall back to findings
    const allFindings = session.consolidatedFindings || session.findings || [];
    const redCount = allFindings.filter((f: { severity: string }) => f.severity === 'RED').length;
    const amberCount = allFindings.filter((f: { severity: string }) => f.severity === 'AMBER').length;

    res.json({
      exists: true,
      name: session.name,
      phase: session.currentPhase,
      progress,
      findingsCount: session.findings?.length || 0,
      gatheredCount: session.gatheredResults?.length || 0,
      stats: { red: redCount, amber: amberCount },
    });
  } catch (e) {
    console.error(`[SESSION] Error getting status for ${sessionId}:`, e);
    res.json({ exists: false });
  }
});

// Get session findings for UI restoration on resume
app.get('/api/session/:sessionId/findings', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  try {
    const session = await getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found', findings: [] });
      return;
    }

    // Return findings array with fields needed for UI display
    // Use consolidatedFindings for completed sessions (has richer data), fall back to findings
    const rawFindings = session.consolidatedFindings || session.findings || [];
    const findings = rawFindings.map((f: any) => ({
      url: f.url,
      title: f.title,
      severity: f.severity || f.category,  // Handle both field names
      category: f.severity || f.category,
      headline: f.headline,
      summary: f.summary,
      sources: f.sources || [{ url: f.url, title: f.title }],
      dateRange: f.dateRange || '',
    }));

    res.json({ findings });
  } catch (e) {
    console.error(`[SESSION] Error getting findings for ${sessionId}:`, e);
    res.status(500).json({ error: 'Failed to get findings', findings: [] });
  }
});

// ============================================================
// SESSION PAUSE/RESUME API - True pause functionality
// ============================================================
app.post('/api/session/:sessionId/pause', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  try {
    const session = await getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await updateSession(sessionId, { isPaused: true, pausedAt: Date.now() });
    console.log(`[PAUSE] Session ${sessionId} paused at phase ${session.currentPhase}`);
    res.json({ paused: true, phase: session.currentPhase });
  } catch (err) {
    console.error(`[PAUSE] Error pausing session ${sessionId}:`, err);
    res.status(500).json({ error: 'Failed to pause session' });
  }
});

app.post('/api/session/:sessionId/resume', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  try {
    await updateSession(sessionId, { isPaused: false, pausedAt: undefined });
    console.log(`[RESUME] Session ${sessionId} resumed`);
    res.json({ resumed: true });
  } catch (err) {
    console.error(`[RESUME] Error resuming session ${sessionId}:`, err);
    res.status(500).json({ error: 'Failed to resume session' });
  }
});

// ============================================================
// GENERATE REPORT API ENDPOINT
// Generates LLM-powered paragraph summaries for selected findings
// ============================================================

app.post('/api/session/:sessionId/generate-report', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { findings, subjectName, nameVariations: reqNameVariations } = req.body;

  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    res.status(400).json({ error: 'findings array required' });
    return;
  }

  if (!subjectName) {
    res.status(400).json({ error: 'subjectName required' });
    return;
  }

  console.log(`[REPORT] Generating streaming report for ${subjectName} with ${findings.length} findings (session: ${sessionId})`);

  // Load session to access cached article content + clean results
  const session = await getSession(sessionId);
  const rawFindings = session?.findings || [];
  const consolidatedFindings = session?.consolidatedFindings || [];

  // Load clean results and name variations from session or DB
  let cleanResults: Record<string, CleanEntityResult[]> = {};
  let nameVariations: string[] = reqNameVariations || [];

  if (session) {
    cleanResults = (session as any).cleanResults || {};
    if (nameVariations.length === 0) {
      nameVariations = (session as any).variations || [];
    }
  }

  // Fallback to DB if session doesn't have clean results
  if (Object.keys(cleanResults).length === 0) {
    try {
      const runId = (session as any)?.runId;
      if (runId) {
        const { pool: pgPool } = await import('./db/index.js');
        const { rows: [dbRow] } = await pgPool.query('SELECT clean_results_json, name_variations FROM dd_reports WHERE run_id = $1', [runId]);
        if (dbRow?.clean_results_json) {
          cleanResults = JSON.parse(dbRow.clean_results_json);
        }
        if (nameVariations.length === 0 && dbRow?.name_variations) {
          nameVariations = JSON.parse(dbRow.name_variations);
        }
      }
    } catch {
      // Non-critical
    }
  }

  const hasCleanEntities = Object.keys(cleanResults).length > 0;
  console.log(`[REPORT] Name variations: ${nameVariations.length}, clean entities: ${Object.keys(cleanResults).length}`);

  // Check LLM configuration (generateWriteUp needs at least one provider)
  if (!process.env.DEEPSEEK_API_KEY && !process.env.KIMI_API_KEY) {
    res.status(500).json({ error: 'No LLM API configured' });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data: any) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Track client disconnect
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    console.log(`[REPORT] Client disconnected mid-stream (session: ${sessionId})`);
  });

  try {
    // Build clean entity list for report_start
    const cleanEntityNames = Object.keys(cleanResults);
    const totalItems = findings.length + cleanEntityNames.length;

    // Send report_start with all finding + clean entity metadata so frontend can render cards
    sendEvent({
      type: 'report_start',
      total: totalItems,
      findings: findings.map((f: any, i: number) => ({
        index: i,
        headline: f.headline || 'Finding',
        severity: f.severity || 'AMBER',
        sources: (f.sources || []).map((s: any) => ({ title: s.title, url: s.url })),
      })),
      cleanEntities: cleanEntityNames.map((name, i) => ({
        index: findings.length + i,
        entityName: name,
        resultCount: cleanResults[name].length,
      })),
    });

    const sections: { findingId: string; headline: string; paragraph: string; sources: string[] }[] = [];

    for (let i = 0; i < findings.length; i++) {
      if (clientDisconnected) {
        console.log(`[REPORT] Aborting — client disconnected at finding ${i + 1}`);
        break;
      }

      const finding = findings[i];
      const findingId = finding.id || `finding-${i}`;

      console.log(`[REPORT] Processing finding ${i + 1}/${findings.length}: ${finding.headline?.slice(0, 50)}...`);

      // Build source list
      const sources = finding.sources || [];
      const primarySource = sources[0];
      const otherSources = sources.slice(1);

      sendEvent({
        type: 'finding_start',
        index: i,
        headline: finding.headline || 'Finding',
        severity: finding.severity || 'AMBER',
        sources: sources.map((s: any) => ({ title: s.title, url: s.url })),
      });

      // Look up cached article content from session
      let articleText = '';
      const sourceUrls = new Set(sources.map((s: any) => s.url));

      // Try consolidated findings first (has articleContents[])
      const matchedConsolidated = consolidatedFindings.find((cf: any) =>
        cf.headline === finding.headline && cf.summary === finding.summary
      );

      if (matchedConsolidated?.articleContents && matchedConsolidated.articleContents.length > 0) {
        articleText = matchedConsolidated.articleContents
          .map((ac: any) => ac.content)
          .join('\n\n---\n\n')
          .slice(0, 8000);
      } else {
        // Fall back to raw findings by URL match
        const matchedRaw = rawFindings.filter((rf: any) => sourceUrls.has(rf.url) && rf.articleContent);
        if (matchedRaw.length > 0) {
          articleText = matchedRaw
            .map((rf: any) => rf.articleContent)
            .join('\n\n---\n\n')
            .slice(0, 8000);
        }
      }

      console.log(`[REPORT] Finding ${i + 1}: ${articleText ? `${articleText.length} chars of article text` : 'no article text, metadata only'}`);

      // Build a ConsolidatedFinding-compatible object for generateWriteUp
      const consolidatedFinding = {
        headline: finding.headline || 'Finding',
        summary: finding.summary || '',
        severity: (finding.severity || 'AMBER') as 'RED' | 'AMBER' | 'REVIEW',
        eventType: finding.eventType || 'unknown',
        dateRange: finding.dateRange || '',
        sourceCount: finding.sourceCount || sources.length,
        sources: sources.map((s: any) => ({ url: s.url, title: s.title || '' })),
      };

      // Use unified generateWriteUp from reportGenerator (streams via SSE)
      let paragraph = '';
      try {
        const result = await generateWriteUp(
          consolidatedFinding,
          subjectName,
          (chunk: string) => {
            sendEvent({ type: 'finding_token', index: i, token: chunk });
          },
          articleText || undefined
        );
        paragraph = result.text;
      } catch (err: any) {
        console.log(`[REPORT] generateWriteUp failed: ${err.message}`);
      }

      // Fallback if generateWriteUp returned empty
      if (!paragraph) {
        paragraph = `According to ${primarySource?.title || 'news reports'}, ${finding.headline || 'an adverse finding was identified'}. ${finding.summary || ''}`;
        if (finding.sourceCount > 1) {
          paragraph += ` This information was corroborated by ${finding.sourceCount - 1} additional source(s).`;
        }
        sendEvent({ type: 'finding_token', index: i, token: paragraph });
      }

      sendEvent({ type: 'finding_complete', index: i, paragraph });

      sections.push({
        findingId,
        headline: finding.headline || 'Finding',
        paragraph,
        sources: sources.map((s: any) => s.url),
      });
    }

    // Generate clean entity write-ups
    const cleanSections: { entityName: string; paragraph: string; sources: string[] }[] = [];

    for (let ci = 0; ci < cleanEntityNames.length; ci++) {
      if (clientDisconnected) break;

      const entityName = cleanEntityNames[ci];
      const entityResults = cleanResults[entityName] || [];
      const cleanIndex = findings.length + ci;

      console.log(`[REPORT] Processing clean entity ${ci + 1}/${cleanEntityNames.length}: "${entityName}" (${entityResults.length} results)`);

      sendEvent({
        type: 'clean_entity_start',
        index: cleanIndex,
        entityName,
        resultCount: entityResults.length,
      });

      // Use generateCleanWriteUp from reportGenerator
      let paragraph = '';
      try {
        paragraph = await generateCleanWriteUp(entityName, entityResults, subjectName, (chunk) => {
          sendEvent({ type: 'finding_token', index: cleanIndex, token: chunk });
        });
      } catch (err: any) {
        console.log(`[REPORT] Clean write-up failed for "${entityName}": ${err.message}`);
        const sourceList = entityResults.map(r => r.url).join('\n');
        paragraph = `Media and online coverage of ${entityName} is mainly neutral. Online and media references to ${entityName} primarily relate to its business operations and corporate filings.[1]\nOnline and media research found no significant negative issues with the subject.\n\n[1]  ${sourceList}`;
        sendEvent({ type: 'finding_token', index: cleanIndex, token: paragraph });
      }

      sendEvent({ type: 'finding_complete', index: cleanIndex, paragraph });

      cleanSections.push({
        entityName,
        paragraph,
        sources: entityResults.map(r => r.url),
      });
    }

    // Combine into full report (flagged findings + clean entities)
    const flaggedParts = sections.map((s) => {
      return `${s.paragraph}\n\nSources:\n${s.sources.map(url => `- ${url}`).join('\n')}`;
    });
    const cleanParts = cleanSections.map((s) => {
      return s.paragraph;
    });
    const fullReport = [...flaggedParts, ...cleanParts].join('\n\n');

    console.log(`[REPORT] Generated ${sections.length} flagged + ${cleanSections.length} clean sections, ${fullReport.length} total chars`);

    // Save generated report markdown to reports database
    try {
      const { pool: pgPool } = await import('./db/index.js');
      // sessionId IS the runId (set at line 2822: const stableRunId = sessionId)
      const result = await pgPool.query('UPDATE dd_reports SET report_markdown = $1 WHERE run_id = $2', [fullReport, sessionId]);
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[REPORTS] Saved report markdown for run ${sessionId}`);

        // Mark user-selected findings: reset all to 0, then set selected to 1
        const { rows: [reportRow] } = await pgPool.query('SELECT id FROM dd_reports WHERE run_id = $1', [sessionId]);
        if (reportRow) {
          const reportId = reportRow.id;
          await pgPool.query('UPDATE dd_findings SET included_in_report = 0 WHERE report_id = $1', [reportId]);
          for (const f of findings) {
            await pgPool.query(
              'UPDATE dd_findings SET included_in_report = 1 WHERE report_id = $1 AND headline = $2 AND summary = $3',
              [reportId, f.headline, f.summary]
            );
          }
          console.log(`[REPORTS] Marked ${findings.length} selected findings for report ${reportId}`);
        }
      } else {
        console.warn(`[REPORTS] No report found with run_id=${sessionId} — markdown not saved`);
      }
    } catch (e) {
      console.error('[REPORTS] Failed to save report markdown:', e);
    }

    // Send final report_complete event with full assembled markdown
    sendEvent({
      type: 'report_complete',
      report: fullReport,
      sections,
      cleanSections,
    });

    if (!res.writableEnded) {
      res.end();
    }

  } catch (error: any) {
    console.error('[REPORT] Error generating report:', error);
    sendEvent({ type: 'error', message: error.message || 'Failed to generate report' });
    if (!res.writableEnded) {
      res.end();
    }
  }
});

// Historical import verification API
import xlsx from 'xlsx';
import fs from 'fs';

app.get('/api/import-results', (req: Request, res: Response) => {
  const resultsPath = path.join(__dirname, '../.listed-import-results-mainBoard.json');
  try {
    if (fs.existsSync(resultsPath)) {
      const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      res.json(results);
    } else {
      res.json([]);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to load results' });
  }
});

app.get('/api/deal-pdf-url/:ticker', async (req: Request, res: Response) => {
  const ticker = parseInt(req.params.ticker);

  try {
    const dbPath = path.join(__dirname, '../data/ddowl.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });

    const deal = db.prepare('SELECT prospectus_url FROM ipo_deals WHERE ticker = ?').get(ticker) as any;
    db.close();

    res.json({ url: deal?.prospectus_url || null });
  } catch (e) {
    console.error('Failed to get PDF URL:', e);
    res.status(500).json({ error: 'Failed to get PDF URL' });
  }
});

// Verification endpoint - shows all deals with URLs and banks for fact-checking
app.get('/api/ipo/verify-data', async (req: Request, res: Response) => {
  try {
    const dbPath = path.join(__dirname, '../data/ddowl.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });

    const deals = db.prepare(`
      SELECT d.ticker, d.company, d.prospectus_url, d.banks_extracted, d.type, d.notes
      FROM ipo_deals d
      WHERE d.has_bank_info = 1
      ORDER BY d.banks_extracted DESC
    `).all();

    const result = deals.map((d: any) => {
      const banks = db.prepare(`
        SELECT b.name, r.role, r.is_lead, r.raw_role, r.raw_name
        FROM ipo_bank_roles r
        JOIN banks b ON b.id = r.bank_id
        WHERE r.deal_id = (SELECT id FROM ipo_deals WHERE ticker = ?)
      `).all(d.ticker);

      // Group by bank (normalized name)
      const bankMap = new Map();
      for (const b of banks as any[]) {
        if (!bankMap.has(b.name)) {
          bankMap.set(b.name, {
            name: b.name,
            raw_name: b.raw_name || b.name,  // Include raw name from PDF
            roles: [],
            is_lead: b.is_lead
          });
        }
        bankMap.get(b.name).roles.push(b.role);
      }

      return {
        ...d,
        banks: Array.from(bankMap.values())
      };
    });

    db.close();
    res.json(result);
  } catch (e) {
    console.error('Verify data error:', e);
    res.status(500).json({ error: 'Failed to load data', details: String(e) });
  }
});

// Serve verify-banks.html
app.get('/verify-banks', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../verify-banks.html'));
});

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);

// Disable Node.js default server timeouts - Cloud Run manages the request lifecycle
// Without this, Node.js kills sockets after 120s (default), breaking SSE connections
server.setTimeout(0);
server.keepAliveTimeout = 0;

// Initialize WebSocket server
const wsServer = initWSServer(server);

// API endpoint to get extracted QCC data
app.get('/api/qcc/extracted', (req: Request, res: Response) => {
  const ws = getWSServer();
  if (ws) {
    res.json({
      success: true,
      data: ws.getExtractedData(),
      count: ws.getExtractedData().length,
    });
  } else {
    res.status(500).json({ error: 'WebSocket server not initialized' });
  }
});

// API endpoint to clear extracted data
app.post('/api/qcc/clear', (req: Request, res: Response) => {
  const ws = getWSServer();
  if (ws) {
    ws.clearExtractedData();
    res.json({ success: true, message: 'Extracted data cleared' });
  } else {
    res.status(500).json({ error: 'WebSocket server not initialized' });
  }
});

// API endpoint for crawl queue status
app.get('/api/queue', (req: Request, res: Response) => {
  res.json(getQueueStats());
});

// API endpoint to generate person report
app.get('/api/report/person', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      res.status(400).json({ error: 'URL parameter required' });
      return;
    }

    const buffer = await generatePersonReport(url);
    const filename = `person-report-${Date.now()}.docx`;
    const filePath = await saveReport(buffer, filename);

    res.json({ success: true, path: filePath, filename });
  } catch (error: any) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to generate DD write-up report with streaming
app.post('/api/report/generate', async (req: Request, res: Response) => {
  const { subjectName, findings, cleanResults: reqCleanResults, nameVariations: reqNameVariations, sessionId: reqSessionId } = req.body;

  if (!subjectName || !findings || !Array.isArray(findings)) {
    res.status(400).json({ error: 'subjectName and findings array required' });
    return;
  }

  const cleanResults: Record<string, CleanEntityResult[]> = reqCleanResults || {};
  const nameVariations: string[] = reqNameVariations || [subjectName];

  // Set up SSE for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  // Accumulate full markdown for DB persistence
  let fullMarkdown = '';

  const sendChunk = (content: string) => {
    fullMarkdown += content;
    res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
  };

  // Heartbeat (1s for robust connection stability)
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    // Force flush to bypass proxy buffering
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
    heartbeatCount++;
    if (heartbeatCount % 30 === 0) {
      console.log(`[REPORT] [HEARTBEAT] ${heartbeatCount} pings sent for ${subjectName}`);
    }
  }, 1000);

  try {
    console.log(`[REPORT] Starting report generation for ${subjectName} with ${findings.length} findings, ${Object.keys(cleanResults).length} clean entities`);

    await generateFullReport(subjectName, findings as ConsolidatedFinding[], cleanResults, nameVariations, sendChunk);

    // Save generated markdown to reports DB
    if (fullMarkdown) {
      try {
        await saveReportMarkdown(reqSessionId || '', subjectName, fullMarkdown);
        console.log(`[REPORT] Saved report markdown to DB for ${subjectName} (${fullMarkdown.length} chars)`);
      } catch (dbErr) {
        console.error('[REPORT] Failed to save markdown to DB:', dbErr);
      }
    }

    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
  } catch (error: any) {
    clearInterval(heartbeat);
    console.error('[REPORT] Generation error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// API endpoint to generate company report
app.get('/api/report/company', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      res.status(400).json({ error: 'URL parameter required' });
      return;
    }

    const buffer = await generateCompanyReport(url);
    const filename = `company-report-${Date.now()}.docx`;
    const filePath = await saveReport(buffer, filename);

    res.json({ success: true, path: filePath, filename });
  } catch (error: any) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FINDINGS DETAIL & EXPAND API ENDPOINTS
// ============================================================

// Generate detailed report for a single finding
app.post('/api/findings/detail', async (req: Request, res: Response) => {
  const { finding, subjectName } = req.body;

  if (!finding || !subjectName) {
    res.status(400).json({ error: 'finding and subjectName required' });
    return;
  }

  try {
    // Get the first source URL to fetch content
    const sourceUrl = finding.sources?.[0]?.url;
    if (!sourceUrl) {
      res.json({
        success: true,
        summary: finding.summary || 'No summary available',
        keyFacts: 'Source URL not available for detailed analysis.',
      });
      return;
    }

    // Fetch the page content
    let content = '';
    try {
      content = await fetchPageContent(sourceUrl);
    } catch (fetchErr) {
      res.json({
        success: true,
        summary: finding.summary || 'No summary available',
        keyFacts: 'Could not fetch source page for detailed analysis.',
      });
      return;
    }

    if (content.length < 100) {
      res.json({
        success: true,
        summary: finding.summary || 'No summary available',
        keyFacts: 'Source page content too short for detailed analysis.',
      });
      return;
    }

    // Use LLM to generate detailed report
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
    if (!DEEPSEEK_API_KEY) {
      res.json({
        success: true,
        summary: finding.summary || 'No summary available',
        keyFacts: 'LLM API not configured for detailed analysis.',
      });
      return;
    }

    const prompt = `You are writing a detailed due diligence finding for a professional report about "${subjectName}".

Based on this article content, write a comprehensive analysis:

ARTICLE:
${content.slice(0, 8000)}

EXISTING SUMMARY:
${finding.headline}
${finding.summary}

Write two sections:

1. SUMMARY: A detailed 3-5 sentence professional narrative summary of the adverse finding. Include all specific facts: dates, amounts (CNY and USD), case numbers, names of co-conspirators, court decisions, sentences.

2. KEY FACTS: A bulleted list of the most important facts extracted from the article:
- Date(s) of incident
- Nature of offense
- Amount involved (if any)
- Court/regulatory body involved
- Outcome (sentence, fine, etc.)
- Co-conspirators (if any)

Respond in JSON:
{
  "summary": "Detailed narrative summary...",
  "keyFacts": "• Fact 1\\n• Fact 2\\n• Fact 3..."
}`;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 60000,
      }
    );

    const rawText = response.data.choices?.[0]?.message?.content || '';
    const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      res.json({
        success: true,
        summary: parsed.summary || finding.summary,
        keyFacts: parsed.keyFacts || 'No key facts extracted',
      });
    } else {
      res.json({
        success: true,
        summary: finding.summary || 'No summary available',
        keyFacts: 'Could not parse LLM response',
      });
    }
  } catch (error: any) {
    console.error('[DETAIL] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

// Expand search - do further web searches for selected findings
app.post('/api/findings/expand', async (req: Request, res: Response) => {
  const { findings, subjectName } = req.body;

  if (!findings || !Array.isArray(findings) || !subjectName) {
    res.status(400).json({ error: 'findings array and subjectName required' });
    return;
  }

  try {
    const results: { query: string; items: { title: string; url: string; snippet: string }[] }[] = [];

    for (const finding of findings.slice(0, 5)) { // Limit to 5 findings
      // Extract key terms from headline for targeted search
      const headline = (finding.headline || '').replace(/Name match:?\s*/i, '');
      const keyTerms = headline.slice(0, 50);
      const query = `"${subjectName}" ${keyTerms}`;

      console.log(`[EXPAND] Searching: ${query}`);

      // Search Google (1 page)
      const searchResults = await searchGoogle(query, 1, 10);

      results.push({
        query,
        items: searchResults.map(r => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
        })),
      });

      // Small delay between searches
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ success: true, results });
  } catch (error: any) {
    console.error('[EXPAND] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================================
// PERSON RESEARCH API ENDPOINTS
// ============================================================

// Start person research - crawl all affiliations
app.post('/api/research/start', async (req: Request, res: Response) => {
  try {
    const { personName, personUrl } = req.body;

    if (!personName || !personUrl) {
      res.status(400).json({ error: 'personName and personUrl required' });
      return;
    }

    // Start research in background (don't await)
    startPersonResearch(personName, personUrl);

    res.json({
      success: true,
      message: 'Research started',
      status: getSessionStatus(),
    });
  } catch (error: any) {
    console.error('Research start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get research status
app.get('/api/research/status', (req: Request, res: Response) => {
  res.json({
    ...getResearchStatus(),
    session: getSessionStatus(),
  });
});

// Get research results
app.get('/api/research/results', (req: Request, res: Response) => {
  const results = getSessionResults();
  if (!results) {
    res.status(404).json({ error: 'No research session found' });
    return;
  }
  res.json(results);
});

// Stop research
app.post('/api/research/stop', (req: Request, res: Response) => {
  stopPersonResearch();
  res.json({ success: true, message: 'Research stopped' });
});

// Clear research session
app.post('/api/research/clear', (req: Request, res: Response) => {
  clearSession();
  res.json({ success: true, message: 'Session cleared' });
});

// ============================================================
// AI AGENT API ENDPOINTS
// ============================================================

import { runAgent, DDOwlAgent } from './agent/orchestrator.js';
import { AgentProgress, AgentResult } from './agent/tools/types.js';

// Store running agents
const runningAgents: Map<string, { agent: DDOwlAgent; result?: AgentResult }> = new Map();

// Start agent task with SSE progress streaming
app.post('/api/agent/run', async (req: Request, res: Response) => {
  const { task } = req.body;

  if (!task) {
    res.status(400).json({ error: 'task is required' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for real-time SSE
  res.flushHeaders();

  const sendEvent = (type: string, data: any) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const agent = new DDOwlAgent({
      onProgress: (progress: AgentProgress) => {
        sendEvent('progress', progress);
      },
    });

    const taskId = agent.getProgress().taskId;
    runningAgents.set(taskId, { agent });

    sendEvent('started', { taskId, task });

    // Run agent
    const result = await agent.run(task);

    // Store result
    runningAgents.set(taskId, { agent, result });

    sendEvent('complete', {
      taskId,
      success: result.success,
      response: result.response,
      error: result.error,
      toolCallCount: result.toolCallCount,
      duration: result.duration,
    });

    // Clean up after 5 minutes
    setTimeout(() => runningAgents.delete(taskId), 5 * 60 * 1000);

  } catch (error: any) {
    sendEvent('error', { error: error.message });
  }

  res.end();
});

// Get agent result (non-streaming)
app.get('/api/agent/result/:taskId', (req: Request, res: Response) => {
  const { taskId } = req.params;
  const agentData = runningAgents.get(taskId);

  if (!agentData) {
    res.status(404).json({ error: 'Agent task not found' });
    return;
  }

  res.json({
    taskId,
    progress: agentData.agent.getProgress(),
    result: agentData.result,
    data: agentData.agent.getData(),
  });
});

// Simple run endpoint (non-streaming, for testing)
app.post('/api/agent/run-sync', async (req: Request, res: Response) => {
  const { task } = req.body;

  if (!task) {
    res.status(400).json({ error: 'task is required' });
    return;
  }

  try {
    console.log(`[Agent API] Starting task: ${task}`);
    const result = await runAgent(task);
    res.json(result);
  } catch (error: any) {
    console.error('[Agent API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DD TABLE FORMATTING ENDPOINT
// ============================================================

// Format extracted person profile into DD table
app.post('/api/dd/format-table', (req: Request, res: Response) => {
  const data = req.body;

  if (!data || !data.affiliations) {
    res.status(400).json({ error: 'Invalid data - need affiliations array' });
    return;
  }

  const personName = data.personName || 'Unknown';
  const affiliations = data.affiliations || [];
  const currentAffiliations = data.currentAffiliations || [];
  const historicalAffiliations = data.historicalAffiliations || [];

  // Format role with shareholding
  const formatRole = (aff: any): string => {
    const parts: string[] = [];
    if (aff.role) parts.push(aff.role);
    if (aff.shareholding) parts.push(aff.shareholding);
    return parts.join(' ') || '-';
  };

  // Build markdown table
  let markdown = `# DD Report: ${personName}\n\n`;
  markdown += `Source: ${data.source || 'Unknown'}\n`;
  markdown += `Extracted: ${data.extractedAt || new Date().toISOString()}\n\n`;

  // Current affiliations table
  if (currentAffiliations.length > 0) {
    markdown += `## Current Affiliations (${currentAffiliations.length})\n\n`;
    markdown += `| # | Company Name | Registration # | Role/Shareholding | Appointment Date |\n`;
    markdown += `|---|--------------|----------------|-------------------|------------------|\n`;
    currentAffiliations.forEach((aff: any, idx: number) => {
      markdown += `| ${idx + 1} | ${aff.companyName} | TBD | ${formatRole(aff)} | TBD |\n`;
    });
    markdown += `\n`;
  }

  // Historical affiliations table
  if (historicalAffiliations.length > 0) {
    markdown += `## Historical Affiliations (${historicalAffiliations.length})\n\n`;
    markdown += `| # | Company Name | Registration # | Role/Shareholding | Appointment Date |\n`;
    markdown += `|---|--------------|----------------|-------------------|------------------|\n`;
    historicalAffiliations.forEach((aff: any, idx: number) => {
      markdown += `| ${idx + 1} | ${aff.companyName} | TBD | ${formatRole(aff)} | TBD |\n`;
    });
    markdown += `\n`;
  }

  // If no current/historical split, use main affiliations
  if (currentAffiliations.length === 0 && historicalAffiliations.length === 0 && affiliations.length > 0) {
    markdown += `## All Affiliations (${affiliations.length})\n\n`;
    markdown += `| # | Company Name | Registration # | Role/Shareholding | Appointment Date |\n`;
    markdown += `|---|--------------|----------------|-------------------|------------------|\n`;
    affiliations.forEach((aff: any, idx: number) => {
      markdown += `| ${idx + 1} | ${aff.companyName} | TBD | ${formatRole(aff)} | TBD |\n`;
    });
    markdown += `\n`;
  }

  // Risk summary
  if (data.riskInfo) {
    markdown += `## Risk Summary\n\n`;
    markdown += `- Self Risk: ${data.riskInfo.selfRisk || 0}\n`;
    markdown += `- Related Risk: ${data.riskInfo.relatedRisk || 0}\n`;
    markdown += `- Warnings: ${data.riskInfo.warnings || 0}\n`;
  }

  res.json({
    success: true,
    personName,
    currentCount: currentAffiliations.length,
    historicalCount: historicalAffiliations.length,
    totalCount: affiliations.length,
    markdown,
  });
});

// Generate Word report from extracted data
app.post('/api/dd/report', async (req: Request, res: Response) => {
  try {
    const data = req.body;

    if (!data || !data.personName) {
      res.status(400).json({ error: 'Missing personName' });
      return;
    }

    const filename = await generateWordReport({
      personName: data.personName,
      currentAffiliations: data.currentAffiliations || [],
      historicalAffiliations: data.historicalAffiliations || []
    });

    const reportUrl = `/reports/${filename}`;

    res.json({
      success: true,
      filename,
      reportUrl,
      currentCount: data.currentAffiliations?.length || 0,
      historicalCount: data.historicalAffiliations?.length || 0
    });
  } catch (error: any) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DATA LOCK-IN VERIFICATION ENDPOINTS
// ============================================================

// Get run history
app.get('/api/runs', (req: Request, res: Response) => {
  const history = loadHistory();
  res.json(history);
});

// Get sample deals for review
app.get('/api/verify/sample', async (req: Request, res: Response) => {
  const n = parseInt(req.query.n as string) || 20;
  const dbPath = path.join(__dirname, '../data/ddowl.db');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });

  // Get random sample
  const deals = db.prepare(`
    SELECT d.ticker, d.company, d.prospectus_url, d.banks_extracted
    FROM ipo_deals d
    WHERE d.has_bank_info = 1
    ORDER BY RANDOM()
    LIMIT ?
  `).all(n) as any[];

  // Get banks for each deal - grouped by decision maker status
  for (const deal of deals) {
    const allBanks = db.prepare(`
      SELECT b.name, r.raw_name, r.is_decision_maker, r.is_lead, r.raw_roles
      FROM ipo_bank_roles r
      JOIN banks b ON b.id = r.bank_id
      WHERE r.deal_id = (SELECT id FROM ipo_deals WHERE ticker = ?)
    `).all(deal.ticker) as any[];

    deal.decision_makers = allBanks
      .filter(b => b.is_decision_maker)
      .map(b => ({
        name: b.name,
        raw_name: b.raw_name,
        is_lead: b.is_lead === 1,
        raw_roles: JSON.parse(b.raw_roles || '[]'),
      }));

    deal.other_banks = allBanks
      .filter(b => !b.is_decision_maker)
      .map(b => ({
        name: b.name,
        raw_name: b.raw_name,
        raw_roles: JSON.parse(b.raw_roles || '[]'),
      }));
  }

  db.close();
  res.json(deals);
});

// Get flagged deals
app.get('/api/verify/flags', (req: Request, res: Response) => {
  const flags = validateDeals();
  res.json(flags);
});

// Get lock-in progress
app.get('/api/verify/progress', (req: Request, res: Response) => {
  const history = loadHistory();
  const recentRuns = history.runs.slice(-5);
  res.json({
    total_runs: history.runs.length,
    current_clean_streak: history.current_clean_streak,
    locked: history.locked,
    recent_runs: recentRuns,
    target_streak: 3,
  });
});

// Mark run as reviewed
app.post('/api/verify/complete-review', (req: Request, res: Response) => {
  const { run_id, issues_found } = req.body;
  markRunClean(run_id, issues_found);
  res.json({ success: true });
});

// Get diff between runs
app.get('/api/runs/:id/diff/:prevId', (req: Request, res: Response) => {
  const diff = getRunDiff(req.params.id, req.params.prevId);
  res.json(diff || []);
});

// Serve verification UI
app.get('/verify-lockin', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../verify-lockin.html'));
});

// ============================================================
// SCREENING LOG API (L0 Learning Loop)
// ============================================================

const SCREENING_LOG_PATH = path.join(__dirname, '../data/screening-log.json');

function loadScreeningLog() {
  try {
    return JSON.parse(fs.readFileSync(SCREENING_LOG_PATH, 'utf8'));
  } catch {
    return { project: '', subjects: [], learning_log: [] };
  }
}

function saveScreeningLog(log: any) {
  fs.writeFileSync(SCREENING_LOG_PATH, JSON.stringify(log, null, 2));
}

// Get current screening log
app.get('/api/screening-log', (req: Request, res: Response) => {
  res.json(loadScreeningLog());
});

// Save DD Owl run results for a subject
app.post('/api/screening-log/ddowl-run', (req: Request, res: Response) => {
  const { subject_name, red_flags, amber_flags, sources_checked } = req.body;
  const log = loadScreeningLog();

  const subject = log.subjects.find((s: any) => s.name === subject_name);
  if (!subject) {
    res.status(404).json({ error: 'Subject not found in log' });
    return;
  }

  subject.ddowl_run = {
    timestamp: new Date().toISOString(),
    red_flags: red_flags || [],
    amber_flags: amber_flags || [],
    sources_checked: sources_checked || 0
  };

  saveScreeningLog(log);
  res.json({ success: true, subject });
});

// Add human findings for a subject
app.post('/api/screening-log/human-finding', (req: Request, res: Response) => {
  const { subject_name, issue, source, severity, notes } = req.body;
  const log = loadScreeningLog();

  const subject = log.subjects.find((s: any) => s.name === subject_name);
  if (!subject) {
    res.status(404).json({ error: 'Subject not found in log' });
    return;
  }

  subject.human_findings.push({
    issue,
    source,
    severity,
    notes,
    added_at: new Date().toISOString()
  });

  saveScreeningLog(log);
  res.json({ success: true, subject });
});

// Record comparison (matches, false negatives, false positives)
app.post('/api/screening-log/comparison', (req: Request, res: Response) => {
  const { subject_name, false_negatives, false_positives, matches, notes } = req.body;
  const log = loadScreeningLog();

  const subject = log.subjects.find((s: any) => s.name === subject_name);
  if (!subject) {
    res.status(404).json({ error: 'Subject not found in log' });
    return;
  }

  subject.comparison = {
    false_negatives: false_negatives || [],
    false_positives: false_positives || [],
    matches: matches || [],
    compared_at: new Date().toISOString()
  };
  subject.notes = notes || subject.notes;

  // Add to learning log
  if (false_negatives?.length > 0 || false_positives?.length > 0) {
    log.learning_log.push({
      subject: subject_name,
      timestamp: new Date().toISOString(),
      false_negatives,
      false_positives,
      notes
    });
  }

  saveScreeningLog(log);
  res.json({ success: true, subject });
});

// Get learning insights (aggregated)
app.get('/api/screening-log/insights', (req: Request, res: Response) => {
  const log = loadScreeningLog();

  const allFalseNegatives: any[] = [];
  const allFalsePositives: any[] = [];

  for (const entry of log.learning_log) {
    allFalseNegatives.push(...(entry.false_negatives || []));
    allFalsePositives.push(...(entry.false_positives || []));
  }

  res.json({
    total_subjects: log.subjects.length,
    completed_comparisons: log.subjects.filter((s: any) => s.comparison).length,
    total_false_negatives: allFalseNegatives.length,
    total_false_positives: allFalsePositives.length,
    false_negatives: allFalseNegatives,
    false_positives: allFalsePositives
  });
});

// ============================================================
// SCREENING LOGS API
// ============================================================

// List all screening logs
app.get('/api/logs', (req: Request, res: Response) => {
  const subject = req.query.subject as string | undefined;
  const logs = listScreeningLogs(subject);
  res.json(logs);
});

// Get specific screening log
app.get('/api/logs/:subject/:runId', (req: Request, res: Response) => {
  const { subject, runId } = req.params;
  const log = loadLog(subject, runId);

  if (!log) {
    res.status(404).json({ error: 'Log not found' });
    return;
  }

  res.json(log);
});

// Get benchmark results
app.get('/api/benchmarks', (req: Request, res: Response) => {
  const subject = req.query.subject as string | undefined;
  const results = loadBenchmarkResults(subject);
  res.json(results);
});

// Get benchmark case definition
app.get('/api/benchmarks/case/:subject', (req: Request, res: Response) => {
  const { subject } = req.params;
  const benchmarkCase = getBenchmarkCase(subject);

  if (!benchmarkCase) {
    res.status(404).json({ error: 'Benchmark case not found' });
    return;
  }

  res.json(benchmarkCase);
});

// Serper key status endpoint
app.get('/api/serper-status', (_req: Request, res: Response) => {
  const manager = getSerperKeyManager();
  res.json({
    keys: manager.getStatus(),
    totalCredits: manager.getTotalCredits(),
  });
});

// Refresh Serper key balances (brings reset keys back into rotation)
app.post('/api/serper-refresh', async (_req: Request, res: Response) => {
  const manager = getSerperKeyManager();
  await manager.refreshAll();
  res.json({
    keys: manager.getStatus(),
    totalCredits: manager.getTotalCredits(),
  });
});

server.listen(PORT, async () => {
  console.log(`DD Owl running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}/ws`);
  console.log(`Search templates loaded: ${SEARCH_TEMPLATES.length}`);
  console.log(`Search engines: Serper (Google)${isBaiduAvailable() ? ' + SerpAPI (Baidu)' : ''}`);
  console.log(`Scraping: axios-first with Puppeteer fallback (100% coverage)`);

  // Fetch real Serper key balances on startup
  const manager = getSerperKeyManager();
  await manager.init();

  // Re-check balances every 6 hours (picks up key resets automatically)
  setInterval(() => {
    console.log('[SERPER] Periodic balance refresh...');
    manager.refreshAll();
  }, 6 * 60 * 60 * 1000);
});

// Cleanup browser on shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await closeBrowser();
  process.exit(0);
});
// Cache bust: 1768961515
