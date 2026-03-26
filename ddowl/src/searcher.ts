import axios from 'axios';
import { SearchResult } from './types.js';
import { searchBaidu, isBaiduAvailable } from './baiduSearcher.js';
import { getSerperKeyManager } from './serperKeyManager.js';

const SERPER_URL = 'https://google.serper.dev/search';

/**
 * Build Serper `tbs` date-range string from ISO date (YYYY-MM-DD).
 * Format: "cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY"
 */
function buildTbs(since: string): string {
  const d = new Date(since);
  const min = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const now = new Date();
  const max = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  return `cdr:1,cd_min:${min},cd_max:${max}`;
}

/**
 * Append Google `after:` operator to a query for date filtering.
 * Uses `after:YYYY-MM-DD` which is a Google search operator —
 * works via Serper since it's part of the query string itself.
 */
function appendDateFilter(query: string, since: string): string {
  return `${query} after:${since}`;
}

export interface SerperResponse {
  organic: Array<{
    title: string;
    link: string;
    snippet: string;
    position: number;
  }>;
  searchParameters: {
    q: string;
    gl: string;
    hl: string;
    num: number;
    page: number;
  };
}

export async function searchGoogle(
  query: string,
  page: number = 1,
  resultsPerPage: number = 10,
  signal?: AbortSignal,
  hl: string = 'zh-cn',
  since?: string
): Promise<SearchResult[]> {
  const manager = getSerperKeyManager();

  const attemptSearch = async (apiKey: string): Promise<SearchResult[]> => {
    const q = since ? appendDateFilter(query, since) : query;
    const body: Record<string, any> = {
      q,
      hl,
      num: resultsPerPage,
      page: page,
    };
    if (since) {
      body.tbs = buildTbs(since);
    }
    const response = await axios.post<SerperResponse>(
      SERPER_URL,
      body,
      {
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        signal,
      }
    );

    manager.recordUsage();

    if (!response.data.organic) {
      return [];
    }

    return response.data.organic.map((result) => ({
      title: result.title,
      link: result.link,
      snippet: result.snippet || '',
    }));
  };

  try {
    return await attemptSearch(manager.getActiveKey());
  } catch (error: any) {
    if (error.name === 'CanceledError' || signal?.aborted) {
      console.log(`Search cancelled for query "${query}" page ${page}`);
      return [];
    }

    // On 400/403/429 or "Not enough credits", rotate and retry once
    const status = error.response?.status;
    const message = error.response?.data?.message || '';
    if (status === 400 || status === 403 || status === 429 || message.includes('Not enough credits')) {
      try {
        const newKey = manager.rotateOnError();
        console.log(`[SERPER] Retrying query "${query}" with next key`);
        return await attemptSearch(newKey);
      } catch (retryError: any) {
        console.error(`[SERPER] Retry also failed for "${query}":`, retryError.message);
        return [];
      }
    }

    console.error(`Search error for query "${query}" page ${page}:`, error.message);
    return [];
  }
}

// Callback type for progress reporting
export type SearchProgressCallback = (event: {
  type: 'page_start' | 'page_results' | 'page_end' | 'search_complete';
  engine: 'google' | 'baidu';
  page?: number;
  maxPages?: number;
  results?: SearchResult[];
  totalSoFar?: number;
}) => void;

