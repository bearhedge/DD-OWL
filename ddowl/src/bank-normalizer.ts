/**
 * Bank and Role Normalization
 *
 * Handles:
 * - Bank name variations (CLSA Limited, CLSA Capital → CLSA)
 * - Role variations (Sponsor and Overall Coordinator → sponsor, coordinator)
 * - Filtering out company names mistaken as banks
 */

// Known banks with their canonical names and variations
export const KNOWN_BANKS: Record<string, string[]> = {
  // Global bulge bracket
  'Goldman Sachs': ['Goldman Sachs', 'Goldman Sachs (Asia)', 'Goldman Sachs (Asia) L.L.C.', 'GS'],
  'Morgan Stanley': ['Morgan Stanley', 'Morgan Stanley Asia'],
  'J.P. Morgan': ['J.P. Morgan', 'JP Morgan', 'JPMorgan', 'J.P. Morgan Securities'],
  'Citi': ['Citi', 'Citigroup', 'Citigroup Global Markets', 'Citigroup Global Markets Asia'],
  'Bank of America': ['Bank of America', 'BofA', 'BofA Securities', 'Merrill Lynch', 'Merrill', 'Merrill Lynch (Asia Pacific)'],
  'UBS': ['UBS', 'UBS AG', 'UBS Securities'],
  'Credit Suisse': ['Credit Suisse', 'CS', 'Credit Suisse Securities'],
  'Deutsche Bank': ['Deutsche Bank', 'DB'],
  'Barclays': ['Barclays', 'Barclays Capital'],
  'HSBC': ['HSBC', 'HSBC Bank', 'Hongkong and Shanghai Banking', 'Hong Kong and Shanghai Banking', 'The Hongkong and Shanghai Banking Corporation'],
  'BNP Paribas': ['BNP Paribas', 'BNP'],
  'Nomura': ['Nomura', 'Nomura Securities', 'Nomura International'],
  'Daiwa': ['Daiwa', 'Daiwa Capital Markets', 'Daiwa Securities'],
  'DBS': ['DBS', 'DBS Asia Capital', 'DBS Bank'],

  // Chinese majors
  'CITIC': ['CITIC', 'CITIC Securities', 'CLSA', 'CITIC CLSA'],
  'CICC': ['CICC', 'China International Capital', 'China International Capital Corporation'],
  'Huatai': ['Huatai', 'Huatai Securities', 'Huatai Financial', 'Huatai International'],
  'Guotai Junan Capital': ['Guotai Junan Capital'],
  'Guotai Junan Securities': ['Guotai Junan Securities', 'GTJA Securities'],
  'Guotai Junan': ['Guotai Junan', 'GTJA'],  // Generic mentions only
  'Haitong': ['Haitong', 'Haitong Securities', 'Haitong International'],
  'China Securities': ['China Securities', 'CSC', 'China Securities International'],
  'GF Securities': ['GF Securities', 'GF', 'Guangfa Securities'],
  'CMB International': ['CMB International', 'CMBI', 'China Merchants Bank International'],
  'ICBC International': ['ICBC International', 'ICBCI', 'ICBC'],
  'BOCI': ['BOCI', 'BOC International', 'Bank of China International', 'BOCR'],
  'CCB International': ['CCB International', 'CCBI', 'China Construction Bank International'],
  'BOCOM International': ['BOCOM International', 'Bank of Communications International'],
  'China Everbright': ['China Everbright', 'Everbright Securities', 'CEB', 'China Everbright Securities'],
  'Cinda International': ['Cinda International', 'Cinda'],
  'China Renaissance': ['China Renaissance', 'Huaxing', 'China Renaissance Securities'],
  'Fosun': ['Fosun', 'Fosun International', 'Fosun Securities'],
  'Guosen': ['Guosen', 'Guosen Securities'],
  'China Galaxy': ['China Galaxy', 'Galaxy Securities', 'China Galaxy International'],
  'ABCI': ['ABCI', 'ABCI Capital', 'Agricultural Bank of China International'],
  'CMBC': ['CMBC', 'CMBC Securities', 'China Minsheng Banking'],
  'CEB International': ['CEB International', 'China Everbright Securities'],
  'China Industrial Securities': ['China Industrial Securities', 'Industrial Securities'],
  'Goldlink': ['Goldlink', 'Goldlink Securities'],
  'Guolian': ['Guolian', 'Guolian Securities'],
  'Zhongtai': ['Zhongtai', 'Zhongtai Securities', 'Zhongtai International'],
  'Shenwan Hongyuan': ['Shenwan Hongyuan', 'SWS', 'Shenwan'],
  'Orient Securities': ['Orient Securities', 'DFZQ'],
  'Founder Securities': ['Founder Securities', 'Founder'],
  'Essence Corporate Finance': ['Essence Corporate Finance'],
  'Essence International Securities': ['Essence International Securities'],
  'Essence Securities': ['Essence Securities', 'Essence'],
  'SPDB': ['SPDB', 'Shanghai Pudong Development Bank', 'SPDB International'],
  'China Merchants Securities': ['China Merchants Securities', 'CMS', 'China Merchants Securities (HK)'],
  'Ping An Securities': ['Ping An Securities', 'Ping An'],
  'SDIC Securities': ['SDIC Securities', 'SDIC'],
  'Sinolink Securities': ['Sinolink Securities', 'Sinolink'],
  'Tiger Brokers': ['Tiger Brokers', 'Tiger Securities'],
  'Futu': ['Futu', 'Futu Securities'],

  // International banks
  'Credit Agricole': ['Credit Agricole', 'Credit Agricole CIB', 'CA-CIB', 'Crédit Agricole'],
  'Natixis': ['Natixis'],
  'Standard Chartered': ['Standard Chartered', 'Standard Chartered Bank', 'StanChart'],
  'Societe Generale': ['Societe Generale', 'SocGen', 'SG', 'Société Générale'],
  'Macquarie': ['Macquarie', 'Macquarie Capital', 'Macquarie Bank'],
  'First Capital': ['First Capital', 'First Capital Securities'],
  'National Australia Bank': ['National Australia Bank', 'NAB', 'NADS'],
  'Jefferies': ['Jefferies', 'Jefferies LLC', 'Jefferies Hong Kong'],
  'Mizuho': ['Mizuho', 'Mizuho Securities'],
  'SMBC': ['SMBC', 'SMBC Nikko', 'Sumitomo Mitsui'],
  'SBI': ['SBI', 'SBI Securities'],
  'OCBC': ['OCBC', 'OCBC Bank', 'Oversea-Chinese Banking'],
  'United Overseas Bank': ['United Overseas Bank', 'UOB'],
  'ANZ': ['ANZ', 'Australia and New Zealand Banking'],
  'Westpac': ['Westpac', 'Westpac Banking'],
  'ING': ['ING', 'ING Bank'],
  'Rabobank': ['Rabobank'],
  'Commerzbank': ['Commerzbank'],
  'Santander': ['Santander', 'Banco Santander'],
  'BBVA': ['BBVA', 'Banco Bilbao'],

  // Online brokers / newer platforms
  'Longbridge': ['Longbridge', 'Long Bridge', 'Long Bridge HK'],
  '9F Primasia': ['9F Primasia', '9F Prime Asia', '9F Prime', '9F Securities'],
  'ZINVEST': ['ZINVEST', 'ZINVEST Global'],

  // Niche / regional brokers
  'TFI Securities': ['TFI Securities', 'TFI Securities and Futures', 'TFI Securities and Futures Limited'],
};

