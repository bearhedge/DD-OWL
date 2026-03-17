/**
 * Programmatic Noise Eliminator
 *
 * Eliminates obvious noise BEFORE sending to LLM (saves cost).
 * Government domains (.gov.cn) bypass all rules.
 */

import { BatchSearchResult } from './searcher.js';
import { hasDirtyWordMatch } from './constants/dirtyWordEquivalents.js';

// ============================================================
// TYPES
// ============================================================

export type EliminationReason =
  | 'gov_domain_bypass'      // Not eliminated - .gov.cn protected
  | 'noise_domain'           // Rule 1: job sites, corporate aggregators
  | 'trash_domain'           // Rule 1b: SEO spam, broken sites, parked domains
  | 'noise_title_pattern'    // Rule 2: job posting keywords
  | 'name_char_separation'   // Rule 3: "张,三" instead of "张三"
  | 'missing_dirty_word'     // Rule 4: no dirty word present
  | 'part_of_longer_name';   // Rule 5: 2-char name appears only as part of 3-char names

export interface EliminatedResult extends BatchSearchResult {
  reason: EliminationReason;
}

export interface EliminationResult {
  passed: BatchSearchResult[];
  eliminated: EliminatedResult[];
  bypassed: EliminatedResult[];  // .gov.cn domains (passed but tracked)
}

export interface EliminationBreakdown {
  gov_domain_bypass: number;
  noise_domain: number;
  trash_domain: number;
  noise_title_pattern: number;
  name_char_separation: number;
  missing_dirty_word: number;
  part_of_longer_name: number;
}

// ============================================================
// CONSTANTS
// ============================================================

// Noise domains - job sites and corporate aggregators
const NOISE_DOMAINS = [
  // Job sites
  'linkedin.com', 'indeed.com', '58.com', 'zhipin.com',
  'lagou.com', 'liepin.com', 'boss.zhipin.com', 'glassdoor.com',
  '51job.com', 'zhaopin.com', 'kanzhun.com',
  // Corporate aggregators (searched separately)
  'qichacha.com', 'tianyancha.com', 'qixin.com', 'aiqicha.com',
  // Problematic sites (hang, block, or return garbage)
  'xueqiu.com', 'douyin.com',
  // Wikipedia/Encyclopedia sites (general reference, not adverse media sources)
  'wikipedia.org', 'baike.baidu.com', 'baike.com', 'zh.wikipedia.org',
  'en.wikipedia.org', 'hudong.com', 'sogou.com/lemma',
  // SEC filing domains (routine filings pollute results, enforcement covered by news)
  'sec.gov', 'edgar.sec.gov',
  // Corporate registries (additional — like existing qichacha/tianyancha)
  'qcc.com',
];

// ============================================================
// TRASH DOMAIN FILTERING (Quality Layer 1)
// Known SEO spam, broken sites, parked domains
// ============================================================

// Exact trash domains - known spam/broken sites
const TRASH_DOMAINS = new Set([
  'ikcij.com',        // Fake ICIJ impersonator, broken links
  'icij-data.com',    // Another ICIJ impersonator
  'offshoreleaks.cc', // Fake offshore leaks mirror
  // Add more as discovered
]);

// Regex patterns for trash domain detection
const TRASH_DOMAIN_PATTERNS: RegExp[] = [
  // Random character domains (e.g., ab123.com, xyz99.net)
  /^[a-z]{2,4}\d{2,4}\.(com|cn|net|org)$/,
  // SEO/spam indicators in domain
  /seo[-_]?site|spam[-_]?site|click[-_]?track|redirect[-_]?link/i,
  // Parked/expired domain indicators
  /buy[-_]?domain|domain[-_]?sale|expired[-_]?domain|parked[-_]?domain/i,
  // Fake news/data leak impersonators
  /fake[-_]?news|leak[-_]?data|hack[-_]?data/i,
  // Numeric-heavy spam domains
  /^\d{3,}[a-z]*\.(com|cn|net)$/,
];

// Noise title patterns - job posting keywords
const NOISE_TITLE_PATTERNS = [
  '招聘', '职位', '求职', '简历', '应聘', '急招', '招人',
  '薪资', '薪酬', '待遇', '福利', '五险一金',
];

// ============================================================
// ELIMINATION FUNCTIONS
// ============================================================

/**
 * Rule 1: Check if URL is a noise domain
 */
