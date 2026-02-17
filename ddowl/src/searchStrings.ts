// DD Owl - Dirty Word Search Strings (Consolidated v2)
// Each template has {NAME} placeholder to be replaced with subject name
// Uses Google OR operator (|) to search multiple terms
// Consolidated from 16 queries → 10 queries (37% API cost reduction)

import {
  ARABIC_TEMPLATES, ARABIC_SITE_TEMPLATES,
  DUTCH_TEMPLATES, DUTCH_SITE_TEMPLATES,
  FRENCH_TEMPLATES, FRENCH_SITE_TEMPLATES,
  GERMAN_TEMPLATES, GERMAN_SITE_TEMPLATES,
  ITALIAN_TEMPLATES, ITALIAN_SITE_TEMPLATES,
  JAPANESE_TEMPLATES, JAPANESE_SITE_TEMPLATES,
  MALAY_TEMPLATES, MALAY_SITE_TEMPLATES,
  POLISH_TEMPLATES, POLISH_SITE_TEMPLATES,
  PORTUGUESE_TEMPLATES, PORTUGUESE_SITE_TEMPLATES,
  RUSSIAN_TEMPLATES, RUSSIAN_SITE_TEMPLATES,
  SPANISH_TEMPLATES, SPANISH_SITE_TEMPLATES,
  SWEDISH_TEMPLATES, SWEDISH_SITE_TEMPLATES,
  TURKISH_TEMPLATES, TURKISH_SITE_TEMPLATES,
  KOREAN_TEMPLATES, KOREAN_SITE_TEMPLATES,
  THAI_TEMPLATES, THAI_SITE_TEMPLATES,
  VIETNAMESE_TEMPLATES, VIETNAMESE_SITE_TEMPLATES,
  INDONESIAN_TEMPLATES, INDONESIAN_SITE_TEMPLATES,
  KHMER_TEMPLATES, KHMER_SITE_TEMPLATES,
  BURMESE_TEMPLATES, BURMESE_SITE_TEMPLATES,
  TAGALOG_TEMPLATES, TAGALOG_SITE_TEMPLATES,
  LAO_TEMPLATES, LAO_SITE_TEMPLATES,
  HINDI_TEMPLATES, HINDI_SITE_TEMPLATES,
  TAMIL_TEMPLATES, TAMIL_SITE_TEMPLATES,
} from './languageTemplates.js';

// Script detection: returns true if the name contains CJK characters
export function isChineseName(name: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(name);
}

// Smart script detection: maps Unicode ranges to language codes
export function detectScript(name: string): string {
  // CJK Unified Ideographs + Extension A
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(name)) return 'chinese';
  // Hangul Syllables + Jamo
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(name)) return 'korean';
  // Hiragana + Katakana
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(name)) return 'japanese';
  // Thai
  if (/[\u0e01-\u0e5b]/.test(name)) return 'thai';
  // Khmer
  if (/[\u1780-\u17ff]/.test(name)) return 'khmer';
  // Myanmar
  if (/[\u1000-\u109f]/.test(name)) return 'burmese';
  // Lao
  if (/[\u0e80-\u0eff]/.test(name)) return 'lao';
  // Devanagari
  if (/[\u0900-\u097f]/.test(name)) return 'hindi';
  // Tamil
  if (/[\u0b80-\u0bff]/.test(name)) return 'tamil';
  // Arabic
  if (/[\u0600-\u06ff\u0750-\u077f]/.test(name)) return 'arabic';
  // Cyrillic
  if (/[\u0400-\u04ff]/.test(name)) return 'russian';
  // Latin (fallback)
  return 'english';
}

// Category names for logging (maps template index to human-readable name)
// Legacy mapping for Chinese+English (backwards compat with existing logs)
export const TEMPLATE_CATEGORIES: Record<number, string> = {
  0: 'Criminal Violence (犯罪暴力)',
  1: 'Fraud & Deception (欺诈欺骗)',
  2: 'Financial Crime (金融犯罪)',
  3: 'Corruption & Bribery (贪腐贿赂)',
  4: 'Regulatory & Sanctions (监管处罚)',
  5: 'Legal Proceedings (法律诉讼)',
  6: 'Misconduct & Discipline (不当行为)',
  7: 'Labor & Human Rights (劳工人权)',
  8: 'Drugs, Vice & Extremism (毒品色情极端)',
  9: 'Civil & Commercial Disputes (民商纠纷)',
  10: 'Official Sites CN (官方来源)',
  11: 'EN Criminal Violence & Arrests',
  12: 'EN Fraud, Financial Crime & Corruption',
  13: 'EN Legal, Regulatory & Sanctions',
  14: 'EN Misconduct, Scandal & Investigations',
  15: 'EN Drugs, Vice, Extremism & Human Rights',
  16: 'EN Civil & Commercial Disputes',
  17: 'Official Sites EN',
};

