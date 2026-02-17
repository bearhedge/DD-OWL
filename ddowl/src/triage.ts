// src/triage.ts
import axios from 'axios';

// LLM Configuration for Triage with Fallback Chain
// Priority: Kimi (primary, no content blocks) → DeepSeek (fallback)
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

interface LLMProvider {
  name: string;
  url: string;
  model: string;
  apiKey: string;
  timeout: number;
  isGemini?: boolean;
}

// Build provider list in priority order (only include configured providers)
function getProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  // 1. Kimi K2 (PRIMARY - no content moderation blocks on Chinese adverse media)
  if (KIMI_API_KEY) {
    providers.push({
      name: 'Kimi K2',
      url: 'https://api.moonshot.ai/v1/chat/completions',
      model: 'kimi-k2',
      apiKey: KIMI_API_KEY,
      timeout: 120000,
    });
  }

  // 2. DeepSeek (fallback)
  if (DEEPSEEK_API_KEY) {
    providers.push({
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKey: DEEPSEEK_API_KEY,
      timeout: 120000,
    });
  }

  return providers;
}

// Check if error is content moderation related (should trigger fallback)
function isContentModerationError(error: any): boolean {
  const errorMessage = error?.response?.data?.error?.message || error?.message || '';
  const errorCode = error?.response?.data?.error?.code || '';

  // DeepSeek content moderation
  if (errorMessage.includes('Content Exists Risk')) return true;
  if (errorCode === 'content_filter') return true;

  // Kimi content moderation
  if (errorMessage.includes('content policy')) return true;
  if (errorMessage.includes('sensitive')) return true;

  // Rate limits should also trigger fallback
  if (error?.response?.status === 429) return true;

  return false;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface TriageResult {
  url: string;
  title: string;
  classification: 'RED' | 'YELLOW' | 'GREEN';
  reason: string;
}

export interface TriageOutput {
  red: TriageResult[];
  yellow: TriageResult[];
  green: TriageResult[];
}

// Helper to call Gemini API (different format from OpenAI-compatible APIs)
async function callGeminiAPI(provider: LLMProvider, prompt: string): Promise<string> {
  const response = await axios.post(
    `${provider.url}?key=${provider.apiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: provider.timeout,
    }
  );
  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Helper to call OpenAI-compatible APIs (DeepSeek, Kimi)
async function callOpenAICompatibleAPI(provider: LLMProvider, prompt: string): Promise<string> {
  const response = await axios.post(
    provider.url,
    {
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      timeout: provider.timeout,
    }
  );
  return response.data.choices?.[0]?.message?.content || '';
}

export async function triageSearchResults(
  results: SearchResult[],
  subjectName: string
): Promise<TriageOutput> {
  if (results.length === 0) {
    return { red: [], yellow: [], green: [] };
  }

  const providers = getProviders();
  if (providers.length === 0) {
    return {
      red: [],
      yellow: results.map(r => ({ ...r, classification: 'YELLOW' as const, reason: 'no api keys configured' })),
      green: []
    };
  }

  const resultsText = results.map((r, i) =>
    `${i + 1}. Title: ${r.title}\n   Snippet: ${r.snippet}`
  ).join('\n\n');

  const prompt = `You are a senior due diligence analyst screening search results about "${subjectName}".

⚠️ CRITICAL RULE - READ CAREFULLY:
The EXACT name "${subjectName}" MUST appear in the title or snippet to be flagged RED or YELLOW.
If the article is about a DIFFERENT person (e.g., 罗保铭, 王建祥, 张新起), mark it GREEN even if it contains crime keywords.
Do NOT flag articles just because they contain words like "corruption", "bribery", "fraud" - the subject name MUST be present.

CLASSIFICATION RULES:

1. NAME DETECTION - Does the exact name "${subjectName}" appear in title or snippet?
   NO → GREEN with reason "No name match" (STOP HERE - do not continue)
   YES → Continue to step 2

2. SUBJECT VERIFICATION - Is it about "${subjectName}" or a different person?
   Article is about someone else → GREEN "Different individual"
   Cannot determine → YELLOW "Name match - verify identity"
   Confirmed about "${subjectName}" → Continue to step 3

3. ADVERSE CONTENT - What type of content about "${subjectName}"?
   Clearly adverse (crime, fraud, sanctions, arrest) → RED with specific reason
   Possibly adverse or unclear → YELLOW with specific reason
   Neutral/positive content → GREEN "Neutral mention"

USE THESE STANDARD REASONS:
GREEN reasons:
- "No name match" (name not found)
- "Different individual" (clearly different person)
- "Neutral mention" (same person, no adverse info)
- "Partial match only" (name is substring of other text)

YELLOW reasons:
- "Name match - verify identity" (name found but cannot confirm same person)
- "Name match - context unclear" (same person but unclear if adverse)
- "Possible adverse mention" (hints at issues, needs verification)

RED reasons:
- "Criminal activity mentioned" (crime, fraud, theft)
- "Regulatory action mentioned" (sanctions, fines, bans)
- "Legal proceedings mentioned" (lawsuit, prosecution, arrest)
- "Financial misconduct mentioned" (fraud, manipulation, embezzlement)

SEARCH RESULTS:
${resultsText}

Return JSON only:
{
  "classifications": [
    {"index": 1, "classification": "GREEN", "reason": "No name match"},
    {"index": 2, "classification": "YELLOW", "reason": "Name match - verify identity"},
    {"index": 3, "classification": "RED", "reason": "Criminal activity mentioned"}
  ]
}`;

  // Try each provider in order until one succeeds
  let rawText = '';
  let lastError = '';

  for (const provider of providers) {
    console.log(`[PRE-SCREEN] Trying ${provider.name} (${provider.model})...`);

    try {
      if (provider.isGemini) {
        rawText = await callGeminiAPI(provider, prompt);
      } else {
        rawText = await callOpenAICompatibleAPI(provider, prompt);
      }

      console.log(`[PRE-SCREEN] ✓ ${provider.name} succeeded`);
      break; // Success! Exit the loop

    } catch (error: any) {
      const errorMessage = error?.response?.data?.error?.message
        || error?.response?.status
        || error?.message
        || 'unknown error';

      console.error(`[PRE-SCREEN] ✗ ${provider.name} failed: ${errorMessage}`);
      lastError = `${provider.name}: ${errorMessage}`;

      // Check if we should try the next provider
      if (isContentModerationError(error)) {
        console.log(`[PRE-SCREEN] Content moderation error, trying next provider...`);
        continue;
      }

      // For other errors (network, timeout), also try next provider
      continue;
    }
  }

  // If all providers failed
  if (!rawText) {
    console.error(`[PRE-SCREEN] All providers failed. Last error: ${lastError}`);
    return {
      red: [],
      yellow: results.map(r => ({ ...r, classification: 'YELLOW' as const, reason: `all apis failed: ${lastError}` })),
      green: []
    };
  }
  console.log('Triage LLM response (first 500 chars):', rawText.slice(0, 500));

  // Strip markdown code blocks that DeepSeek wraps around JSON
  const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Fallback: treat all as YELLOW
    console.error('No JSON found in triage response. Full text:', text);
    return {
      red: [],
      yellow: results.map(r => ({ ...r, classification: 'YELLOW' as const, reason: 'parse failed' })),
      green: []
    };
  }

  // Fix #2: Wrap JSON.parse in try-catch for malformed JSON
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return {
      red: [],
      yellow: results.map(r => ({ ...r, classification: 'YELLOW' as const, reason: 'parse failed' })),
      green: []
    };
  }

  // Fix #3: Validate that parsed.classifications exists and is an array
  if (!parsed.classifications || !Array.isArray(parsed.classifications)) {
    return {
      red: [],
      yellow: results.map(r => ({ ...r, classification: 'YELLOW' as const, reason: 'parse failed' })),
      green: []
    };
  }

  const output: TriageOutput = { red: [], yellow: [], green: [] };

  for (const c of parsed.classifications) {
    const result = results[c.index - 1];
    if (!result) continue;

    // Fix #4: Normalize classification to uppercase and validate
    const normalizedClassification = typeof c.classification === 'string'
      ? c.classification.toUpperCase()
      : 'YELLOW';
    const validClassification = ['RED', 'YELLOW', 'GREEN'].includes(normalizedClassification)
      ? normalizedClassification as 'RED' | 'YELLOW' | 'GREEN'
      : 'YELLOW';

    const triaged: TriageResult = {
      url: result.url,
      title: result.title,
      classification: validClassification,
      reason: c.reason
    };

    if (validClassification === 'RED') output.red.push(triaged);
    else if (validClassification === 'YELLOW') output.yellow.push(triaged);
    else output.green.push(triaged);
  }

  return output;
}

// ============================================================================
// BATCH CATEGORIZATION: Single LLM call for all search results
// ============================================================================

import { BatchSearchResult } from './searcher.js';

// ============================================================================
// IRRELEVANT DOMAIN DETECTION
// Filter out social media, music platforms, and other non-DD-relevant sites
// ============================================================================

/**
 * Domains that are irrelevant for due diligence screening
 * These sites contain personal profiles, music, social posts - not adverse media
 */
const IRRELEVANT_DOMAINS = [
  // Social Media (excluding LinkedIn - useful for professional info)
  'instagram.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'fb.com',
  'tiktok.com',
  'weibo.com',
  'xiaohongshu.com',
  'threads.net',
  'pinterest.com',
  'snapchat.com',

  // Music Platforms
  'music.apple.com',
  'open.spotify.com',
  'spotify.com',
  'soundcloud.com',
  'music.163.com',      // NetEase Music
  'y.qq.com',           // QQ Music
  'kugou.com',
  'kuwo.cn',
  'deezer.com',
  'tidal.com',
  'bandcamp.com',

  // Video/Streaming (entertainment, not news)
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'douyin.com',
  'ixigua.com',
  'vimeo.com',
  'twitch.tv',
  'netflix.com',
  'iqiyi.com',
  'youku.com',
  'v.qq.com',

  // E-commerce / Shopping
  'taobao.com',
  'tmall.com',
  'jd.com',
  'amazon.com',
  'amazon.cn',
  'ebay.com',
  'aliexpress.com',

  // Generic Profile / Directory Sites
  'gravatar.com',
  'about.me',
  'linktree.com',
  'linktr.ee',
  'carrd.co',
  'bio.link',

  // App Stores
  'apps.apple.com',
  'play.google.com',

  // Image Hosting
  'imgur.com',
  'flickr.com',
  'unsplash.com',

  // Forums / Q&A (usually not authoritative sources)
  'quora.com',
  'zhihu.com',
  'reddit.com',

  // Dating / Personal
  'tinder.com',
  'bumble.com',
];

/**
 * Check if URL is from an irrelevant domain for DD purposes
 */
function isIrrelevantDomain(url: string): boolean {
  const urlLower = url.toLowerCase();

  for (const domain of IRRELEVANT_DOMAINS) {
    // Match domain in URL (handles subdomains too)
    if (urlLower.includes(domain)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// FICTION/ENTERTAINMENT DETECTION
// Detect fiction content (novels, TV dramas, movies) to mark as GREEN
// ============================================================================

/**
 * Detect if content is fiction/entertainment (novels, TV dramas, movies)
 * These should be marked GREEN as they're not real adverse media
 */
function isFiction(item: { title: string; snippet: string; url: string }): boolean {
  const text = `${item.title} ${item.snippet || ''}`;
  const url = item.url.toLowerCase();

  // URL signals - entertainment/novel sites
  if (url.includes('linovel') || url.includes('lightnovel') || url.includes('novel') ||
      url.includes('/entertainment/') || url.includes('/tvshow/') || url.includes('/drama/')) return true;

  // Chinese content signals for fiction/entertainment
  const fictionKeywords = [
    // TV/Film
    '电视剧', '連續劇', '剧集', '综艺', '綜藝',
    // Novels
    '小说', '小說', '轻小说', '輕小說', '网络小说', '網絡小說',
    // Acting/Performance
    '饰演', '飾演', '主演', '出演', '演员', '演員', '导演', '導演',
    // Plot/Character
    '剧情', '劇情', '角色', '虚构', '虛構', '剧透', '劇透',
    // Episode indicators
    '大结局', '大結局',
  ];

  for (const kw of fictionKeywords) {
    if (text.includes(kw)) return true;
  }

  // Episode pattern: 第X集
  if (/第\d+集/.test(text)) return true;

  // Book/show title format: starts with 《 and contains 》
  if (text.startsWith('《') && text.includes('》')) return true;

  return false;
}

/**
 * Detect stock exchange regulatory filing boilerplate that contains standard legal language
 * (criminal fraud, money laundering, etc.) but is NOT actual adverse media.
 *
 * Covers: HKEX (港交所), SSE (上交所), SZSE (深交所), and CSRC filing platforms.
 *
 * Key distinction:
 * - Boilerplate: "Risk Factors", "Prospectus", "Listing Document" with template legal language
 * - Real adverse: "disciplinary action", "enforcement", "censure" naming the subject specifically
 */
function isStockExchangeBoilerplate(item: { title: string; snippet: string; url: string }): boolean {
  const url = item.url.toLowerCase();

  // Stock exchange and regulatory filing domains
  const exchangeDomains = [
    'hkexnews.hk', 'hkex.com.hk',           // HKEX (Hong Kong)
    'sse.com.cn',                              // SSE (Shanghai)
    'szse.cn', 'szse.com.cn',                  // SZSE (Shenzhen)
    'cninfo.com.cn',                           // 巨潮资讯网 (CSRC filing platform)
    'csrc.gov.cn',                             // CSRC (China Securities Regulatory Commission)
  ];

  const isExchangeDomain = exchangeDomains.some(d => url.includes(d));
  if (!isExchangeDomain) return false;

  const text = `${item.title} ${item.snippet || ''}`;
  const textLower = text.toLowerCase();

  // Boilerplate document indicators in title/snippet (EN + Traditional Chinese + Simplified Chinese)
  const boilerplateIndicators = [
    // Document types
    'prospectus', '招股', '招股書', '招股书', '招股章程',
    'listing document', '上市文件',
    'circular', '通函',
    'annual report', '年報', '年报', '年度報告', '年度报告',
    'interim report', '中期報告', '中期报告',
    'quarterly report', '季度報告', '季度报告',
    // Standard sections
    'risk factors', '風險因素', '风险因素',
    'disclosure of interests', '權益披露', '权益披露',
    'regulatory overview', '監管概覽', '监管概览',
    'statutory and general information', '法定及一般資料', '法定及一般资料',
    // Form types
    'form a', 'form b', 'form c',
    // Template language patterns
    'summary of the constitution', '章程概要',
    '公司章程', '公司治理', '董事會報告', '董事会报告',
    '管理層討論', '管理层讨论',
    // Mainland-specific filing types
    '配股说明书', '配股說明書',
    '债券募集说明书', '債券募集說明書',
    '公开发行', '公開發行',
    '信息披露', '資訊披露',
  ];

  const hasBoilerplateIndicator = boilerplateIndicators.some(ind => textLower.includes(ind) || text.includes(ind));

  if (!hasBoilerplateIndicator) return false;

  // If it IS a regulatory filing, check if it's actually an enforcement/disciplinary action
  // These should NOT be filtered — they're real adverse findings
  const enforcementIndicators = [
    'disciplinary action', '紀律行動', '纪律行动',
    'enforcement', '執法', '执法',
    'censure', '譴責', '谴责',
    'fine imposed', '罰款', '罚款',
    'suspended from trading', '停牌',
    'delisting', '除牌',
    'winding up', '清盤', '清盘',
    // Mainland enforcement terms
    '行政处罚', '行政處罰',
    '立案调查', '立案調查',
    '监管措施', '監管措施',
    '警示函', '责令改正', '責令改正',
    '市场禁入', '市場禁入',
  ];

  const isEnforcement = enforcementIndicators.some(ind => textLower.includes(ind) || text.includes(ind));

  // If enforcement language present, do NOT filter — let it through for analysis
  if (isEnforcement) return false;

  return true;  // It's boilerplate, filter it out
}

/**
 * Detect promotional/corporate content that contains regulatory keywords in neutral context.
 * Catches conference announcements, business profiles, awards, interviews, etc.
 * Only filters when NO enforcement/adverse keywords are present — safe by design.
 */
function isPromotionalContent(item: { title: string; snippet: string; url: string }): boolean {
  const text = `${item.title} ${item.snippet || ''}`;

  // Conference / forum / summit announcements
  const conferencePatterns = [
    '论坛', '峰会', '大会', '年会', '研讨会', '座谈会',
    'conference', 'summit', 'forum', 'symposium',
  ];

  // Business profile / ranking / award content
  const profilePatterns = [
    '创业故事', '创始人故事', '企业家精神', '成功之道',
    '排行榜', '富豪榜', '影响力人物', '年度人物', '风云人物',
    '颁奖', '荣获', '获奖', '入选',
    'award', 'ranking', 'top 100', 'entrepreneur',
  ];

  // Book / interview / speech content
  const editorialPatterns = [
    '新书', '著作', '专访', '對話', '对话', '演讲', '演講',
    '心得', '感悟', '分享', 'interview', 'keynote', 'book',
  ];

  const allPatterns = [...conferencePatterns, ...profilePatterns, ...editorialPatterns];
  const hasPromotionalSignal = allPatterns.some(p => text.toLowerCase().includes(p.toLowerCase()));
  if (!hasPromotionalSignal) return false;

  // Only filter if NO enforcement/adverse keywords are present
  const adverseKeywords = [
    '处罚', '罚款', '逮捕', '判刑', '诈骗', '洗钱', '行贿', '受贿',
    '腐败', '贪污', '制裁', '黑名单', '起诉', '拘留',
    'fraud', 'arrest', 'sanction', 'penalty', 'convicted', 'indicted',
  ];
  const hasAdverse = adverseKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));

  return !hasAdverse;
}

/**
 * Combined check: is this URL irrelevant for DD screening?
 */
function shouldSkipUrl(item: { title: string; snippet: string; url: string }): { skip: boolean; reason: string } {
  // Check domain blocklist first (fast)
  if (isIrrelevantDomain(item.url)) {
    return { skip: true, reason: 'Irrelevant domain (social/music/video)' };
  }

  // Check fiction content
  if (isFiction(item)) {
    return { skip: true, reason: 'Fiction/Entertainment content' };
  }

  // Check stock exchange regulatory filing boilerplate
  if (isStockExchangeBoilerplate(item)) {
    return { skip: true, reason: 'Stock exchange regulatory filing boilerplate' };
  }

  // Check promotional/corporate content (conferences, awards, interviews)
  if (isPromotionalContent(item)) {
    return { skip: true, reason: 'Promotional/corporate content' };
  }

  return { skip: false, reason: '' };
}

export interface CategorizedResult {
  url: string;
  title: string;
  snippet: string;
  query: string;
  category: 'RED' | 'AMBER' | 'GREEN';
  reason: string;
  clusterId?: string;     // From Phase 2.5 incident clustering
  clusterLabel?: string;  // Incident description from clustering
}

export interface CategorizedOutput {
  red: CategorizedResult[];
  amber: CategorizedResult[];
  green: CategorizedResult[];
}

/**
 * Categorize a batch of search results (max 50 at a time to stay under token limits)
 */
async function categorizeBatch(
  results: BatchSearchResult[],
  subjectName: string,
  batchOffset: number = 0
): Promise<CategorizedOutput> {
  const output: CategorizedOutput = { red: [], amber: [], green: [] };

  // Pre-filter: Mark irrelevant domains and fiction/entertainment as GREEN before LLM call
  const relevant: BatchSearchResult[] = [];
  let skippedCount = 0;
  for (const r of results) {
    const skipCheck = shouldSkipUrl({ title: r.title, snippet: r.snippet || '', url: r.url });
    if (skipCheck.skip) {
      output.green.push({ ...r, category: 'GREEN' as const, reason: skipCheck.reason });
      skippedCount++;
    } else {
      relevant.push(r);
    }
  }

  if (skippedCount > 0) {
    console.log(`[CATEGORIZE] Pre-filtered ${skippedCount} irrelevant URLs (social media, music, fiction)`);
  }

  // If all items were filtered, return early
  if (relevant.length === 0) {
    return output;
  }

  const providers = getProviders();
  if (providers.length === 0) {
    return {
      red: [],
      amber: relevant.map(r => ({ ...r, category: 'AMBER' as const, reason: 'no api keys configured' })),
      green: output.green
    };
  }

  // Format non-fiction results as numbered list
  const resultsText = relevant.map((r, i) =>
    `${i + 1}. Title: ${r.title.slice(0, 80)}\n   Snippet: ${(r.snippet || '').slice(0, 150)}`
  ).join('\n\n');

  const prompt = `Categorize ${results.length} search results about "${subjectName}" as RED/AMBER/GREEN.

CHINESE ADVERSE KEYWORDS - FLAG THESE:
RED (severe):
- 腐败/贪污/贿赂/受贿/行贿 = corruption/bribery
- 诈骗/欺诈/骗取 = fraud
- 洗钱 = money laundering
- 非法集资/非法吸收 = illegal fundraising
- 判刑/入狱/拘留/逮捕 = sentenced/imprisoned/detained/arrested
- 制裁/黑名单 = sanctions/blacklist

AMBER (investigate):
- 证监会/SFC/监管 = regulatory body mention
- 股权集中/异常交易 = concentration warning/unusual trading
- 调查/涉嫌/被查 = investigation/suspected/under inquiry
- 诉讼/起诉/纠纷 = lawsuit/prosecution/dispute
- 债务/欠款/违约 = debt/default
- 内幕交易 = insider trading

GREEN: No adverse keywords, different person, neutral business news

IMPORTANT CONTEXT RULES:
- Press releases, conference announcements, business profiles, investment reports, and award ceremonies are GREEN even if they mention regulatory terms in a business context
- "监管" (regulation) in "regulatory overview" or "regulatory environment" is GREEN — it's descriptive, not enforcement
- "证监会" in "filed with 证监会" or "approved by 证监会" is GREEN — routine filings
- Only flag AMBER/RED when the keyword indicates ACTUAL misconduct, enforcement, or legal trouble targeting the subject
- SEC/证监会 filings, prospectuses, and annual reports are routine corporate governance — mark GREEN
- If the SAME incident appears multiple times from different sources, only the first mention matters — duplicates of the same story should get the same category

If title/snippet contains adverse keywords about "${subjectName}" indicating ACTUAL enforcement or misconduct, mark RED or AMBER accordingly. Do NOT mark GREEN if genuine adverse keywords are present.

RESULTS:
${resultsText}

Return JSON only:
{"classifications":[{"index":1,"category":"GREEN","reason":"neutral"},{"index":2,"category":"RED","reason":"corruption mentioned"}]}`;

  let rawText = '';
  for (const provider of providers) {
    console.log(`[CATEGORIZE] Batch at offset ${batchOffset}: trying ${provider.name}...`);
    try {
      rawText = provider.isGemini
        ? await callGeminiAPI(provider, prompt)
        : await callOpenAICompatibleAPI(provider, prompt);
      console.log(`[CATEGORIZE] ✓ ${provider.name} succeeded`);
      break;
    } catch (error: any) {
      console.error(`[CATEGORIZE] ✗ ${provider.name} failed: ${error.message}`);
      continue;
    }
  }

  if (!rawText) {
    return { red: [], amber: relevant.map(r => ({ ...r, category: 'AMBER' as const, reason: 'api failed' })), green: output.green };
  }

  // Parse response
  const text = rawText.replace(/```json\s*/gi, '').replace(/```/g, '');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { red: [], amber: relevant.map(r => ({ ...r, category: 'AMBER' as const, reason: 'parse failed' })), green: output.green };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { red: [], amber: relevant.map(r => ({ ...r, category: 'AMBER' as const, reason: 'parse failed' })), green: output.green };
  }

  if (!parsed.classifications || !Array.isArray(parsed.classifications)) {
    console.error(`[CATEGORIZE] No classifications array in response`);
    return { red: [], amber: relevant.map(r => ({ ...r, category: 'AMBER' as const, reason: 'parse failed' })), green: output.green };
  }

  console.log(`[CATEGORIZE] Got ${parsed.classifications.length} classifications for ${relevant.length} items (${results.length - relevant.length} fiction filtered)`);

  // Track which items got classified
  const classifiedIndices = new Set<number>();

  for (const c of parsed.classifications) {
    const result = relevant[c.index - 1];
    if (!result) continue;
    classifiedIndices.add(c.index - 1);
    const cat = (typeof c.category === 'string' ? c.category.toUpperCase() : 'AMBER') as 'RED' | 'AMBER' | 'GREEN';
    const validCat = ['RED', 'AMBER', 'GREEN'].includes(cat) ? cat : 'AMBER';
    const categorized = { ...result, category: validCat, reason: c.reason || 'no reason' };
    if (validCat === 'RED') output.red.push(categorized);
    else if (validCat === 'AMBER') output.amber.push(categorized);
    else output.green.push(categorized);
  }

  // Any items not classified default to AMBER (investigate)
  for (let i = 0; i < relevant.length; i++) {
    if (!classifiedIndices.has(i)) {
      console.warn(`[CATEGORIZE] Item ${i + 1} not classified, defaulting to AMBER: ${relevant[i].title?.slice(0, 50)}`);
      output.amber.push({ ...relevant[i], category: 'AMBER', reason: 'not classified by model' });
    }
  }

  return output;
}

/**
 * Categorize ALL search results in batches to avoid token limits.
 */
export interface BatchProgress {
  batchNumber: number;
  totalBatches: number;
  batchSize: number;
  processedSoFar: number;
  totalItems: number;
  batchResult: CategorizedOutput;
}

export async function categorizeAll(
  results: BatchSearchResult[],
  subjectName: string,
  onBatchComplete?: (progress: BatchProgress) => void | Promise<void>  // Allow async callbacks
): Promise<CategorizedOutput> {
  if (results.length === 0) {
    return { red: [], amber: [], green: [] };
  }

  const BATCH_SIZE = 50;
  const output: CategorizedOutput = { red: [], amber: [], green: [] };
  const totalBatches = Math.ceil(results.length / BATCH_SIZE);

  // Process in batches
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[CATEGORIZE] Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)`);

    const batchResult = await categorizeBatch(batch, subjectName, i);
    output.red.push(...batchResult.red);
    output.amber.push(...batchResult.amber);
    output.green.push(...batchResult.green);

    // Fire callback after each batch to allow progress reporting (await for async callbacks)
    if (onBatchComplete) {
      await onBatchComplete({
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        processedSoFar: Math.min(i + BATCH_SIZE, results.length),
        totalItems: results.length,
        batchResult,
      });
    }
  }

  console.log(`[CATEGORIZE] Done: ${output.red.length} RED, ${output.amber.length} AMBER, ${output.green.length} GREEN`);
  return output;
}