function isNoiseDomain(url: string): boolean {
  if (!url) return false;
  return NOISE_DOMAINS.some(d => url.includes(d));
}

/**
 * Rule 1b: Check if URL is a trash/spam domain (SEO spam, broken sites, parked)
 */
function isTrashDomain(url: string): boolean {
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check exact match in trash domains set
    if (TRASH_DOMAINS.has(hostname)) return true;

    // Check without www. prefix
    const hostnameNoWww = hostname.replace(/^www\./, '');
    if (TRASH_DOMAINS.has(hostnameNoWww)) return true;

    // Check against regex patterns
    for (const pattern of TRASH_DOMAIN_PATTERNS) {
      if (pattern.test(hostnameNoWww)) return true;
    }

    return false;
  } catch {
    // Invalid URL - don't eliminate (let other checks handle it)
    return false;
  }
}

/**
 * Rule 2: Check if title contains noise patterns
 */
function hasNoiseTitlePattern(title: string): boolean {
  if (!title) return false;
  return NOISE_TITLE_PATTERNS.some(p => title.includes(p));
}

/**
 * Rule 3: Check if name characters appear separated by punctuation
 * E.g., "张,三" or "张;三" instead of "张三"
 */
function hasNameCharSeparation(text: string, name: string): boolean {
  // If name appears intact, not separated
  if (text.includes(name)) return false;

  const chars = name.split('');
  if (chars.length < 2) return false;

  // Check for patterns like "张,三" or "张 三" when "张三" doesn't appear
  const separatorPattern = chars.join('[,;，；、\\s]+');
  return new RegExp(separatorPattern).test(text);
}

/**
 * Rule 5: Check if 2-char name only appears as part of 3-char names
 * E.g., searching "李原" but finding "李原地" or "盛李原" (different people)
 */
function isOnlyPartOfLongerName(text: string, name: string): boolean {
  // Only applies to 2-character Chinese names
  if (name.length !== 2) return false;

  // Check if the name even appears in the text
  if (!text.includes(name)) return false;

  const chineseCharRegex = /[\u4e00-\u9fff]/;

  // Common Chinese grammatical particles that follow names (not part of names)
  const nonNameChars = ['被', '在', '的', '是', '等', '與', '与', '和', '或', '及', '為', '为', '已', '曾', '因', '于', '對', '对', '向', '从', '從'];

  let index = 0;
  let hasStandaloneOccurrence = false;

  while ((index = text.indexOf(name, index)) !== -1) {
    const charBefore = index > 0 ? text[index - 1] : '';
    const charAfter = text[index + name.length] || '';

    const hasChineBefore = chineseCharRegex.test(charBefore);
    const hasChineAfter = chineseCharRegex.test(charAfter);

    // Check if this is part of a longer name
    const isPartOfLongerBefore = hasChineBefore && !nonNameChars.includes(charBefore);
    const isPartOfLongerAfter = hasChineAfter && !nonNameChars.includes(charAfter);

    // If neither before nor after is a name character, this is a standalone occurrence
    if (!isPartOfLongerBefore && !isPartOfLongerAfter) {
      hasStandaloneOccurrence = true;
      break;
    }

    index++;
  }

  // Eliminate if ALL occurrences are part of longer names (no standalone)
  return !hasStandaloneOccurrence;
}

/**
 * Rule 4: Check if dirty words from query are missing
 * If only subject name appears but no dirty words, likely not relevant
 */
function isMissingDirtyWord(
  result: BatchSearchResult,
  subjectName: string
): boolean {
  // Extract dirty words from the search query that found this result
  // Query format: "张三" 贪污 | 贿赂 | 诈骗
  const query = result.query || '';

  // Parse dirty words from query (format: "XXX" word1 | word2 | word3)
  const dirtyWordPart = query.replace(/^"[^"]*"\s*/, '');
  const dirtyWords = dirtyWordPart
    .split('|')
    .map(w => w.trim())
    .filter(w => w.length > 0);

  // If no dirty words in query, don't eliminate (probably a site search)
  if (dirtyWords.length === 0) return false;

  // Check if text contains subject name
  const text = `${result.title || ''} ${result.snippet || ''}`;
  const hasName = text.includes(subjectName);

  // If name doesn't appear, let LLM decide (might still be relevant)
  if (!hasName) return false;

  // Check if any dirty word (or equivalent) appears
  const hasDirtyWord = hasDirtyWordMatch(text, dirtyWords);

  // Eliminate if: has name but no dirty word
  return !hasDirtyWord;
}

