import { Redis } from '@upstash/redis';
import { BatchSearchResult } from './searcher.js';
import { CategorizedResult } from './triage.js';
import { RawFinding, ConsolidatedFinding, SubjectProfile } from './types.js';
import { ClusteringResult, IncidentCluster } from './deduplicator.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export interface DetectedCompany {
  english: string;
  chinese: string;
  source: string;  // URL where we found this company (required for consistency with server.ts)
}

export interface ScreeningSession {
  name: string;
  variations: string[];
  language: string;
  gatheredResults: BatchSearchResult[];
  categorized: { red: CategorizedResult[]; amber: CategorizedResult[]; green: CategorizedResult[] };
  passedElimination: BatchSearchResult[];
  detectedCompanies?: DetectedCompany[];  // Associated companies from SFC/registry pages
  currentPhase: 'gather' | 'eliminate' | 'cluster' | 'categorize' | 'analyze' | 'consolidate' | 'complete';
  currentIndex: number;
  findings: RawFinding[];
  consolidatedFindings?: ConsolidatedFinding[];  // Stored after consolidation phase
  clusterResult?: ClusteringResult;  // Stored after clustering phase
  profile?: SubjectProfile;  // Subject profile built during screening

  // === Granular progress tracking for mid-phase resume ===

  // Phase 1: Gather progress
  gatherIndex?: number;           // Which query template completed (1-indexed: 1 to N)

  // Phase 1.5: Company Expansion progress
  companyExpansionIndex?: number; // Which company we've searched (1-indexed)

  // Phase 1.75: Title Dedupe progress
  titleDedupeBatchIndex?: number;     // Which batch completed (1-indexed)
  titleDedupeComplete?: boolean;      // True when phase finished

  // Phase 2.5: Clustering progress
  clusterBatchIndex?: number;     // Which batch we've clustered (1-indexed)
  clusterBatchResults?: IncidentCluster[]; // Clusters found so far (before merge)

  // Phase 3: Categorize progress
  categorizeBatchIndex?: number;  // Which batch we've categorized (1-indexed)
  categorizePartialResults?: {    // Partial categorization results
    red: CategorizedResult[];
    amber: CategorizedResult[];
    green: CategorizedResult[];
  };

  // === Pause/Resume support ===
  isPaused?: boolean;   // true = server should stop processing
  pausedAt?: number;    // Timestamp when paused

  // === Event replay for reconnection ===
  recentEvents?: { type: string; data: any; timestamp: number }[];  // Last N events for replay
  lastEventIndex?: number;  // Index of last event sent to client

  // === Connection ownership ===
  connectionId?: string;  // ID of the connection that owns this session
}

const SESSION_TTL = 14400; // 4 hours in seconds

export async function createSession(sessionId: string, session: ScreeningSession): Promise<void> {
  await redis.set(`session:${sessionId}`, JSON.stringify(session), { ex: SESSION_TTL });
  console.log(`[SESSION] Created session ${sessionId} for ${session.name}`);
}