// Keywords that indicate a real bank (must have at least one)
const BANK_KEYWORDS = [
  'Securities', 'Capital', 'Financial', 'Bank', 'Brokers', 'Brokerage', 'Equities',
  'Investment', 'Partners', 'Advisors', 'Advisory', 'Markets',
  'Morgan', 'Goldman', 'CLSA', 'CITIC', 'CICC', 'Huatai', 'Guotai',
  'CMB', 'UBS', 'Credit Suisse', 'Merrill', 'Haitong', 'ICBC', 'BOCI', 'BOCR',
  'BOCOM', 'CCB', 'CEB', 'CMBC', 'Cinda', 'Fosun', 'GF ', 'Guosen',
  'Daiwa', 'DBS', 'Nomura', 'Barclays', 'Deutsche', 'BNP', 'HSBC',
  'Renaissance', 'Galaxy', 'Everbright', 'Orient', 'Shenwan', 'Zhongtai',
  'Citigroup', 'Citi', 'Tiger', 'Futu', 'Livermore',
  // International banks added
  'First Capital', 'Standard Chartered', 'Credit Agricole', 'Agricole',
  'Natixis', 'SocGen', 'Societe Generale', 'Macquarie', 'NADS',
  'National Australia', 'BofA', 'Jefferies', 'Mizuho', 'SMBC',
  'SBI', 'OCBC', 'UOB', 'ANZ', 'Westpac', 'ING', 'Rabobank',
  'Commerzbank', 'Santander', 'BBVA', 'ABN AMRO',
  // Online brokers
  'Longbridge', 'Long Bridge', '9F Prime', '9F Primasia', 'Primasia', 'ZINVEST', 'TFI',
  'China Merchants Securities', 'SPDB International',
  'Jefferies', 'SDIC', 'Ping An', 'Sinolink',
];