// ============================================================
// MAIN ELIMINATION FUNCTION
// ============================================================

/**
 * Eliminate obvious noise from search results.
 * Government domains (.gov.cn) bypass all rules.
 */
export function eliminateObviousNoise(
  results: BatchSearchResult[],
  subjectName: string,
  nameVariations: string[] = []
): EliminationResult {
  const passed: BatchSearchResult[] = [];
  const eliminated: EliminatedResult[] = [];
  const bypassed: EliminatedResult[] = [];

  for (const result of results) {
    // Rule 1: Noise domains
    if (isNoiseDomain(result.url)) {
      eliminated.push({ ...result, reason: 'noise_domain' });
      continue;
    }

    // Rule 1b: Trash domains (SEO spam, broken sites, parked domains)
    if (isTrashDomain(result.url)) {
      eliminated.push({ ...result, reason: 'trash_domain' });
      continue;
    }

    // Rule 2: Noise title patterns
    if (hasNoiseTitlePattern(result.title)) {
      eliminated.push({ ...result, reason: 'noise_title_pattern' });
      continue;
    }

    // Rule 3: Name character separation
    const text = `${result.title || ''} ${result.snippet || ''}`;
    if (hasNameCharSeparation(text, subjectName)) {
      eliminated.push({ ...result, reason: 'name_char_separation' });
      continue;
    }

    // Rule 4: DISABLED - was too aggressive, eliminating relevant adverse media
    // Articles found by one category query but containing another category were being eliminated
    // Let the LLM analyze all results properly instead
    // if (isMissingDirtyWord(result, subjectName)) {
    //   eliminated.push({ ...result, reason: 'missing_dirty_word' });
    //   continue;
    // }

    // Rule 5: 2-char name only appears as part of 3-char names (different person)
    if (isOnlyPartOfLongerName(text, subjectName)) {
      eliminated.push({ ...result, reason: 'part_of_longer_name' });
      continue;
    }

    // Rule 5b: Same check for name variations (e.g., 高志 only appears as 高志凱)
    if (nameVariations.length > 0) {
      const variationIsLongerName = nameVariations.some(variation =>
        variation !== subjectName &&
        variation.length === 2 &&
        text.includes(variation) &&
        isOnlyPartOfLongerName(text, variation)
      );
      if (variationIsLongerName) {
        eliminated.push({ ...result, reason: 'part_of_longer_name' });
        continue;
      }
    }

    // Passed all rules
    passed.push(result);
  }

  return { passed, eliminated, bypassed };
}

/**
 * Get breakdown of elimination reasons
 */
export function getEliminationBreakdown(
  eliminated: EliminatedResult[],
  bypassed: EliminatedResult[]
): EliminationBreakdown {
  return {
    gov_domain_bypass: bypassed.length,
    noise_domain: eliminated.filter(e => e.reason === 'noise_domain').length,
    trash_domain: eliminated.filter(e => e.reason === 'trash_domain').length,
    noise_title_pattern: eliminated.filter(e => e.reason === 'noise_title_pattern').length,
    name_char_separation: eliminated.filter(e => e.reason === 'name_char_separation').length,
    missing_dirty_word: eliminated.filter(e => e.reason === 'missing_dirty_word').length,
    part_of_longer_name: eliminated.filter(e => e.reason === 'part_of_longer_name').length,
  };
}

// ============================================================
// LLM-BASED TITLE DEDUPLICATION (Phase 1.75)
// Batch process titles to identify duplicates before clustering
// ============================================================

import axios from 'axios';

const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

export interface TitleDedupeResult {
  unique: BatchSearchResult[];
  duplicates: BatchSearchResult[];
  groups: number[][]; // Groups of duplicate indices
}

export interface TitleDedupeProgress {
  batchNumber: number;
  totalBatches: number;
  processedSoFar: number;
  totalItems: number;
  duplicatesFound: number;
}

/**
 * LLM-based batch title deduplication
 * Groups articles with semantically similar titles (same event/story)
 * Keeps the first (usually highest-ranked) article from each group
 */