export async function getSession(sessionId: string): Promise<ScreeningSession | null> {
  const data = await redis.get<string>(`session:${sessionId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

export async function updateSession(sessionId: string, updates: Partial<ScreeningSession>, connectionId?: string): Promise<boolean> {
  const updateKeys = Object.keys(updates);
  const hasProgress = updates.currentIndex !== undefined || updates.findings !== undefined;
  console.log(`[SESSION] updateSession: sessionId=${sessionId.slice(0,8)}, connId=${connectionId?.slice(0,8)}, keys=[${updateKeys.join(',')}], hasProgress=${hasProgress}, index=${updates.currentIndex}, findings=${updates.findings?.length}`);

  const session = await getSession(sessionId);
  if (!session) {
    console.error(`[SESSION] ERROR: Cannot update session ${sessionId} - session not found!`);
    return false;
  }

  console.log(`[SESSION] Current state: connId=${session.connectionId?.slice(0,8)}, index=${session.currentIndex}, findings=${session.findings?.length}, phase=${session.currentPhase}`);

  // If stale connection, still accept PROGRESS updates (currentIndex, findings)
  if (connectionId && session.connectionId && session.connectionId !== connectionId) {
    // Check if this is a progress update worth keeping
    if (updates.currentIndex !== undefined || updates.findings !== undefined) {
      console.log(`[SESSION] Accepting progress from stale connection: index=${updates.currentIndex}, findings=${updates.findings?.length}`);
      // Only update progress fields, take MAX to never go backward
      const progressOnly: Partial<ScreeningSession> = {};
      if (updates.currentIndex !== undefined && (session.currentIndex === undefined || updates.currentIndex > session.currentIndex)) {
        progressOnly.currentIndex = updates.currentIndex;
      }
      if (updates.findings !== undefined && updates.findings.length > (session.findings?.length || 0)) {
        progressOnly.findings = updates.findings;
      }
      if (Object.keys(progressOnly).length > 0) {
        const updated = { ...session, ...progressOnly };
        await redis.set(`session:${sessionId}`, JSON.stringify(updated), { ex: SESSION_TTL });
        console.log(`[SESSION] Merged progress: index=${updated.currentIndex}, findings=${updated.findings?.length}`);
      }
      return true;
    }
    console.log(`[SESSION] REJECTED non-progress update from stale connection ${connectionId}, current owner is ${session.connectionId}`);
    return false;
  }

  // CRITICAL: Re-read session just before writing to minimize race window.
  // This prevents stale reads from overwriting a connectionId that a new connection set.
  // Without this, the following race can occur:
  // 1. Old conn reads session (connectionId = old)
  // 2. New conn takes ownership (connectionId = new)
  // 3. Old conn writes { ...oldSession, updates } which has connectionId = old
  // 4. Old conn's write OVERWRITES new connectionId, stealing ownership back!
  const freshSession = await getSession(sessionId);
  if (!freshSession) {
    console.error(`[SESSION] ERROR: Session ${sessionId} disappeared during update!`);
    return false;
  }

  // Re-validate with fresh data - but still accept progress updates
  if (connectionId && freshSession.connectionId && freshSession.connectionId !== connectionId) {
    // Same progress exception as the first check
    if (updates.currentIndex !== undefined || updates.findings !== undefined) {
      console.log(`[SESSION] Accepting progress from stale connection (re-read check): index=${updates.currentIndex}, findings=${updates.findings?.length}`);
      const progressOnly: Partial<ScreeningSession> = {};
      if (updates.currentIndex !== undefined && (freshSession.currentIndex === undefined || updates.currentIndex > freshSession.currentIndex)) {
        progressOnly.currentIndex = updates.currentIndex;
      }
      if (updates.findings !== undefined && updates.findings.length > (freshSession.findings?.length || 0)) {
        progressOnly.findings = updates.findings;
      }
      if (Object.keys(progressOnly).length > 0) {
        const updated = { ...freshSession, ...progressOnly };
        await redis.set(`session:${sessionId}`, JSON.stringify(updated), { ex: SESSION_TTL });
        console.log(`[SESSION] Merged progress (re-read): index=${updated.currentIndex}, findings=${updated.findings?.length}`);
      }
      return true;
    }
    console.log(`[SESSION] REJECTED non-progress update from stale connection ${connectionId} (detected on re-read), current owner is ${freshSession.connectionId}`);
    return false;
  }

  // Use fresh session as base to preserve any updates that happened since our first read
  const updated = { ...freshSession, ...updates };
  await redis.set(`session:${sessionId}`, JSON.stringify(updated), { ex: SESSION_TTL });

  // Log critical updates for debugging resume issues
  if (updates.currentIndex !== undefined || updates.currentPhase !== undefined) {
    console.log(`[SESSION] Updated ${sessionId}: phase=${updated.currentPhase}, index=${updated.currentIndex}, findings=${updated.findings?.length || 0}`);
  }
  return true;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`);
  console.log(`[SESSION] Deleted session ${sessionId}`);
}

export async function deleteAllSessions(): Promise<void> {
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
  console.log(`[SESSION] Deleted all sessions (${keys.length} keys)`);
}