// Keywords that indicate it's a company (IPO applicant), NOT a bank
const COMPANY_KEYWORDS = [
  'Technology Co', 'Biotech', 'Pharmaceutical Co', 'Biopharmaceutical',
  'Electronics Co', 'Semiconductor Co', 'Software', 'Digital Tech',
  'Medical Co', 'Healthcare Co', 'Therapeutics', 'Bioscience', 'Genomics',
  'Energy Co', 'Solar', 'Electric Co', 'Motor Co', 'Automotive', 'Vehicle',
  'Food Co', 'Beverage', 'Consumer', 'Retail', 'E-Commerce',
  'Manufacturing', 'Industrial Co', 'Machinery', 'Equipment Co',
  'Construction', 'Property', 'Real Estate',
  'Entertainment', 'Media Co', 'Education', 'Tourism',
  'Agriculture', 'Mining', 'Resources Co',
  'Robotics', 'Robot Co', 'Artificial Intelligence Co',
  'Cloud Co', 'Information Tech', 'Logistics', 'Supply Chain',
  'Cosmetics', 'Beauty', 'Fashion', 'Apparel',
  'Smart Technology', // specific pattern for tech companies
];

/**
 * Check if a "bank" name is actually the company being listed
 * This filters out cases like "Coosea Smart Technology" appearing as its own coordinator
 */
