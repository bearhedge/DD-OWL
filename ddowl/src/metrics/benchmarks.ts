import { BenchmarkCase, BenchmarkResult, ConsolidatedFinding } from '../types.js';

// Benchmark cases with known issues
export const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    subject: '许楚家',
    type: 'person',
    region: 'hk',
    expectedIssues: [
      {
        id: 'hck-yangxiancai',
        description: 'Yang Xiancai corruption case involvement',
        category: 'corruption',
        keywords: ['杨贤才', '腐败', '司法', '贿赂'],
        severity: 'RED',
      },
      {
        id: 'hck-jingxuan',
        description: 'Jingxuan Hotel violent seizure',
        category: 'litigation',
        keywords: ['京轩酒店', '暴力', '强占', '打砸'],
        severity: 'RED',
      },
      {
        id: 'hck-xinno',
        description: 'Xinno Technology Park debt dispute',
        category: 'litigation',
        keywords: ['信诺科技园', '3.37亿', '债务', '纠纷'],
        severity: 'AMBER',
      },
      {
        id: 'hck-sfc',
        description: 'SFC concentration warning',
        category: 'regulatory',
        keywords: ['证监会', '股权集中', '警告', 'SFC'],
        severity: 'AMBER',
      },
      {
        id: 'hck-huibrothers',
        description: 'Hui Brothers illegal fundraising',
        category: 'corruption',
        keywords: ['汇兄弟', '非法集资', '诈骗'],
        severity: 'RED',
      },
    ],
  },
  {
    subject: 'Xiaomi Corporation',
    aliases: ['小米科技有限责任公司', '小米集团', 'Xiaomi Inc'],
    type: 'company',
    region: 'global',
    expectedIssues: [
      // CORRUPTION (4)
      {
        id: 'xm-ouwen-chenbingxu',
        description: 'Ou Wen & Chen Bingxu fired for corruption (2024)',
        category: 'corruption',
        keywords: ['欧文', '陈丙旭', '西欧', '拉美'],
        severity: 'RED',
      },
      {
        id: 'xm-zhaoqian-haoliang',
        description: 'Zhao Qian & Hao Liang arrested (2019)',
        category: 'corruption',
        keywords: ['赵芊', '郝亮', '不诚信黑名单'],
        severity: 'RED',
      },
      {
        id: 'xm-wangliming',
        description: 'VP Wang Liming detained obscenity (2019)',
        category: 'corruption',
        keywords: ['王力明', '非洲', '猥亵', 'obscenity'],
        severity: 'RED',
      },
      {
        id: 'xm-anticorruption-139',
        description: 'Internal anti-corruption 139 cases (2020-2022)',
        category: 'corruption',
        keywords: ['阳光小米', '139', '违规违纪', '31人'],
        severity: 'AMBER',
      },
      // ESG (5)
      {
        id: 'xm-uyghur',
        description: 'Uyghur forced labor (ASPI 2020)',
        category: 'esg',
        keywords: ['维吾尔', 'Uyghur', 'ASPI', '强迫劳动'],
        severity: 'RED',
      },
      {
        id: 'xm-greenpeace',
        description: 'Greenpeace poor ranking',
        category: 'esg',
        keywords: ['Greenpeace', '绿色和平', '可再生能源'],
        severity: 'AMBER',
      },
      {
        id: 'xm-jiangsu-wastewater',
        description: 'Jiangsu factory wastewater (2018)',
        category: 'esg',
        keywords: ['铜污染', '废水', '江苏', 'IPE'],
        severity: 'AMBER',
      },
      {
        id: 'xm-overwork-death',
        description: 'Employee overwork death (2024)',
        category: 'esg',
        keywords: ['过劳死', '猝死', '王姓', '汽车经销商'],
        severity: 'RED',
      },
      {
        id: 'xm-hr-layoff-threats',
        description: 'HR layoff threats (2022)',
        category: 'esg',
        keywords: ['仲裁', '背调', '年终奖', '裁员补偿'],
        severity: 'AMBER',
      },
      // PRODUCT (7)
      {
        id: 'xm-m365-recall',
        description: 'M365 scooter recall (2019)',
        category: 'product',
        keywords: ['M365', '电动滑板车', '10257', '折叠'],
        severity: 'AMBER',
      },
      {
        id: 'xm-mi13-warranty',
        description: 'Mi 13 warranty refusal (2025)',
        category: 'product',
        keywords: ['刁', 'Mi 13', '延保', '漏液'],
        severity: 'AMBER',
      },
      {
        id: 'xm-su7-haikou',
        description: 'SU7 crash Haikou 1 death (2024)',
        category: 'product',
        keywords: ['SU7', '海口', '制动', '1死3伤'],
        severity: 'RED',
      },
      {
        id: 'xm-su7-hunan',
        description: 'SU7 brake failure Hunan (2024)',
        category: 'product',
        keywords: ['SU7', '湖南', '制动系统故障', '39公里'],
        severity: 'AMBER',
      },
      {
        id: 'xm-12315-complaints',
        description: '12315 consumer complaints',
        category: 'product',
        keywords: ['12315', '虚假广告', '不正当竞争'],
        severity: 'AMBER',
      },
      {
        id: 'xm-smartphone-quality',
        description: 'Smartphone quality complaints (2022)',
        category: 'product',
        keywords: ['手机质量', '售后服务差'],
        severity: 'AMBER',
      },
      {
        id: 'xm-airconditioner-fell',
        description: 'Air conditioner fell (2024)',
        category: 'product',
        keywords: ['空调', '坠落', '共振', '200元'],
        severity: 'AMBER',
      },
      // REGULATORY (6)
      {
        id: 'xm-india-app-ban',
        description: 'India app ban (2020)',
        category: 'regulatory',
        keywords: ['Mi Video Call', '印度', '59款', '信息技术法'],
        severity: 'AMBER',
      },
      {
        id: 'xm-bsi-censorship',
        description: 'Germany BSI censorship probe (2021)',
        category: 'regulatory',
        keywords: ['BSI', '审查', 'censorship', '德国'],
        severity: 'AMBER',
      },
      {
        id: 'xm-agcm-warranty-fine',
        description: 'Italy AGCM warranty fine EUR 3.2M (2022)',
        category: 'regulatory',
        keywords: ['意大利', 'AGCM', '320万欧元', 'warranty'],
        severity: 'AMBER',
      },
      {
        id: 'xm-jiefu-ruitong',
        description: 'Jiefu Ruitong payment fine (2022)',
        category: 'regulatory',
        keywords: ['捷付睿通', '人民银行', '呼和浩特', '12万'],
        severity: 'AMBER',
      },
      {
        id: 'xm-false-advertising',
        description: 'False advertising penalties (2022)',
        category: 'regulatory',
        keywords: ['虚假广告', '国家级', '最高级', '绝对化用语'],
        severity: 'AMBER',
      },
      {
        id: 'xm-taiwan-redmi-fraud',
        description: 'Taiwan Redmi sales fraud fine (2014)',
        category: 'regulatory',
        keywords: ['台灣小米', '红米', '60万', '公平交易'],
        severity: 'AMBER',
      },
      // TAX (3)
      {
        id: 'xm-mof-accounting',
        description: 'MoF accounting irregularities (2018)',
        category: 'tax',
        keywords: ['财政部', '会计', '报销', '礼品'],
        severity: 'AMBER',
      },
      {
        id: 'xm-india-tax-evasion',
        description: 'India tax evasion multi-case (2019-2023)',
        category: 'tax',
        keywords: ['印度', '逃税', '800亿', 'INR', 'royalty'],
        severity: 'RED',
      },
      {
        id: 'xm-dri-import-tax',
        description: 'DRI import tax + frozen funds (2022)',
        category: 'tax',
        keywords: ['DRI', '进口税', '65.3亿', '冻结'],
        severity: 'RED',
      },
      // ANTITRUST (2)
      {
        id: 'xm-cci-collusion',
        description: 'India CCI collusion (2024)',
        category: 'antitrust',
        keywords: ['CCI', 'Competition Commission', 'Amazon', 'Flipkart', '反垄断'],
        severity: 'AMBER',
      },
      {
        id: 'xm-uokik-pricefixing',
        description: 'Poland UOKiK price-fixing (2024)',
        category: 'antitrust',
        keywords: ['UOKiK', '波兰', '价格固定', 'Xiaomi Polska'],
        severity: 'AMBER',
      },
      // LITIGATION (7)
      {
        id: 'xm-noyb-gdpr',
        description: 'Noyb EU data privacy (2025)',
        category: 'litigation',
        keywords: ['Noyb', 'GDPR', '数据传输', '奥地利'],
        severity: 'AMBER',
      },
      {
        id: 'xm-tianmi-crossstrait',
        description: 'Beijing Tianmi Taiwan Cross-Strait (2024)',
        category: 'litigation',
        keywords: ['田米', '臺灣', '聚晶半導體', '兩岸'],
        severity: 'RED',
      },
      {
        id: 'xm-patent-infringement-2024',
        description: 'Patent infringement suits (2024)',
        category: 'litigation',
        keywords: ['专利侵权', '2024', '被诉'],
        severity: 'AMBER',
      },
      {
        id: 'xm-fractus-netherlands',
        description: 'Fractus patent Netherlands (2019)',
        category: 'litigation',
        keywords: ['Fractus', '荷兰', '天线', 'monopole'],
        severity: 'AMBER',
      },
      {
        id: 'xm-yuangongyi-patent',
        description: 'Yuan Gong Yi patent suit (2018)',
        category: 'litigation',
        keywords: ['袁弓夷', '专利', '北京知识产权'],
        severity: 'AMBER',
      },
      {
        id: 'xm-coolpad-patent',
        description: 'Coolpad patent suits (2018-2020)',
        category: 'litigation',
        keywords: ['酷派', 'Coolpad', '专利', '撤诉'],
        severity: 'AMBER',
      },
      {
        id: 'xm-ericsson-india-ban',
        description: 'Ericsson India sales ban (2014)',
        category: 'litigation',
        keywords: ['Ericsson', '爱立信', '德里', '禁售'],
        severity: 'AMBER',
      },
      // IP (1)
      {
        id: 'xm-zunpai-tradesecret',
        description: 'Zunpai trade secret (2023)',
        category: 'ip',
        keywords: ['尊湃', '商业秘密', '瀚星', '芯片'],
        severity: 'AMBER',
      },
    ],
  },
];