// Chinese search templates (9 thematic queries)
export const CHINESE_TEMPLATES = [
  // Q1: Criminal Violence (犯罪暴力)
  `"{NAME}" 谋杀|謀殺|强奸|強姦|抢劫|搶劫|攻击|攻擊|绑架|綁架|盗窃|盜竊|窃取|竊取|被拘|拘留|收监|收監|监禁|監禁|搶|姦|盜|竊`,

  // Q2: Fraud & Deception (欺诈欺骗)
  `"{NAME}" 诈骗|詐騙|欺诈|詐欺|骗局|騙局|造假|虛假|欺骗|欺騙|受骗|受騙|下套|误导|誤導|诈骗者|詐騙者|欺|騙`,

  // Q3: Financial Crime (金融犯罪)
  `"{NAME}" 洗钱|洗錢|内幕交易|內幕交易|操纵股价|操縱股價|操纵市场|操縱市場|非法集资|非法集資|内线交易|內線交易|崩盘|崩盤|跑路|卷款|捲款|假帐|假帳|操縱|內幕|黑社会|黑社會`,

  // Q4: Corruption & Bribery (贪腐贿赂)
  `"{NAME}" 贪污|貪污|贿赂|賄賂|回扣|腐败|腐敗|腐化|舞弊|受贿|受賄|行贿|行賄|黑钱|黑錢|敲诈勒索|敲詐勒索|勒索|被勒索|贿|賄`,

  // Q5: Regulatory & Sanctions (监管处罚)
  `"{NAME}" 证监会|證監會|证期局|證期局|处罚|處罰|罚款|罰款|制裁|警告|禁入|禁令|资产冻结|資產凍結|裁罚|裁罰|处分|處分|懲戒|反貪`,

  // Q6: Legal Proceedings (法律诉讼)
  `"{NAME}" 起诉|起訴|被诉|被訴|判决|判決|审判|審判|开庭|開庭|检察官|檢察官|诉讼|訴訟|投诉|投訴|控告|指控|提审|提審|定罪|有罪|假释|假釋|官司|调查|調查|獄`,

  // Q7: Misconduct & Discipline (不当行为)
  `"{NAME}" 撤职|撤職|停职|停職|双规|雙規|监察|監察|违法|違法|违纪|違紀|违规|違規|违反|違反|不端行为|不端行為|失格|纠纷|糾紛|案件|滥|濫|丑闻|醜聞|争议|爭議|誹謗`,

  // Q8: Labor & Human Rights (劳工人权)
  `"{NAME}" 强迫劳动|強迫勞動|强制劳动|強制勞動|强迫劳工|強迫勞工|童工|奴隶|奴隸|剥削|剝削|被贩卖|被販賣|仆人|僕人|仆役|僕役`,

  // Q9: Drugs, Vice & Extremism (毒品色情极端)
  `"{NAME}" 毒贩|毒販|麻药|麻藥|药物成瘾|藥物成癮|滥用药物|濫用藥物|吸毒者|色情|赌|賭|走私|违禁品|違禁品|恐怖主义|恐怖主義|恐怖分子|极端主义|極端主義`,

  // Q10: Civil & Commercial Disputes (民商纠纷)
  `"{NAME}" 民事|仲裁|債務|债务|欠款|拖欠|違約|违约|清盤|清盘|破產|破产|執行|执行|查封|失信|被執行人|被执行人|老賴|老赖|追債|追债|催收|擔保|担保|抵押|逾期|壞帳|坏账|重組|重组|債務重組|债务重组`,
];