export function isCompanyName(bankName: string, companyName: string): boolean {
  if (!companyName) return false;

  const bankLower = bankName.toLowerCase();
  const companyLower = companyName.toLowerCase();

  // Direct match
  if (bankLower === companyLower) return true;

  // Check if first significant word matches (e.g., "Coosea" in both)
  const companyWords = companyLower.split(/\s+/).filter(w => w.length > 3);
  const bankWords = bankLower.split(/\s+/).filter(w => w.length > 3);

  // If first word matches and bank name contains company-like keywords
  if (companyWords[0] && bankWords[0] && companyWords[0] === bankWords[0]) {
    if (bankLower.match(/technology|group|holdings|company|limited|corp/i)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a name is likely a bank (not a company)
 */
export function isLikelyBank(name: string, companyName?: string): boolean {
  const upper = name.toUpperCase();

  // First check if it's the company itself (IPO applicant)
  if (companyName && isCompanyName(name, companyName)) {
    return false;
  }

  // Check for company keywords (exclusion)
  for (const keyword of COMPANY_KEYWORDS) {
    if (upper.includes(keyword.toUpperCase())) {
      // Some exceptions: "Bank" or "Securities" + company keyword = still a bank
      if (!upper.includes('SECURITIES') && !upper.includes('CAPITAL') && !upper.includes('BANK')) {
        return false;
      }
    }
  }

  // Check for bank keywords
  for (const keyword of BANK_KEYWORDS) {
    if (upper.includes(keyword.toUpperCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize a bank name to its canonical form
 */
export function normalizeBankName(name: string): { canonical: string; original: string } {
  const cleaned = name
    .replace(/\s+/g, ' ')
    .replace(/\(Hong Kong\)/gi, '')
    .replace(/\(Asia Pacific\)/gi, '')
    .replace(/\(Asia\)/gi, '')
    .replace(/\(HK\)/gi, '')
    .replace(/Limited$/i, '')
    .replace(/Ltd\.?$/i, '')
    .replace(/L\.L\.C\.?$/i, '')
    .replace(/Co\.,?$/i, '')
    .replace(/Corporation$/i, '')
    .replace(/Corp\.?$/i, '')
    .replace(/Company$/i, '')
    .replace(/,\s*$/, '')
    .trim();

  // Try to match known banks - use stricter matching
  // Sort by variation length descending to match longer patterns first
  const entries = Object.entries(KNOWN_BANKS)
    .flatMap(([canonical, variations]) =>
      variations.map(v => ({ canonical, variation: v, len: v.length }))
    )
    .sort((a, b) => b.len - a.len);

  for (const { canonical, variation } of entries) {
    // Use word boundary matching for short variations
    const pattern = variation.length < 6
      ? new RegExp(`\\b${variation}\\b`, 'i')
      : new RegExp(variation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    if (pattern.test(cleaned)) {
      return { canonical, original: name };
    }
  }

  // Not in known list, return cleaned version
  return { canonical: cleaned, original: name };
}

// Role normalization
export type NormalizedRole = 'sponsor' | 'coordinator' | 'bookrunner' | 'lead_manager' | 'other';

export interface ParsedRole {
  roles: NormalizedRole[];
  isLead: boolean;
  original: string;
}

/**
 * Parse role text into normalized roles
 * "Sponsor and Overall Coordinator" → ['sponsor', 'coordinator']
 * "Joint Global Coordinator" → ['coordinator']
 */
export function parseRoles(roleText: string): ParsedRole {
  const lower = roleText.toLowerCase();
  const roles: NormalizedRole[] = [];

  // Check for each role type
  if (lower.includes('sponsor')) {
    roles.push('sponsor');
  }

  if (lower.includes('coordinator') || lower.includes('co-ordinator')) {
    roles.push('coordinator');
  }

  if (lower.includes('bookrunner') || lower.includes('book runner')) {
    roles.push('bookrunner');
  }

  if (lower.includes('lead manager') || lower.includes('lead-manager')) {
    roles.push('lead_manager');
  }

  // If nothing matched, mark as other
  if (roles.length === 0) {
    roles.push('other');
  }

  // Is it a lead role? (sponsors and coordinators are decision makers)
  const isLead = roles.includes('sponsor') || roles.includes('coordinator');

  return { roles, isLead, original: roleText };
}

/**
 * Extract bank appointments from OC announcement text
 * Returns list of { bank, roles, isLead }
 */
export function extractBankAppointments(text: string): Array<{
  bank: string;
  bankNormalized: string;
  roles: NormalizedRole[];
  isLead: boolean;
}> {
  const appointments: Array<{
    bank: string;
    bankNormalized: string;
    roles: NormalizedRole[];
    isLead: boolean;
  }> = [];

  const seenBanks = new Set<string>();

  // Pattern 1: "has appointed [Bank] as [role]"
  const appointedPattern = /has\s+appointed\s+([\s\S]+?)\s+as\s+(?:its?\s+)?(?:the\s+)?((?:sole\s+)?(?:joint\s+)?(?:(?:global\s+)?(?:overall\s+)?(?:sponsor|coordinator|co-ordinator|bookrunner|book\s*runner|lead\s*manager)(?:\s*(?:and|,)\s*)?)+)/gi;

  let match;
  while ((match = appointedPattern.exec(text)) !== null) {
    const bankPart = match[1].replace(/\s+/g, ' ').trim();
    const rolePart = match[2];

    // Split multiple banks (separated by "and" or ",")
    const bankNames = bankPart
      .split(/\s+and\s+|\s*,\s*/)
      .map(s => s.trim())
      .filter(s => s.length > 5);

    for (const bankName of bankNames) {
      if (!isLikelyBank(bankName)) continue;

      const { canonical } = normalizeBankName(bankName);
      if (seenBanks.has(canonical.toLowerCase())) continue;
      seenBanks.add(canonical.toLowerCase());

      const parsed = parseRoles(rolePart);
      appointments.push({
        bank: bankName,
        bankNormalized: canonical,
        roles: parsed.roles,
        isLead: parsed.isLead,
      });
    }
  }

  // Pattern 2: Role headers followed by bank names
  const lines = text.split('\n');
  let currentRoles: NormalizedRole[] = [];
  let currentIsLead = false;

  const roleHeaderPattern = /^(?:Joint\s+)?(?:Sole\s+)?(?:Global\s+)?(?:Overall\s+)?(Sponsor|Coordinator|Co-ordinator|Bookrunner|Lead\s*Manager)s?(?:\s+and\s+(?:Joint\s+)?(?:Global\s+)?(?:Overall\s+)?(Sponsor|Coordinator|Co-ordinator|Bookrunner|Lead\s*Manager)s?)?/i;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this is a role header
    const headerMatch = trimmed.match(roleHeaderPattern);
    if (headerMatch) {
      const parsed = parseRoles(trimmed);
      currentRoles = parsed.roles;
      currentIsLead = parsed.isLead;
      continue;
    }

    // Check if this looks like a bank name
    if (trimmed.match(/Limited$/i) &&
        trimmed.length > 15 &&
        trimmed.length < 100 &&
        isLikelyBank(trimmed)) {

      const { canonical } = normalizeBankName(trimmed);
      if (seenBanks.has(canonical.toLowerCase())) continue;
      seenBanks.add(canonical.toLowerCase());

      appointments.push({
        bank: trimmed,
        bankNormalized: canonical,
        roles: currentRoles.length > 0 ? currentRoles : ['other'],
        isLead: currentIsLead,
      });
    }
  }

  return appointments;
}

// Test
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Testing bank normalizer...\n');

  // Test isLikelyBank
  const testNames = [
    'CLSA Limited',
    'Huatai Financial Holdings (Hong Kong) Limited',
    'Coosea Smart Technology Company Limited',
    'Beijing Roborock Technology Co., Ltd.',
    'China International Capital Corporation Hong Kong Securities Limited',
    'EnjoyGo Technology Limited',
  ];

  console.log('isLikelyBank tests:');
  for (const name of testNames) {
    console.log(`  ${isLikelyBank(name) ? '✓ BANK' : '✗ COMPANY'}: ${name}`);
  }

  console.log('\nnormalizeBankName tests:');
  const bankNames = [
    'CLSA Limited',
    'Huatai Financial Holdings (Hong Kong) Limited',
    'J.P. Morgan Securities (Asia Pacific) Limited',
    'China International Capital Corporation Hong Kong Securities Limited',
  ];
  for (const name of bankNames) {
    const { canonical } = normalizeBankName(name);
    console.log(`  ${name} → ${canonical}`);
  }

  console.log('\nparseRoles tests:');
  const roleTexts = [
    'Sponsor and Overall Coordinator',
    'Joint Global Coordinator',
    'Sole Sponsor',
    'Joint Bookrunners',
    'Lead Manager',
  ];
  for (const role of roleTexts) {
    const parsed = parseRoles(role);
    console.log(`  "${role}" → ${parsed.roles.join(', ')} (lead: ${parsed.isLead})`);
  }
}
