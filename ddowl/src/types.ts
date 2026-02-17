export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface AnalyzedResult {
  url: string;
  title: string;
  snippet: string;
  isAdverse: boolean;
  severity: 'RED' | 'AMBER' | 'GREEN' | 'REVIEW';
  headline: string;
  summary: string;
  searchTerm: string;
  category: string;
}

export interface DDOwlReport {
  subject: string;
  timestamp: string;
  searchesCompleted: number;
  totalResultsAnalyzed: number;
  flags: {
    red: AnalyzedResult[];
    amber: AnalyzedResult[];
    green: number;
  };
  recommendedAction: string;
}

// New report format with consolidated issues and footnotes
export interface Issue {
  issueType: string;
  headline: string;
  narrative: string;  // Contains ^1^ style footnotes
  sources: string[];
}

export interface DDOwlReportV2 {
  subject: string;
  timestamp: string;
  searchesCompleted: number;
  articlesAnalyzed: number;
  issues: Issue[];
  overallRisk: 'RED' | 'AMBER' | 'GREEN';
  recommendedAction: string;
}

export interface ProgressUpdate {
  type: 'progress' | 'result' | 'complete' | 'error';
  searchIndex?: number;
  totalSearches?: number;
  currentTerm?: string;
  result?: AnalyzedResult;
  report?: DDOwlReport;
  message?: string;
}

// Fingerprint for deduplication
export interface FindingFingerprint {
  eventType: string;        // e.g., "regulatory_investigation", "criminal_charge"
  entities: string[];       // e.g., ["ICAC", "Hong Kong"]
  years: number[];          // e.g., [2015, 2017]
  keywords: string[];       // key terms for matching
  contentWords?: string[];  // extracted content words for Jaccard similarity
}

// Raw finding before consolidation
export interface RawFinding {
  url: string;
  title: string;
  severity: 'RED' | 'AMBER' | 'REVIEW';
  headline: string;
  summary: string;
  triageClassification: string;
  fingerprint?: FindingFingerprint;
  fetchFailed?: boolean;  // True if content couldn't be fetched - needs manual review
  clusterId?: string;     // From Phase 2.5 incident clustering
  clusterLabel?: string;  // Incident description from clustering
  matchConfidence?: 'strong' | 'possible' | 'weak';
  matchReasons?: string[];
  articleContent?: string;  // Cached article text for report generation
}

// Consolidated finding after deduplication
export interface ConsolidatedFinding {
  headline: string;
  summary: string;
  severity: 'RED' | 'AMBER' | 'REVIEW';
  eventType: string;
  dateRange: string;
  sourceCount: number;
  sources: { url: string; title: string }[];
  clusterId?: string;     // From Phase 2.5 incident clustering
  clusterLabel?: string;  // Incident description from clustering
  articleContents?: { url: string; content: string }[];  // Cached article texts from source findings
  relatedLinks?: { url: string; title: string }[];  // Parked/duplicate articles (not counted in sourceCount)
}

// Subject profile built progressively during screening
export interface ProfileFact {
  field: string;       // e.g. "currentRole", "associatedCompanies"
  value: string;       // Human-readable value
  articleUrl: string;  // Source article
  snippet: string;     // Evidence snippet from article
}

export interface SubjectProfile {
  // Identity
  primaryName: string;
  nameVariants: string[];
  gender: 'male' | 'female' | 'unknown';
  nationality: string[];
  ageRange: string;

  // Professional
  currentRole: { title: string; company: string; since?: string } | null;
  pastRoles: { title: string; company: string; period?: string }[];
  industry: string[];
  licenses: string[];

  // Network
  associatedCompanies: { name: string; relationship: string }[];
  associatedPeople: { name: string; relationship: string }[];

  // Meta
  confidence: 'low' | 'medium' | 'high';
  sources: ProfileFact[];
  lastUpdated: number;
}

// Match confidence for findings
export interface MatchConfidence {
  level: 'strong' | 'possible' | 'weak';
  reasons: string[];  // ["name_match", "company_connection", "role_match"]
}

// ============================================================
// METRICS & LOGGING TYPES
// ============================================================

// Cost tracking per LLM call
export interface CostEstimate {
  provider: 'deepseek' | 'kimi' | 'gemini';
  operation: 'triage' | 'quickscan' | 'analysis' | 'consolidation';
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
}

// Per-screening metrics
export interface ScreeningMetrics {
  runId: string;
  subject: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;

  // Search metrics
  queriesExecuted: number;
  totalSearchResults: number;
  uniqueUrlsProcessed: number;
  duplicatesSkipped: number;

  // Triage metrics
  triageRed: number;
  triageYellow: number;
  triageGreen: number;

  // Analysis metrics
  fetchAttempted: number;
  fetchSucceeded: number;
  fetchFailed: number;
  analysisCompleted: number;

  // Output metrics
  findingsRed: number;
  findingsAmber: number;
  totalCleared: number;
  consolidationRatio: number;

  // Cost tracking
  costs: CostEstimate[];
  totalCostUSD: number;
}

// Benchmark case definition
export interface BenchmarkCase {
  subject: string;
  type: 'person' | 'company';
  region: 'hk' | 'cn' | 'global';
  expectedIssues: {
    description: string;
    keywords: string[];
    severity: 'RED' | 'AMBER';
  }[];
}

// Benchmark result
export interface BenchmarkResult {
  subject: string;
  runId: string;
  timestamp: string;
  expectedCount: number;
  foundCount: number;
  recall: number;
  matchedIssues: string[];
  missedIssues: string[];
}