// English search templates (6 consolidated from 16 groups)
export const ENGLISH_TEMPLATES: string[] = [
  // EQ1: Criminal Violence & Arrests
  `"{NAME}" crime|criminal|murder|manslaughter|assault|robbery|kidnap|kill|stab|rape|arson|weapon|violent|triad|felon|arrest|imprison|jail|prison|incarcerate|detain|bail|parole|convict|probation|fugitive`,

  // EQ2: Fraud, Financial Crime & Corruption
  `"{NAME}" fraud|scam|swindle|cheat|conned|deceive|defraud|embezzle|misappropriate|counterfeit|ponzi|launder|"money laundering"|"insider trading"|"market manipulation"|bankrupt|insolvency|corrupt|bribe|kickback|extort|racketeer|graft`,

  // EQ3: Legal, Regulatory & Sanctions
  `"{NAME}" prosecute|indict|lawsuit|litigate|sue|verdict|judgment|court|tribunal|arraign|defendant|plaintiff|"class action"|warrant|sanction|penalty|fine|banned|OFAC|blacklist|"asset freeze"|suspend|disqualify|revoke|prohibit|SFC|ICAC`,

  // EQ4: Misconduct, Scandal & Investigations
  `"{NAME}" misconduct|scandal|controversy|abuse|harass|violate|breach|negligence|mismanage|misrepresent|discipline|disgrace|illegal|unlawful|investigate|probe|allege|accuse|charge|scheme|infamous|outlaw`,

  // EQ5: Drugs, Vice, Extremism & Human Rights
  `"{NAME}" drug|narcotics|trafficking|smuggle|terrorist|extremism|porn|gambling|slave|servitude|exploitation|"forced labor"|"forced labour"|"child labor"|"child labour"`,

  // EQ6: Civil & Commercial Disputes
  `"{NAME}" bankrupt|"chapter 7"|"chapter 11"|insolvency|foreclose|dissolution|dissolve|liquidate|libel|slander|trespass|"debt recovery"|arbitration|default|sabotage|strike|espionage`,
];

// Chinese archive site searches (1 query)
export const SITE_TEMPLATES = [
  `site:gov.cn OR site:hkexnews.hk OR site:sfc.hk OR site:caixin.com "{NAME}"`,
];

// English archive site searches (1 query)
export const ENGLISH_SITE_TEMPLATES = [
  `site:sec.gov OR site:justice.gov OR site:fbi.gov OR site:ofac.treasury.gov OR site:interpol.int "{NAME}"`,
];

// Combined for backwards compatibility
export const SEARCH_TEMPLATES = [...CHINESE_TEMPLATES, ...ENGLISH_TEMPLATES, ...SITE_TEMPLATES, ...ENGLISH_SITE_TEMPLATES];

// Multi-language template registry
export interface LanguageConfig {
  templates: string[];
  siteTemplates: string[];
  hl: string;
  label: string;
}

export const LANGUAGE_CONFIG: Record<string, LanguageConfig> = {
  chinese:    { templates: CHINESE_TEMPLATES, siteTemplates: SITE_TEMPLATES, hl: 'zh-cn', label: '中文' },
  english:    { templates: ENGLISH_TEMPLATES, siteTemplates: ENGLISH_SITE_TEMPLATES, hl: 'en', label: 'English' },
  arabic:     { templates: ARABIC_TEMPLATES, siteTemplates: ARABIC_SITE_TEMPLATES, hl: 'ar', label: 'العربية' },
  dutch:      { templates: DUTCH_TEMPLATES, siteTemplates: DUTCH_SITE_TEMPLATES, hl: 'nl', label: 'Nederlands' },
  french:     { templates: FRENCH_TEMPLATES, siteTemplates: FRENCH_SITE_TEMPLATES, hl: 'fr', label: 'Français' },
  german:     { templates: GERMAN_TEMPLATES, siteTemplates: GERMAN_SITE_TEMPLATES, hl: 'de', label: 'Deutsch' },
  italian:    { templates: ITALIAN_TEMPLATES, siteTemplates: ITALIAN_SITE_TEMPLATES, hl: 'it', label: 'Italiano' },
  japanese:   { templates: JAPANESE_TEMPLATES, siteTemplates: JAPANESE_SITE_TEMPLATES, hl: 'ja', label: '日本語' },
  korean:     { templates: KOREAN_TEMPLATES, siteTemplates: KOREAN_SITE_TEMPLATES, hl: 'ko', label: '한국어' },
  malay:      { templates: MALAY_TEMPLATES, siteTemplates: MALAY_SITE_TEMPLATES, hl: 'ms', label: 'Bahasa Melayu' },
  polish:     { templates: POLISH_TEMPLATES, siteTemplates: POLISH_SITE_TEMPLATES, hl: 'pl', label: 'Polski' },
  portuguese: { templates: PORTUGUESE_TEMPLATES, siteTemplates: PORTUGUESE_SITE_TEMPLATES, hl: 'pt', label: 'Português' },
  russian:    { templates: RUSSIAN_TEMPLATES, siteTemplates: RUSSIAN_SITE_TEMPLATES, hl: 'ru', label: 'Русский' },
  spanish:    { templates: SPANISH_TEMPLATES, siteTemplates: SPANISH_SITE_TEMPLATES, hl: 'es', label: 'Español' },
  swedish:    { templates: SWEDISH_TEMPLATES, siteTemplates: SWEDISH_SITE_TEMPLATES, hl: 'sv', label: 'Svenska' },
  turkish:    { templates: TURKISH_TEMPLATES, siteTemplates: TURKISH_SITE_TEMPLATES, hl: 'tr', label: 'Türkçe' },
  thai:       { templates: THAI_TEMPLATES, siteTemplates: THAI_SITE_TEMPLATES, hl: 'th', label: 'ไทย' },
  vietnamese: { templates: VIETNAMESE_TEMPLATES, siteTemplates: VIETNAMESE_SITE_TEMPLATES, hl: 'vi', label: 'Tiếng Việt' },
  indonesian: { templates: INDONESIAN_TEMPLATES, siteTemplates: INDONESIAN_SITE_TEMPLATES, hl: 'id', label: 'Bahasa Indonesia' },
  khmer:      { templates: KHMER_TEMPLATES, siteTemplates: KHMER_SITE_TEMPLATES, hl: 'km', label: 'ខ្មែរ' },
  burmese:    { templates: BURMESE_TEMPLATES, siteTemplates: BURMESE_SITE_TEMPLATES, hl: 'my', label: 'မြန်မာ' },
  tagalog:    { templates: TAGALOG_TEMPLATES, siteTemplates: TAGALOG_SITE_TEMPLATES, hl: 'tl', label: 'Tagalog' },
  lao:        { templates: LAO_TEMPLATES, siteTemplates: LAO_SITE_TEMPLATES, hl: 'lo', label: 'ລາວ' },
  hindi:      { templates: HINDI_TEMPLATES, siteTemplates: HINDI_SITE_TEMPLATES, hl: 'hi', label: 'हिन्दी' },
  tamil:      { templates: TAMIL_TEMPLATES, siteTemplates: TAMIL_SITE_TEMPLATES, hl: 'ta', label: 'தமிழ்' },
};