export async function searchAllPages(
  query: string,
  maxPages: number = 10,
  onProgress?: SearchProgressCallback,
  since?: string
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Run Serper (Google) search
  for (let page = 1; page <= maxPages; page++) {
    onProgress?.({ type: 'page_start', engine: 'google', page, maxPages });

    const results = await searchGoogle(query, page, 10, undefined, 'zh-cn', since);

    if (results.length === 0) {
      onProgress?.({ type: 'page_end', engine: 'google', page, maxPages, results: [], totalSoFar: allResults.length });
      break;
    }

    const newResults: SearchResult[] = [];
    for (const result of results) {
      if (!seenUrls.has(result.link)) {
        seenUrls.add(result.link);
        allResults.push(result);
        newResults.push(result);
      }
    }

    onProgress?.({ type: 'page_results', engine: 'google', page, maxPages, results: newResults, totalSoFar: allResults.length });

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  onProgress?.({ type: 'search_complete', engine: 'google', totalSoFar: allResults.length });
  return allResults;
}

/**
 * Search both Google (Serper) and Baidu, with progress callback
 * Runs sequentially so we can report progress in order
 */
export async function searchAllEngines(
  query: string,
  maxGooglePages: number = 10,
  maxBaiduPages: number = 3,
  onProgress?: SearchProgressCallback,
  since?: string
): Promise<SearchResult[]> {
  const seenUrls = new Set<string>();
  const allResults: SearchResult[] = [];

  // Run Google search first with progress reporting
  const googleResults = await searchAllPages(query, maxGooglePages, onProgress, since);

  // Merge Google results
  for (const result of googleResults) {
    if (!seenUrls.has(result.link)) {
      seenUrls.add(result.link);
      allResults.push(result);
    }
  }

  // Baidu disabled - Google with Chinese keywords is sufficient
  // if (isBaiduAvailable()) {
  //   const baiduResults = await searchBaiduPages(query, maxBaiduPages, onProgress);
  //   let baiduUnique = 0;
  //   for (const result of baiduResults) {
  //     if (!seenUrls.has(result.link)) {
  //       seenUrls.add(result.link);
  //       allResults.push(result);
  //       baiduUnique++;
  //     }
  //   }
  //   if (baiduUnique > 0) {
  //     onProgress?.({ type: 'search_complete', engine: 'baidu', totalSoFar: baiduUnique });
  //   }
  // }

  return allResults;
}

/**
 * Helper: Search Baidu with pagination
 */
async function searchBaiduPages(
  query: string,
  maxPages: number,
  onProgress?: SearchProgressCallback
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (let page = 1; page <= maxPages; page++) {
    onProgress?.({ type: 'page_start', engine: 'baidu', page, maxPages });

    const pageResults = await searchBaidu(query, page);
    if (pageResults.length === 0) {
      onProgress?.({ type: 'page_end', engine: 'baidu', page, maxPages, results: [], totalSoFar: results.length });
      break;
    }

    const newResults: SearchResult[] = [];
    for (const result of pageResults) {
      if (!seenUrls.has(result.link)) {
        seenUrls.add(result.link);
        results.push(result);
        newResults.push(result);
      }
    }

    onProgress?.({ type: 'page_results', engine: 'baidu', page, maxPages, results: newResults, totalSoFar: results.length });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return results;
}

// ============================================================================
// BATCH SEARCH: Run all queries, gather all URLs
// ============================================================================

export interface BatchSearchResult {
  url: string;
  title: string;
  snippet: string;
  query: string;  // the dirty word template that found this
  clusterId?: string;     // Incident cluster ID (assigned in Phase 2.5)
  clusterLabel?: string;  // Incident description (e.g., "AC Milan破产案")
}

export type BatchSearchProgressCallback = (event: {
  type: 'query_start' | 'query_page' | 'query_complete' | 'all_complete';
  queryIndex?: number;
  totalQueries?: number;
  query?: string;
  page?: number;          // Current page being fetched
  pageResults?: number;   // Results from this page
  resultsFound?: number;
  totalResultsSoFar?: number;
}) => void;

/**
 * Run all search queries (dirty word templates) and gather all URLs.
 * Searches Google (Serper) for each query.
 * This is the first step: gather everything, categorize later.
 *
 * @param nameVariants - Array of name variants to search (e.g., ["许楚家", "許楚家"])
 */
export async function searchAll(
  nameVariants: string[],
  searchTemplates: string[],
  onProgress?: BatchSearchProgressCallback,
  since?: string
): Promise<BatchSearchResult[]> {
  const allResults: BatchSearchResult[] = [];

  for (let i = 0; i < searchTemplates.length; i++) {
    const template = searchTemplates[i];

    // Build query with all name variants using OR
    // e.g., ("许楚家" OR "許楚家") 诈骗|詐騙...
    let query: string;
    if (nameVariants.length === 1) {
      query = template.replace('{NAME}', nameVariants[0]);
    } else {
      const orClause = '(' + nameVariants.map(n => `"${n}"`).join(' OR ') + ')';
      query = template.replace('"{NAME}"', orClause);
    }

    onProgress?.({
      type: 'query_start',
      queryIndex: i + 1,
      totalQueries: searchTemplates.length,
      query,
    });

    // Search Google (Serper) - up to 5 pages, stop early if no more results
    const MAX_PAGES = 10;
    const googleResults: SearchResult[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageResults = await searchGoogle(query, page, 10, undefined, 'zh-cn', since);

      // Log each page fetch
      onProgress?.({
        type: 'query_page',
        queryIndex: i + 1,
        totalQueries: searchTemplates.length,
        page,
        pageResults: pageResults.length,
      });

      if (pageResults.length === 0) {
        break; // No more results
      }

      googleResults.push(...pageResults);

      if (pageResults.length < 10) {
        break; // Last page (partial results)
      }

      // Small delay between pages
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

    // Baidu disabled for now
    // let baiduCount = 0;
    // if (hasBaidu) {
    //   const baiduResults = await searchBaidu(query, 1);
    //   for (const r of baiduResults) {
    //     allResults.push({
    //       url: r.link,
    //       title: r.title,
    //       snippet: r.snippet,
    //       query: template,
    //     });
    //     baiduCount++;
    //   }
    // }

    onProgress?.({
      type: 'query_complete',
      queryIndex: i + 1,
      totalQueries: searchTemplates.length,
      query,
      resultsFound: googleResults.length,
      totalResultsSoFar: allResults.length,
    });

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  onProgress?.({
    type: 'all_complete',
    totalResultsSoFar: allResults.length,
  });

  return allResults;
}
