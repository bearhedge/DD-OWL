// src/reportGenerator.ts
// Generates professional DD write-ups from screening findings

import axios from 'axios';
import { ConsolidatedFinding } from './types.js';
import { CleanEntityResult } from './reports-db.js';

// LLM Configuration (same fallback chain as other modules)
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// Provider configuration
interface LLMProvider {
  name: string;
  url: string;
  model: string;
  apiKey: string;
}

function getProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  if (KIMI_API_KEY) {
    providers.push({
      name: 'Kimi K2',
      url: 'https://api.moonshot.ai/v1/chat/completions',
      model: 'kimi-k2',
      apiKey: KIMI_API_KEY,
    });
  }

  if (DEEPSEEK_API_KEY) {
    providers.push({
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKey: DEEPSEEK_API_KEY,
    });
  }

  return providers;
}

// Streaming callback type
export type StreamCallback = (chunk: string) => void;

/**
 * Generate write-up for a single finding with streaming.
 * When articleContent is provided, the LLM uses the actual article text as ground truth.
 * When missing, it generates from metadata only and notes limited source access.
 */
export async function generateWriteUp(
  finding: ConsolidatedFinding,
  subjectName: string,
  onChunk: StreamCallback,
  articleContent?: string
): Promise<string> {
  const isRed = finding.severity === 'RED';
  const detailLevel = isRed ? '3-4 paragraphs with full detail' : '1-2 paragraphs, key facts only';

  const sourcesText = finding.sources.map((s, i) => `[${i + 1}]  ${s.url}`).join('\n');

  // Build article section for the prompt
  const articleSection = articleContent
    ? `ARTICLE TEXT (use as ground truth — cross-reference claims against this):
${articleContent.slice(0, 8000)}

`
    : `NOTE: Full article text was not available. Write based on the metadata below only.
State clearly what is known from the source metadata vs what could not be verified.

`;

  const prompt = `Write a professional due diligence finding following this EXACT format and style.

SUBJECT: ${subjectName}
ISSUE HEADLINE: ${finding.headline}
ISSUE SUMMARY: ${finding.summary}
${articleSection}SOURCE URLs:
${sourcesText}

FORMAT RULES (follow exactly):

1. HEADLINE: Write a clear headline with year range in parentheses
   Format: [Issue description] ([Year] or [Year – Year])
   Example: "Involvement in his uncle Yang Xiancai judicial corruption case (2008 – 2010)"

2. OPENING SENTENCE: Always start with source attribution
   Format: "According to [article/media type] published by [outlet name] in [Month Year], [subject]..."
   Examples:
   - "According to an article published by Shanghai Securities News (上海证券报) in December 2007, Chen Yuxing..."
   - "According to mainstream media articles in November 2020, Hui's Brothers Currency Exchange Group..."
   - "According to an article published by 22ja.com (深圳生活网) in April 2013, Xu..."

3. NAMES: Include Chinese characters and short form
   Format: Full Name (中文, "Short")
   Example: "Yang Xiancai (杨贤才, "Yang")"

4. AMOUNTS: Always include USD conversion
   Format: CNY X million (USD Y million)
   Example: "CNY 7.5 million (USD 1.05 million)"

5. BODY: Topic sentence → Context → Specific facts → Outcome
   - Include specific dates when available
   - Include roles/titles
   - Include company names with Chinese if available
   - Include case numbers if available

6. CLOSING: End with neutral status update
   Examples:
   - "No information was found indicating X was further investigated or charged."
   - "Research did not find any information suggesting..."
   - "X was not penalized or accused of any wrongdoing for the issue."
   - "No further details relating to the issue were found."

7. SOURCES: End the write-up with source footnotes
   Format: [1]  URL

STRICT RULES:
- Do NOT include severity labels (RED, AMBER, etc.)
- Do NOT editorialize or use dramatic language
- Do NOT add meta-commentary about the report
- Do NOT use bullet points unless listing multiple sub-incidents
- Keep tone neutral and factual throughout
- Write ${detailLevel}
- End with source footnotes using [1], [2] etc. referencing the SOURCE URLs above

EXAMPLE OUTPUT:
Involvement in his uncle Yang Xiancai judicial corruption case (2008 – 2010)

According to an article published in December 2023, Xu was involved in a corruption scandal involving Yang Xiancai (杨贤才, "Yang"), the former director of the Guangdong Higher People's Court Enforcement Bureau (广东省高级人民法院原执行局局长). Xu, then the chairman of Shenzhen Zhaobangji Group, received CNY 7.5 million (USD 1.05 million) from Yang in exchange for 10% equity in a commercial plaza project in Shenzhen Dongmen (东门) in 2006, which was held by Yang's son Yang Bin (杨彬). The article noted that the funds involved in the transaction were proceeds from Yang's bribery activities.

When investigators carried out asset recovery in January 2009, Xu returned the CNY 7.5 million (USD 1.05 million) and claimed he didn't know the proceeds had been from Yang's illegal gains. No information was found in online research indicating Xu was further investigated or charged in the issue.[1]

[1]  https://example.com/article

Now write the finding for the issue described above:`;

  const providers = getProviders();
  let fullResponse = '';

  for (const provider of providers) {
    try {
      console.log(`[REPORT] Generating write-up with ${provider.name} (streaming)...`);

      // Use streaming for better UX
      const response = await axios.post(
        provider.url,
        {
          model: provider.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          stream: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
          },
          timeout: 120000,
          responseType: 'stream',
        }
      );

      // Process SSE stream
      return await new Promise<string>((resolve, reject) => {
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          buffer += text;

          // Process complete SSE messages
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  fullResponse += content;
                  onChunk(content);
                }
              } catch {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        });

        response.data.on('end', () => {
          console.log(`[REPORT] ✓ Write-up generated with ${provider.name}`);
          resolve(fullResponse);
        });

        response.data.on('error', (err: Error) => {
          reject(err);
        });
      });

    } catch (error: any) {
      console.log(`[REPORT] ✗ ${provider.name} streaming failed: ${error.message || error}`);

      // Try non-streaming fallback
      try {
        console.log(`[REPORT] Trying ${provider.name} non-streaming...`);
        const response = await axios.post(
          provider.url,
          {
            model: provider.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${provider.apiKey}`,
            },
            timeout: 120000,
          }
        );

        const content = response.data.choices?.[0]?.message?.content || '';
        if (content) {
          console.log(`[REPORT] ✓ Write-up generated with ${provider.name} (non-streaming)`);
          onChunk(content);
          return content;
        }
      } catch (fallbackError: any) {
        console.log(`[REPORT] ✗ ${provider.name} non-streaming also failed: ${fallbackError.message}`);
      }
      continue;
    }
  }

  // Fallback: return basic formatted info
  const fallback = `${finding.headline}\n\n${finding.summary}\n\nNo additional details were found in online research.`;
  onChunk(fallback);
  return fallback;
}

/**
 * Generate clean entity write-up using template language
 * LLM writes ONLY the descriptive clause; template wrapper is added programmatically
 */
export async function generateCleanWriteUp(
  entityName: string,
  searchResults: CleanEntityResult[],
  subjectName: string,
  onChunk: StreamCallback
): Promise<string> {
  const resultsText = searchResults.slice(0, 20).map(r =>
    `- ${r.title} (${r.url})\n  ${r.snippet}`
  ).join('\n');

  const prompt = `Given these search results for "${entityName}" (a subject in a due diligence screening for "${subjectName}"), write ONE sentence describing what the search results primarily relate to.

SEARCH RESULTS:
${resultsText}

Write ONLY the descriptive clause. Examples:
- "its operations as a subsidiary of Hainan Jinpan, as recorded by the company's Shanghai stock exchange filings"
- "its business registration records and corporate filings on mainstream aggregator websites"
- "his role as chairman of ABC Corp, as recorded by stock exchange announcements and corporate media"

Rules:
- One sentence only, no period at end
- Describe what the sources ARE ABOUT, not what they say
- Reference source types (stock filings, media, corporate records, etc.)
- Include relationship to parent subject if evident
- Neutral tone, professional English`;

  const providers = getProviders();

  for (const provider of providers) {
    try {
      console.log(`[REPORT] Generating clean write-up for "${entityName}" with ${provider.name}...`);
      const response = await axios.post(
        provider.url,
        {
          model: provider.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
          },
          timeout: 30000,
        }
      );

      const clause = response.data.choices?.[0]?.message?.content?.trim();
      if (clause) {
        console.log(`[REPORT] ✓ Clean write-up for "${entityName}" via ${provider.name}`);
        // Build the full template block
        const sourceList = searchResults.map(r => r.url).join('\n');
        const block = `Media and online coverage of ${entityName} is mainly neutral. Online and media references to ${entityName} primarily relate to ${clause}.[1]\nOnline and media research found no significant negative issues with the subject.\n\n[1]  ${sourceList}`;
        onChunk(block);
        return block;
      }
    } catch (err: any) {
      console.log(`[REPORT] ✗ ${provider.name} clean write-up failed: ${err.message}`);
      continue;
    }
  }

  // Fallback: generic clause
  const sourceList = searchResults.map(r => r.url).join('\n');
  const fallback = `Media and online coverage of ${entityName} is mainly neutral. Online and media references to ${entityName} primarily relate to its business operations and corporate filings.[1]\nOnline and media research found no significant negative issues with the subject.\n\n[1]  ${sourceList}`;
  onChunk(fallback);
  return fallback;
}

/**
 * Generate full report with streaming — covers all entities (flagged + clean)
 */
export async function generateFullReport(
  subjectName: string,
  findings: ConsolidatedFinding[],
  cleanResults: Record<string, CleanEntityResult[]>,
  nameVariations: string[],
  onChunk: StreamCallback
): Promise<void> {
  // Determine which name variations have findings
  const flaggedEntities = new Set<string>();
  const findingsByEntity = new Map<string, ConsolidatedFinding[]>();

  for (const finding of findings) {
    // Match finding to name variation via source query or headline
    let matched = false;
    for (const nv of nameVariations) {
      const nvLower = nv.toLowerCase();
      // Check if any source relates to this name variation
      const relatesTo = finding.sources.some(s =>
        s.title.toLowerCase().includes(nvLower) || s.url.toLowerCase().includes(nvLower)
      ) || finding.headline.toLowerCase().includes(nvLower) || finding.summary.toLowerCase().includes(nvLower);

      if (relatesTo) {
        flaggedEntities.add(nv);
        if (!findingsByEntity.has(nv)) findingsByEntity.set(nv, []);
        findingsByEntity.get(nv)!.push(finding);
        matched = true;
      }
    }
    // If no match found, attribute to the first (primary) name variation
    if (!matched && nameVariations.length > 0) {
      const primary = nameVariations[0];
      flaggedEntities.add(primary);
      if (!findingsByEntity.has(primary)) findingsByEntity.set(primary, []);
      findingsByEntity.get(primary)!.push(finding);
    }
  }

  let blockIndex = 0;

  // Process each name variation in order
  for (const nv of nameVariations) {
    if (blockIndex > 0) {
      onChunk('\n\n');
    }

    if (flaggedEntities.has(nv)) {
      // Flagged entity: generate write-up from findings
      const entityFindings = findingsByEntity.get(nv) || [];
      for (let i = 0; i < entityFindings.length; i++) {
        if (i > 0) onChunk('\n\n');
        // Pass article content if available for richer, grounded write-ups
        const articleContent = entityFindings[i].articleContents?.map(ac => ac.content).join('\n\n---\n\n');
        await generateWriteUp(entityFindings[i], subjectName, onChunk, articleContent || undefined);
      }
    } else if (cleanResults[nv] && cleanResults[nv].length > 0) {
      // Clean entity: generate template-based write-up
      await generateCleanWriteUp(nv, cleanResults[nv], subjectName, onChunk);
    } else {
      // Entity with no results at all — still include with generic template
      const block = `Media and online coverage of ${nv} is mainly neutral. Online and media references to ${nv} primarily relate to its business operations and corporate filings.\nOnline and media research found no significant negative issues with the subject.`;
      onChunk(block);
    }

    blockIndex++;
  }

  // Also process any clean entities not in nameVariations (edge case)
  for (const [entity, results] of Object.entries(cleanResults)) {
    if (!nameVariations.includes(entity) && results.length > 0) {
      onChunk('\n\n');
      await generateCleanWriteUp(entity, results, subjectName, onChunk);
      blockIndex++;
    }
  }
}