// Category mapping for clearer reporting
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Criminal': ['谋杀', '强奸', '抢劫', '盗窃', '攻击', '強姦', '搶劫', '盜竊', '攻擊', '暴力', '强占', '霸占', '強佔', '霸佔'],
  'Financial Crime': ['洗钱', '内幕交易', '操纵股价', '贪污', '贿赂', '洗錢', '內幕交易', '操縱股價', '貪污', '賄賂', '非法集资', '非法集資', '找换', '找換', '外汇', '外匯', '崩盘', '崩盤', '跑路', '卷款', '捲款'],
  'Fraud': ['诈骗', '欺诈', '骗局', '造假', '詐騙', '詐欺', '騙局'],
  'Sanctions/Legal': ['制裁', '资产冻结', '禁令', '被起诉', '判决', '資產凍結', '被起訴', '判決'],
  'Terrorism': ['恐怖主义', '恐怖分子', '极端主义', '恐怖主義', '極端主義'],
  'Labor Issues': ['强迫劳动', '童工', '奴隶', '剥削', '強迫勞動', '奴隸', '剝削'],
  'Regulatory': ['证监会', '警告', '处罚', '裁罚', '證監會', '處罰', '裁罰'],
  'Corruption': ['腐败', '回扣', '舞弊', '腐敗', '受贿', '行贿', '受賄', '行賄'],
  'Drug Related': ['毒贩', '药物成瘾', '麻药', '毒販', '藥物成癮', '麻藥'],
};

export function buildSearchQuery(template: string, subjectName: string): string {
  return template.replace('{NAME}', subjectName);
}

/**
 * Build search query with multiple name variants using OR
 * e.g., ("许楚家" OR "許楚家") 诈骗|詐騙...
 */
export function buildSearchQueryWithVariants(template: string, nameVariants: string[]): string {
  if (nameVariants.length === 0) return template;
  if (nameVariants.length === 1) return template.replace('{NAME}', nameVariants[0]);

  // Build OR clause: ("name1" OR "name2" OR "name3")
  const orClause = '(' + nameVariants.map(n => `"${n}"`).join(' OR ') + ')';

  // Template has "{NAME}" - replace with OR clause (without extra quotes since we added them)
  // Template format: "{NAME}" 诈骗|詐騙...
  // We need to replace "{NAME}" with the OR clause
  return template.replace('"{NAME}"', orClause);
}

export function detectCategory(text: string): string {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return category;
      }
    }
  }
  return 'General';
}