// Find benchmark case by subject or alias
export function getBenchmarkCase(subject: string): BenchmarkCase | undefined {
  return BENCHMARK_CASES.find(c =>
    c.subject === subject || c.aliases?.includes(subject)
  );
}

// Evaluate screening results against benchmark
export function evaluateBenchmark(
  subject: string,
  findings: ConsolidatedFinding[],
  runId: string
): BenchmarkResult | null {
  const benchmark = getBenchmarkCase(subject);
  if (!benchmark) return null;

  const matchedIssues: string[] = [];
  const missedIssues: string[] = [];

  // Check each expected issue
  for (const expected of benchmark.expectedIssues) {
    const found = findings.some(finding => {
      // Check if any keyword appears in headline or summary
      const text = `${finding.headline} ${finding.summary}`.toLowerCase();
      return expected.keywords.some(kw => text.includes(kw.toLowerCase()));
    });

    if (found) {
      matchedIssues.push(expected.description);
    } else {
      missedIssues.push(expected.description);
    }
  }

  const recall = benchmark.expectedIssues.length > 0
    ? matchedIssues.length / benchmark.expectedIssues.length
    : 1;

  return {
    subject,
    runId,
    timestamp: new Date().toISOString(),
    expectedCount: benchmark.expectedIssues.length,
    foundCount: matchedIssues.length,
    recall: Math.round(recall * 100) / 100,
    matchedIssues,
    missedIssues,
  };
}