export async function llmBatchTitleDedupe(
  results: BatchSearchResult[],
  onProgress?: (progress: TitleDedupeProgress) => void | Promise<void>
): Promise<TitleDedupeResult> {
  if (results.length === 0) {
    return { unique: [], duplicates: [], groups: [] };
  }

  // Skip if no API keys configured
  if (!KIMI_API_KEY && !DEEPSEEK_API_KEY) {
    console.log('[TITLE_DEDUPE] No API keys configured, skipping LLM dedupe');
    return { unique: results, duplicates: [], groups: [] };
  }

  const BATCH_SIZE = 100; // Process 100 titles per LLM call
  const allGroups: number[][] = [];
  const globalDuplicateIndices = new Set<number>();
  let totalDuplicatesFound = 0;

  const totalBatches = Math.ceil(results.length / BATCH_SIZE);

  for (let batchStart = 0; batchStart < results.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, results.length);
    const batch = results.slice(batchStart, batchEnd);
    const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1;

    console.log(`[TITLE_DEDUPE] Processing batch ${batchNumber}/${totalBatches} (${batch.length} titles)`);

    try {
      const groups = await findDuplicateTitlesLLM(batch, batchStart);

      // Track duplicates (all but first in each group)
      for (const group of groups) {
        if (group.length > 1) {
          allGroups.push(group);
          // Mark all but first as duplicates
          for (let i = 1; i < group.length; i++) {
            globalDuplicateIndices.add(group[i]);
            totalDuplicatesFound++;
          }
        }
      }
    } catch (error: any) {
      console.error(`[TITLE_DEDUPE] Batch ${batchNumber} failed:`, error.message);
      // Continue with other batches on failure
    }

    // Progress callback
    if (onProgress) {
      await onProgress({
        batchNumber,
        totalBatches,
        processedSoFar: batchEnd,
        totalItems: results.length,
        duplicatesFound: totalDuplicatesFound,
      });
    }
  }

  // Split into unique and duplicates
  const unique: BatchSearchResult[] = [];
  const duplicates: BatchSearchResult[] = [];

  for (let i = 0; i < results.length; i++) {
    if (globalDuplicateIndices.has(i)) {
      duplicates.push(results[i]);
    } else {
      unique.push(results[i]);
    }
  }

  console.log(`[TITLE_DEDUPE] Complete: ${unique.length} unique, ${duplicates.length} duplicates removed`);
  return { unique, duplicates, groups: allGroups };
}

/**
 * Call LLM to find duplicate titles in a batch
 * Returns groups of indices that refer to the same article/event
 */
async function findDuplicateTitlesLLM(
  batch: BatchSearchResult[],
  globalOffset: number
): Promise<number[][]> {
  // Format titles as numbered list
  const titlesText = batch.map((r, i) => `${i + 1}. ${r.title}`).join('\n');

  const prompt = `Identify DUPLICATE articles from these search result titles. Articles are duplicates if they report the SAME specific news event (same incident, same companies/people, same actions).

TITLES:
${titlesText}

Rules:
- Group titles that report the EXACT SAME event (just different sources/wording)
- Different events about the same person/company are NOT duplicates
- If unsure, do NOT group them

Return JSON only:
{"groups": [[1,5,8], [3,12], [4,9,15]]}

Where each array contains indices of duplicate titles. Only include groups with 2+ items.
If no duplicates found, return: {"groups": []}`;

  const providers = [];
  if (DEEPSEEK_API_KEY) {
    providers.push({
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKey: DEEPSEEK_API_KEY,
    });
  }

  let rawText = '';
  for (const provider of providers) {
    try {
      const response = await axios.post(
        provider.url,
        {
          model: provider.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1000,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
          },
          timeout: 60000,
        }
      );
      rawText = response.data.choices?.[0]?.message?.content || '';
      console.log(`[TITLE_DEDUPE] ${provider.name} succeeded`);
      break;
    } catch (error: any) {
      console.error(`[TITLE_DEDUPE] ${provider.name} failed:`, error.message);
      continue;
    }
  }

  if (!rawText) {
    return [];
  }

  // Parse JSON response
  try {
    const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.groups || !Array.isArray(parsed.groups)) return [];

    // Convert local indices to global indices
    const globalGroups: number[][] = [];
    for (const group of parsed.groups) {
      if (Array.isArray(group) && group.length > 1) {
        const globalGroup = group
          .filter((idx: number) => idx >= 1 && idx <= batch.length)
          .map((idx: number) => globalOffset + idx - 1); // Convert 1-indexed to 0-indexed global
        if (globalGroup.length > 1) {
          globalGroups.push(globalGroup);
        }
      }
    }

    return globalGroups;
  } catch (error) {
    console.error('[TITLE_DEDUPE] Failed to parse LLM response:', error);
    return [];
  }
}
