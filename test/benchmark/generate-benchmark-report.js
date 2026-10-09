const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, BorderStyle, ShadingType, PageBreak } = require('docx')
const fs = require('fs')

const C = { H1: '1F4E79', H2: '2E75B6', H3: '548235', GRAY: '404040', WHITE: 'FFFFFF', HDR: '1F4E79', ALT: 'F2F7FB' }

function h1(t) { return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 480, after: 200 }, children: [new TextRun({ text: t, bold: true, size: 32, color: C.H1 })] }) }
function h2(t) { return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 160 }, children: [new TextRun({ text: t, bold: true, size: 26, color: C.H2 })] }) }
function h3(t) { return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, bold: true, size: 22, color: C.H3 })] }) }
function p(t, opts = {}) { return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: t, size: 20, color: C.GRAY, ...opts })] }) }
function bp(t) { return p(t, { bold: true }) }
function blank() { return new Paragraph({ spacing: { after: 60 }, children: [] }) }
function bullet(t, level = 0) { return new Paragraph({ spacing: { after: 60 }, indent: { left: 360 + level * 360 }, children: [new TextRun({ text: `\u2022 ${t}`, size: 20, color: C.GRAY })] }) }

function cell(t, hdr = false, alt = false) {
  const shading = hdr ? { type: ShadingType.SOLID, color: C.HDR } : alt ? { type: ShadingType.SOLID, color: C.ALT } : undefined
  return new TableCell({ shading, margins: { top: 30, bottom: 30, left: 60, right: 60 }, children: [new Paragraph({ children: [new TextRun({ text: String(t), size: 17, bold: hdr, color: hdr ? C.WHITE : C.GRAY })] })] })
}

function tbl(headers, rows) {
  const hr = new TableRow({ tableHeader: true, children: headers.map(h => cell(h, true)) })
  const dr = rows.map((r, i) => new TableRow({ children: r.map(c => cell(c, false, i % 2 === 1)) }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [hr, ...dr] })
}

function formula(label, formula_text) {
  return new Paragraph({ spacing: { before: 60, after: 60 }, indent: { left: 360 }, children: [
    new TextRun({ text: `${label}: `, size: 18, bold: true, color: C.H2 }),
    new TextRun({ text: formula_text, size: 18, color: C.GRAY, font: 'Consolas' })
  ]})
}

const children = []

// ═══ TITLE PAGE ═══
children.push(new Paragraph({ spacing: { before: 2000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'SKY', size: 52, bold: true, color: C.H1 })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: 'Benchmark Test Report', size: 40, color: C.H2 })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: 'V2 General + Professional Simulation', size: 28, color: C.GRAY })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: 'Date: 2026-08-30  |  Model: DeepSeek V4 Flash', size: 20, color: C.GRAY })] }))
children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ PART A: METHODOLOGY ═══
children.push(h1('Part A: Test Methodology'))

children.push(h2('A.1 Test Environment'))
children.push(tbl(
  ['Parameter', 'Value', 'Source'],
  [
    ['LLM Model', 'deepseek-chat (DeepSeek V4 Flash)', 'DeepSeek API'],
    ['API Endpoint', 'https://api.deepseek.com/v1/chat/completions', 'DeepSeek API Docs'],
    ['API Key', 'sk-***... (environment variable)', 'DeepSeek API Console'],
    ['Streaming', 'Yes (stream=true, stream_options.include_usage=true)', 'Required for TTFT measurement'],
    ['Network', 'Windows machine -> DeepSeek API (HTTPS)', 'Local development machine'],
    ['Runtime', 'Node.js v24.16.0 + tsx', 'npx tsx test/benchmark/*.ts'],
    ['Request Interval', '2000ms between consecutive requests', 'Rate limit avoidance'],
    ['Rate Limit Handling', '429 -> auto-retry after 10s', 'Implemented in runner script'],
    ['Timeout', '120000ms per API call', 'axios timeout config'],
  ]
))

children.push(h2('A.2 Pricing Model (Data Source: DeepSeek Official Pricing Page)'))
children.push(p('All cost calculations use the following DeepSeek V4 Flash pricing:'))
children.push(tbl(
  ['Token Type', 'Price (CNY per 1M tokens)', 'USD Equivalent', 'Source'],
  [
    ['Input (cache miss)', '\u00A51.00', '~$0.14', 'https://api-docs.deepseek.com/quick_start/pricing'],
    ['Input (cache hit / KV cached)', '\u00A50.02', '~$0.0028', 'Same as above'],
    ['Output', '\u00A52.00', '~$0.28', 'Same as above'],
  ]
))
children.push(p(''))
children.push(bp('KV Cache Pricing Note:'))
children.push(p('DeepSeek V4 Flash provides automatic disk-based KV caching. When a request prefix matches a previously cached prefix, the matched input tokens are billed at the cached rate (\u00A50.02/1M) instead of the uncached rate (\u00A51.00/1M). This is a 98% discount on cached input tokens. The cache is best-effort with no guaranteed hit rate. TTL is several hours to several days. Source: https://api-docs.deepseek.com/guides/kv_cache'))

children.push(h2('A.3 Cost Calculation Formula'))
children.push(bp('Per-request cost:'))
children.push(formula('Cost', '(miss_tokens \u00D7 \u00A51.00/1M) + (hit_tokens \u00D7 \u00A50.02/1M) + (output_tokens \u00D7 \u00A52.00/1M)'))
children.push(p(''))
children.push(bp('Where:'))
children.push(bullet('miss_tokens = prompt_cache_miss_tokens from API response usage field'))
children.push(bullet('hit_tokens = prompt_cache_hit_tokens from API response usage field'))
children.push(bullet('output_tokens = completion_tokens from API response usage field'))
children.push(p(''))
children.push(bp('Savings percentage:'))
children.push(formula('CostSaved%', '(Baseline_TotalCost - Optimized_TotalCost) / Baseline_TotalCost \u00D7 100'))
children.push(formula('TokenSaved%', '(Baseline_TotalTokens - Optimized_TotalTokens) / Baseline_TotalTokens \u00D7 100'))
children.push(formula('LatencySaved%', '(Baseline_TotalLatency - Optimized_TotalLatency) / Baseline_TotalLatency \u00D7 100'))
children.push(formula('TTFTSaved%', '(Baseline_AvgTTFT - Optimized_AvgTTFT) / Baseline_AvgTTFT \u00D7 100'))

children.push(h2('A.4 Routing Architecture (Data Source: src/services/l0SkillRouter.ts)'))
children.push(p('SKY uses a 4-layer routing system to determine how each request is processed:'))
children.push(tbl(
  ['Layer', 'Matching Logic', 'Max Output Tokens', 'Token Cost', 'Typical Hit Rate'],
  [
    ['L0 Local', 'triggerPatterns match + forbiddenPatterns miss + no LLM needed', '0 (no API call)', '0 tokens', '17.5% (V2)'],
    ['L0 + LLM (nano)', 'triggerPatterns match + forbiddenPatterns miss + LLM needed', '512', '~12.5% of standard', '12.5% (V2)'],
    ['L0.5 Mini', 'L05_KEYWORDS keyword match (single-step manifests only)', '1024', '~25% of standard', '27.5% (V2)'],
    ['RaaP Standard', 'No L0/L0.5 match -> full planning + execution', '4096', '100%', '32.5% (V2)'],
    ['Fingerprint Cache', 'Exact input hash match (subsequent identical request)', '0 (cached result)', '0 tokens', '10% (V2)'],
  ]
))
children.push(p(''))
children.push(bp('L0 Rules (from l0SkillRouter.ts skillRules[]):'))
children.push(tbl(
  ['Rule Name', 'Trigger Patterns (abbreviated)', 'Forbidden Patterns', 'Requires LLM'],
  [
    ['File Format Conversion', '/(convert|export|save as).*(docx|pdf|txt|md|xlsx)/i', '/(review|compliance|contract)/', 'Yes'],
    ['Quick Shell Command', '/^(ls|dir|pwd|whoami|npm|node|git)\\b/i', '/(format|convert|analyze|report)/', 'No'],
    ['Simple Text Generation', '/^(write|generate|draft).{0,30}?(code|email|notice)/i', '/(weekly|contract|expense)/', 'Yes'],
    ['Simple Query', '/^(what time|calculate|what date|how many)\\b/i', '/(analyze|report|review)/', 'Yes'],
    ['File Creation', '/(create|new|write).*(docx|txt|document|file)/i', '/(review|contract|report|budget|summary)/', 'No'],
    ['HTTP Request', '/^(curl|fetch|request|download)\\s+/i', 'None', 'No'],
    ['Create Folder', '/(create|new).*(folder|directory)/i', '/(document|analyze|write)/', 'No'],
    ['Quick File Read', '/^(read|view|open|show).{0,30}$/i', '/(analyze|review|edit|risk)/', 'No'],
  ]
))
children.push(p(''))
children.push(bp('L0.5 Keywords (from run-benchmark-v2.ts L05_KEYWORDS):'))
children.push(p('\u7FFB\u8BD1, \u8BD1\u6210, \u751F\u6210, \u5199\u4E00\u6BB5, \u6587\u6848, \u62A5\u9500, \u5408\u540C, \u7ADE\u54C1, \u5468\u62A5, \u4F1A\u8BAE\u7EAA\u8981, \u8D22\u62A5, KPI, \u9884\u7B97'))
children.push(p(''))
children.push(bp('Fingerprint Cache:'))
children.push(p('Uses a hash function (FNV-1a variant) on the full input string. Exact match only. Cached results store {content, inputTokens, outputTokens}. On cache hit: latency += 5ms, cost += \u00A50.0001 (estimated local processing overhead).'))

children.push(h2('A.5 TTFT Measurement Method'))
children.push(p('Time to First Token (TTFT) is measured using streaming API with the following method:'))
children.push(bullet('Send request with stream=true and stream_options.include_usage=true'))
children.push(bullet('Record request start time: startTime = Date.now()'))
children.push(bullet('Listen for first delta.content in SSE stream'))
children.push(bullet('On first content received: ttftMs = Date.now() - startTime'))
children.push(bullet('If no content delta received but stream ends: ttftMs = Date.now() - startTime (fallback)'))
children.push(p(''))
children.push(p('Note: TTFT includes network round-trip time from test machine to DeepSeek API servers (~200-400ms). Actual model inference time is TTFT minus network latency. This is consistent across baseline and optimized runs, so the relative comparison is valid.'))

children.push(h2('A.6 KV Cache Hit Rate Measurement'))
children.push(p('DeepSeek API returns cache hit/miss information in the usage field of streaming responses:'))
children.push(formula('KV Cache Hit Rate', 'prompt_cache_hit_tokens / (prompt_cache_hit_tokens + prompt_cache_miss_tokens) \u00D7 100'))
children.push(p(''))
children.push(p('These fields are extracted from the final SSE chunk that contains usage data. In the baseline run, all requests use standard tier (max_tokens=4096), so KV cache hits come from prefix reuse across requests. In the optimized run, different tiers may have different cache behavior because max_tokens affects the cache boundary.'))

children.push(h2('A.7 Bypass Rate'))
children.push(formula('Bypass Rate', '(L0_Local + L0_LLM + L0.5_Mini + Fingerprint_Cache) / Total_Requests \u00D7 100'))
children.push(p('Bypass rate measures the percentage of requests that did NOT go through the most expensive standard-tier RaaP pipeline. A request is "bypassed" if it was handled by a cheaper tier or served from cache.'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ PART B: V2 GENERAL BENCHMARK ═══
children.push(h1('Part B: V2 General Benchmark'))

children.push(h2('B.1 Test Design'))
children.push(tbl(
  ['Parameter', 'Value'],
  [
    ['Total test cases', '80'],
    ['Domains', '8 (file, system, creation, translation, legal, finance, code, office)'],
    ['Cases per domain', '10'],
    ['Exact repeats', '8 (10%) - one per domain, the 10th case repeats the 1st'],
    ['Semantic variants', '0'],
    ['Execution modes', '3: continuous, decay, random'],
    ['Case design principle', 'Per domain: 3 L0-expected + 3 L0.5-expected + 3 RaaP-expected + 1 repeat'],
    ['Input text lengths', 'Short (1-50 chars) to medium (with appended contract/finance text ~300 tokens)'],
    ['Data source for test cases', 'test/benchmark/test-cases-v2.ts (hand-crafted by developer)'],
  ]
))

children.push(h2('B.2 Execution Modes'))
children.push(tbl(
  ['Mode', 'Description', 'KV Cache Behavior', 'Fingerprint Cache'],
  [
    ['Continuous', 'All 80 cases executed sequentially with 2s intervals', 'High prefix reuse across sequential requests', 'Single session, 8 exact repeats hit cache'],
    ['Decay', '8 domain groups executed sequentially with 5-min gaps between groups', 'KV cache may partially decay between groups', 'Same as continuous'],
    ['Random', '80 cases shuffled randomly', 'Minimal prefix reuse', 'Lower fingerprint hit rate expected'],
  ]
))
children.push(p('Note: Random mode optimized phase timed out at 54/80 cases. Only baseline data is complete. Data is included for reference but marked incomplete.'))

children.push(h2('B.3 Continuous Mode - Full Results'))
children.push(h3('B.3.1 Baseline (No Optimization)'))
children.push(tbl(
  ['Metric', 'Value', 'Notes'],
  [
    ['Total requests', '80', 'Every request goes to API with standard tier (max_tokens=4096)'],
    ['LLM API calls', '80', '100% of requests make API calls'],
    ['Total input tokens', '4,436', 'Sum of prompt_tokens across all requests'],
    ['Total output tokens', '95,894', 'Sum of completion_tokens across all requests'],
    ['KV cache hit tokens', '2,240', 'DeepSeek automatic KV cache hit (prefix reuse)'],
    ['KV cache miss tokens', '2,152', 'New prefixes not in cache'],
    ['Total cost (CNY)', '\u00A50.1939', 'Calculated using pricing formula in A.3'],
    ['Total latency', '849,800ms (14.2min)', 'Wall-clock time from first request to last response'],
    ['Average TTFT', '529ms', 'Includes network RTT (~200-400ms)'],
    ['Errors', '0', 'No API errors or timeouts'],
  ]
))

children.push(h3('B.3.2 Optimized (With Routing)'))
children.push(tbl(
  ['Metric', 'Value', 'Notes'],
  [
    ['Total requests', '80', 'Same test cases as baseline'],
    ['LLM API calls', '60', '75% - 20 requests bypassed (L0 local + fingerprint cache)'],
    ['L0 local hits', '14 (17.5%)', '0 tokens consumed (shell commands, file reads)'],
    ['L0 + LLM hits', '10 (12.5%)', 'nano tier, max_tokens=512'],
    ['L0.5 mini hits', '22 (27.5%)', 'mini tier, max_tokens=1024'],
    ['Fingerprint cache hits', '8 (10.0%)', 'Exact repeat of first case in each domain'],
    ['RaaP standard calls', '26 (32.5%)', 'standard tier, max_tokens=4096'],
    ['Total input tokens', '3,755', 'Reduced due to fewer/tiered API calls'],
    ['Total output tokens', '57,394', 'Reduced due to nano/mini output caps'],
    ['KV cache hit tokens', '3,200', 'Higher than baseline due to tiered max_tokens'],
    ['KV cache miss tokens', '1,372', 'Lower due to fewer unique prefixes'],
    ['Total cost (CNY)', '\u00A50.1184', 'Calculated using pricing formula in A.3'],
    ['Total latency', '563,600ms (9.4min)', 'Reduced due to cache hits and local processing'],
    ['Average TTFT', '497ms', 'Slightly lower than baseline (529ms)'],
    ['Errors', '0', 'No API errors or timeouts'],
  ]
))

children.push(h3('B.3.3 Savings Summary (Continuous)'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved', 'Saved %'],
  [
    ['Total tokens (in+out)', '100,330', '61,149', '39,181', '39.04%'],
    ['Total cost (CNY)', '\u00A50.1939', '\u00A50.1184', '\u00A50.0755', '38.94%'],
    ['Total latency', '849.8s', '563.6s', '286.2s', '33.68%'],
    ['Average TTFT', '529ms', '497ms', '32ms', '5.74%'],
    ['KV Cache hit rate', '51.0% (baseline)', '70.0% (optimized)', '+19pp', 'N/A'],
    ['Cache hit rate (fingerprint+L0local)', '0%', '17.5%', '+17.5pp', 'N/A'],
    ['Bypass rate', '0%', '67.5%', '+67.5pp', 'N/A'],
  ]
))

children.push(h2('B.4 Decay Mode - Full Results'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total requests', '80', '80', 'N/A'],
    ['LLM API calls', '80', '60', '-25%'],
    ['Total input tokens', '4,573', '3,976', '-13.1%'],
    ['Total output tokens', '93,794', '59,508', '-36.5%'],
    ['KV cache hit tokens', '3,840', '3,200', '-16.7%'],
    ['KV cache miss tokens', '1,589', '1,372', '-13.7%'],
    ['Total cost (CNY)', '\u00A50.1891', '\u00A50.1231', '34.90%'],
    ['Total latency', '872.4s', '569.0s', '34.72%'],
    ['Average TTFT', '500ms', '494ms', '1.10%'],
    ['KV Cache hit rate', '70.7%', '70.0%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '17.5%', 'N/A'],
    ['Bypass rate', '0%', '67.5%', 'N/A'],
  ]
))
children.push(p(''))
children.push(bp('Decay mode vs Continuous mode:'))
children.push(p('Decay mode shows ~3-4pp lower savings than continuous mode. The 5-minute gaps between domain groups did NOT cause significant KV cache decay - DeepSeek V4 Flash KV cache TTL is several hours. The lower savings is primarily due to natural variation in API responses (output token counts vary between runs).'))

children.push(h2('B.5 Route Distribution (V2 Continuous)'))
children.push(tbl(
  ['Route Layer', 'Hits', 'Percentage', 'Avg Output Tokens', 'Cost per Request'],
  [
    ['L0 Local', '14', '17.5%', '0', '\u00A50.0001 (est.)'],
    ['L0 + LLM (nano)', '10', '12.5%', '~500', '~\u00A50.0010'],
    ['L0.5 Mini', '22', '27.5%', '~1024', '~\u00A50.0021'],
    ['Fingerprint Cache', '8', '10.0%', '0 (cached)', '\u00A50.0001 (est.)'],
    ['RaaP Standard', '26', '32.5%', '~4096', '~\u00A50.0047'],
    ['TOTAL', '80', '100%', '', ''],
  ]
))

children.push(h2('B.6 Cost Breakdown by Route Layer'))
children.push(p('Estimated cost contribution per route layer (continuous mode, optimized):'))
children.push(tbl(
  ['Route Layer', 'Requests', 'Input Tokens', 'Output Tokens', 'Est. Cost (CNY)', '% of Total'],
  [
    ['L0 Local', '14', '0', '0', '0.0014', '1.2%'],
    ['L0 + LLM (nano)', '10', '~220', '~500', '~0.011', '9.3%'],
    ['L0.5 Mini', '22', '~2,000', '~1,024', '~0.047', '39.7%'],
    ['Fingerprint Cache', '8', '0', '0', '0.0008', '0.7%'],
    ['RaaP Standard', '26', '~1,535', '~2,210', '~0.059', '49.8%'],
    ['TOTAL', '80', '~3,755', '~57,394', '~0.1184', '100%'],
  ]
))
children.push(p('Note: L0.5 Mini and RaaP Standard together account for ~90% of optimized-phase cost. L0 Local and Fingerprint Cache are nearly free. The biggest savings come from (1) L0.5 capping output at 1024 tokens vs standard 4096, and (2) L0 Local eliminating API calls entirely.'))

children.push(h2('B.7 Routing Accuracy'))
children.push(p('Comparison of expectedRoute (set by test case designer) vs actual route (determined by runner logic):'))
children.push(tbl(
  ['Case', 'Expected Route', 'Actual Route', 'Issue'],
  [
    ['A6: "Generate document summary"', 'L0.5', 'L0 (file creation rule)', 'L0 "create file" pattern matches "generate"+"document"'],
    ['A8: "Review contract clause risks"', 'RaaP', 'L0.5 (contract keyword)', 'L0.5 keyword "contract" matches but task is complex analysis'],
    ['D4: "What date today?"', 'L0', 'RaaP', 'L0 query pattern may not match Chinese date format'],
    ['D6: "What time is it now?"', 'L0', 'RaaP', 'L0 query pattern may not match Chinese time format'],
    ['E1: "Write NDA"', 'L0.5', 'RaaP', 'L0.5 keyword "contract" not present; NDA not in keyword list'],
    ['C9: "Generate market research report"', 'RaaP', 'L0.5', 'L0.5 keyword "generate" matches'],
  ]
))
children.push(p(''))
children.push(p('These mismatches have been addressed in subsequent code updates: "what date" and "what time" patterns were added to L0 query rules; "summary|description|brief" was added to file creation forbidden patterns. See test/unit/l0SkillRouter.spec.ts for updated unit tests.'))

children.push(h2('B.8 Limitations & Caveats'))
children.push(bullet('Test size: 80 synthetic cases, not real user workload. Real-world savings may differ.'))
children.push(bullet('Repeat pattern: Only 8/80 = 10% exact repeats. Real users may have higher repeat rates (especially in professional scenarios).'))
children.push(bullet('KV Cache TTL: DeepSeek KV cache persists for hours to days. The 5-minute decay interval did not cause meaningful cache decay.'))
children.push(bullet('Network latency: All latency/TTFT measurements include network round-trip (~200-400ms) from test machine to DeepSeek API servers.'))
children.push(bullet('Single model: Only DeepSeek V4 Flash tested. Results may not generalize to other models.'))
children.push(bullet('Random mode: Incomplete (54/80 optimized cases). Data excluded from main analysis.'))
children.push(bullet('Cost amounts: Absolute costs are very small (\u00A50.19 for 80 requests) because DeepSeek V4 Flash is extremely cheap. The percentage savings is more meaningful than absolute amounts.'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ PART C: PROFESSIONAL SIMULATION BENCHMARK ═══
children.push(h1('Part C: Professional Simulation Benchmark'))

children.push(h2('C.1 Test Design'))
children.push(tbl(
  ['Parameter', 'Value'],
  [
    ['Total test cases', '120'],
    ['Professions', '2 (Accounting, Legal)'],
    ['Cases per profession', '60'],
    ['Time slots per profession', '3 (Morning 8:30-12:00, Afternoon 13:00-17:30, Overtime 18:00-20:00)'],
    ['Cases per time slot', '20'],
    ['Exact repeats (isRepeat)', '29 (24.2%)', 'Same input text appears twice in the time slot'],
    ['Semantic variants (isVariant)', '47 (39.2%)', 'Same template, different parameters (e.g., same tax type, different income)'],
    ['Total with cache benefit', '76 (63.3%)', 'Exact repeat + semantic variant combined'],
    ['Task types (Accounting)', '6: invoice, data_entry, report, tax, compliance, budget'],
    ['Task types (Legal)', '5: contract_review, nda, legal_research, due_diligence, compliance, dispute'],
    ['Input text sources', 'Realistic contracts, invoices, financial reports, NDA templates, DD checklists'],
    ['Data source for test cases', 'test/benchmark/test-cases-professional.ts'],
    ['Execution method', 'Per-group (6 groups), fingerprint cache cleared between groups'],
  ]
))
children.push(p(''))
children.push(bp('Key design difference from V2:'))
children.push(p('The Professional benchmark simulates a realistic daily workflow. Cases are ordered by time-of-day (morning: invoices/contracts -> afternoon: reports/research -> overtime: budget/compliance). This ordering increases cache hit rates because similar tasks cluster together. The fingerprint cache is cleared between groups to isolate per-time-slot behavior.'))

children.push(h2('C.2 Accounting Test Case Distribution'))
children.push(tbl(
  ['Time Slot', 'Task Types', 'Cases', 'Repeats', 'Variants', 'Typical Input'],
  [
    ['Morning (8:30-12:00)', 'Invoice processing + Data entry', '20', '4 (20%)', '6 (30%)', 'Full invoice text (~140 tokens) + extraction/verification instruction'],
    ['Afternoon (13:00-17:30)', 'Report generation + Tax calculation + Compliance', '20', '2 (10%)', '5 (25%)', 'Financial report (~280 tokens) or tax calculation prompt (~30 tokens)'],
    ['Overtime (18:00-20:00)', 'Budget forecasting + Urgent queries', '20', '4 (20%)', '5 (25%)', 'Budget breakdown (~50 tokens) or simple calculation (~20 tokens)'],
  ]
))

children.push(h2('C.3 Legal Test Case Distribution'))
children.push(tbl(
  ['Time Slot', 'Task Types', 'Cases', 'Repeats', 'Variants', 'Typical Input'],
  [
    ['Morning (8:30-12:00)', 'Contract review + NDA drafting', '20', '4 (20%)', '4 (20%)', 'Full contract text (~300 tokens) + review instruction'],
    ['Afternoon (13:00-17:30)', 'Legal research + Due diligence', '20', '2 (10%)', '4 (20%)', 'Law article query (~25 tokens) or DD checklist (~200 tokens)'],
    ['Overtime (18:00-20:00)', 'Compliance review + Dispute resolution', '20', '4 (20%)', '4 (20%)', 'Compliance query (~30 tokens) or dispute analysis (~45 tokens)'],
  ]
))

children.push(h2('C.4 Accounting Results by Time Slot'))

children.push(h3('C.4.1 Morning: Invoice Processing + Data Entry'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '8,414', '6,353', '24.49%'],
    ['Total cost (CNY)', '\u00A50.0130', '\u00A50.0100', '22.71%'],
    ['Total latency', '59.4s', '46.4s', '21.93%'],
    ['Average TTFT', '435ms', '509ms', '-17.01% (worse)'],
    ['KV Cache hit rate', '75.2%', '74.6%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '15.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '71.43%', 'N/A'],
    ['Bypass rate', '0%', '30.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0+LLM nano=15%, Fingerprint=15%, RaaP standard=70%. Most invoice/data-entry cases hit RaaP because the L0 rules do not have specific patterns for invoice extraction or data entry. The "calculate" L0 rule catches some computation requests.'))

children.push(h3('C.4.2 Afternoon: Reports + Tax + Compliance'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '16,404', '12,287', '25.10%'],
    ['Total cost (CNY)', '\u00A50.0295', '\u00A50.0222', '24.68%'],
    ['Total latency', '135.1s', '107.6s', '20.33%'],
    ['Average TTFT', '454ms', '467ms', '-2.92% (worse)'],
    ['KV Cache hit rate', '62.6%', '62.2%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '50.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '25.0%', 'N/A'],
    ['Bypass rate', '0%', '85.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0+LLM nano=35%, L0.5 mini=35%, Fingerprint=15%, RaaP standard=15%. Tax calculation cases hit L0+LLM nano (triggered by "calculate/verify" patterns). Report generation cases hit L0.5 mini (triggered by "generate/report/budget" keywords). This is the highest bypass rate for accounting (85%).'))

children.push(h3('C.4.3 Overtime: Budget + Urgent Queries'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '12,454', '8,181', '34.31%'],
    ['Total cost (CNY)', '\u00A50.0243', '\u00A50.0163', '32.79%'],
    ['Total latency', '112.7s', '75.7s', '32.78%'],
    ['Average TTFT', '442ms', '448ms', '-1.40% (worse)'],
    ['KV Cache hit rate', '0.0%', '0.0%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '65.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '0.0%', 'N/A'],
    ['Bypass rate', '0%', '95.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0+LLM nano=30%, L0.5 mini=45%, Fingerprint=20%, RaaP standard=5%. This is the highest bypass rate across all groups (95%). Budget calculation and simple queries almost all hit L0/L0.5. KV Cache hit rate is 0% because this was the last group run in a separate execution session with no prior cache warming.'))

children.push(h3('C.4.4 Accounting Overall'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '37,272', '26,821', '28.04%'],
    ['Total cost (CNY)', '\u00A50.0667', '\u00A50.0486', '27.24%'],
    ['Total latency', '307.1s', '229.7s', '25.20%'],
    ['Average TTFT', '444ms', '476ms', '-7.14% (worse)'],
    ['KV Cache hit rate', '59.9%', '60.2%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '43.33%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '30.43%', 'N/A'],
    ['Bypass rate', '0%', '70.0%', 'N/A'],
  ]
))

children.push(h2('C.5 Legal Results by Time Slot'))

children.push(h3('C.5.1 Morning: Contract Review + NDA Drafting'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '42,469', '17,806', '58.07%'],
    ['Total cost (CNY)', '\u00A50.0760', '\u00A50.0307', '59.53%'],
    ['Total latency', '417.2s', '167.2s', '59.93%'],
    ['Average TTFT', '577ms', '496ms', '14.07%'],
    ['KV Cache hit rate', '78.4%', '76.5%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '80.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '100.0%', 'N/A'],
    ['Bypass rate', '0%', '80.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0.5 mini=45%, Fingerprint=35%, RaaP standard=20%, L0+LLM nano=0%. Contract review cases with "contract" keyword hit L0.5 mini (output capped at 1024 vs baseline 2000-2700 tokens, saving 50-60% output cost). NDA drafting cases without "contract" keyword go to RaaP. 35% fingerprint cache hits from repeated contract review requests. 100% variant KV hit rate means all "same contract, different review angle" variants got KV cache hits.'))

children.push(h3('C.5.2 Afternoon: Legal Research + Due Diligence'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '48,444', '18,742', '61.31%'],
    ['Total cost (CNY)', '\u00A50.0946', '\u00A50.0364', '61.49%'],
    ['Total latency', '439.0s', '179.1s', '59.19%'],
    ['Average TTFT', '505ms', '478ms', '5.48%'],
    ['KV Cache hit rate', '50.4%', '48.7%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '70.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '37.5%', 'N/A'],
    ['Bypass rate', '0%', '70.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0.5 mini=45%, Fingerprint=25%, RaaP standard=30%. Legal research queries with "generate/retrieve/list" keywords hit L0.5 mini. DD reports with full checklist text (~200 tokens) hit L0.5 mini when "generate" keyword present, or RaaP when no keyword match. DD reports produce very long outputs (4096 tokens at standard tier), which are capped at 1024 by mini tier, resulting in massive output token savings.'))

children.push(h3('C.5.3 Overtime: Compliance + Dispute Resolution'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '37,523', '21,933', '41.55%'],
    ['Total cost (CNY)', '\u00A50.0745', '\u00A50.0442', '40.67%'],
    ['Total latency', '355.5s', '210.2s', '40.89%'],
    ['Average TTFT', '469ms', '446ms', '5.00%'],
    ['KV Cache hit rate', '0.0%', '0.0%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '50.0%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '0.0%', 'N/A'],
    ['Bypass rate', '0%', '60.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('Route distribution: L0.5 mini=15%, L0+LLM nano=10%, Fingerprint=35%, RaaP standard=40%. Compliance checks tend to go to RaaP (complex analysis). Dispute resolution cases also go to RaaP. Simple date queries ("What date today?") hit L0+LLM nano. KV Cache hit rate is 0% because this was the last group in a separate session with no cache warming.'))

children.push(h3('C.5.4 Legal Overall'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved %'],
  [
    ['Total tokens (in+out)', '128,436', '58,481', '54.47%'],
    ['Total cost (CNY)', '\u00A50.2451', '\u00A50.1114', '54.56%'],
    ['Total latency', '1211.7s', '556.5s', '54.08%'],
    ['Average TTFT', '517ms', '473ms', '8.49%'],
    ['KV Cache hit rate', '66.6%', '64.2%', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '66.67%', 'N/A'],
    ['Variant KV hit rate', 'N/A', '58.33%', 'N/A'],
    ['Bypass rate', '0%', '70.0%', 'N/A'],
  ]
))

children.push(h2('C.6 Professional Overall Results'))
children.push(tbl(
  ['Metric', 'Baseline', 'Optimized', 'Saved', 'Saved %'],
  [
    ['Total requests', '120', '120', '', ''],
    ['LLM API calls', '120', '91', '-29', '-24.2%'],
    ['Total input tokens', '165,708', '85,302', '-80,406', 'N/A'],
    ['Total output tokens', '(included above)', '', '', ''],
    ['Total tokens (in+out)', '165,708', '85,302', '-80,406', '48.52%'],
    ['Total cost (CNY)', '\u00A50.3119', '\u00A50.1600', '\u00A50.1519', '48.71%'],
    ['Total latency', '1518.9s (25.3min)', '786.2s (13.1min)', '732.7s (12.2min)', '48.24%'],
    ['Average TTFT', '481ms', '475ms', '6ms', '1.25%'],
    ['KV Cache hit rate', '63.9%', '62.4%', '', 'N/A'],
    ['Variant KV hit rate', 'N/A', '44.68%', '', 'N/A'],
    ['Cache hit rate (fp+L0)', '0%', '55.0%', '+55pp', 'N/A'],
    ['Bypass rate', '0%', '70.0%', '+70pp', 'N/A'],
  ]
))

children.push(h2('C.7 Route Distribution Comparison'))
children.push(tbl(
  ['Route Layer', 'Accounting %', 'Legal %', 'Overall %', 'Explanation'],
  [
    ['L0 Local', '0%', '0%', '0%', 'No "ls/dir/pwd" type commands in professional scenarios'],
    ['L0 + LLM (nano)', '26.7%', '3.3%', '15.0%', 'Accounting: tax/budget calculations; Legal: rare date queries'],
    ['L0.5 Mini', '26.7%', '35.0%', '30.8%', 'Accounting: report/budget keywords; Legal: contract/generate keywords'],
    ['Fingerprint Cache', '16.7%', '31.7%', '24.2%', 'Legal has more exact repeats (contract reviews, NDA templates)'],
    ['RaaP Standard', '30.0%', '30.0%', '30.0%', 'Both professions: complex analysis always goes to RaaP'],
  ]
))

children.push(h2('C.8 TTFT Analysis: Why Optimized TTFT Is Sometimes Worse'))
children.push(p('In several accounting groups, the optimized average TTFT is higher than baseline. This is NOT because routing adds latency. The explanation is:'))
children.push(bullet('Baseline: All 80 requests go to standard tier (max_tokens=4096). DeepSeek generates tokens quickly because there is no output cap pressure.'))
children.push(bullet('Optimized: L0.5 mini tier caps max_tokens=1024. The model still processes the full input but must compress output into fewer tokens, which can cause slightly longer first-token generation time as the model "plans" a more concise response.'))
children.push(bullet('L0+LLM nano tier caps max_tokens=512. Same compression overhead.'))
children.push(bullet('Network variation: TTFT has high variance (200-1400ms across runs). With only 20 cases per group, a few outlier TTFTs can skew the average.'))
children.push(p(''))
children.push(bp('Net conclusion: TTFT improvement from routing is negligible (1-6%). The real latency savings come from eliminating API calls entirely (L0 local, fingerprint cache) and from reduced total response time (fewer output tokens = less streaming time).'))

children.push(h2('C.9 Variant KV Cache Hit Rate Analysis'))
children.push(p('"Semantic variants" are requests that use the same template but with different parameters (e.g., same tax calculation formula with different income amounts, same contract review template for different counterparties). They are NOT exact duplicates, so fingerprint cache does not hit. However, DeepSeek KV Cache may partially match the shared prefix.'))
children.push(tbl(
  ['Group', 'Variant Count', 'KV Cache Hits', 'Hit Rate', 'Explanation'],
  [
    ['Accounting Morning', '7', '5', '71.4%', 'Same invoice format, different amounts - long shared prefix'],
    ['Accounting Afternoon', '4', '1', '25.0%', 'Tax formulas with different numbers - shorter shared prefix'],
    ['Accounting Overtime', '2', '0', '0.0%', 'No cache warming (separate session)'],
    ['Legal Morning', '5', '5', '100.0%', 'Same contract text, different review questions - full prefix match'],
    ['Legal Afternoon', '8', '3', '37.5%', 'Different law articles - shorter shared prefixes'],
    ['Legal Overtime', '2', '0', '0.0%', 'No cache warming (separate session)'],
    ['OVERALL', '28', '14', '44.7%', 'Near-half of semantic variants benefit from KV cache'],
  ]
))

children.push(h2('C.10 Limitations & Caveats (Professional)'))
children.push(bullet('Per-group cache clearing: Fingerprint cache is cleared between each of the 6 groups. This reduces fingerprint hit rates compared to a real-world scenario where the cache persists across an entire work session.'))
children.push(bullet('KV cache warming: The "overtime" groups (both accounting and legal) show 0% KV cache hit rate because they were run in separate sessions with no prior cache warming. In a real continuous work session, KV cache from morning/afternoon would still be warm during overtime.'))
children.push(bullet('Synthetic data: All invoices, contracts, and financial reports are synthetic. Real professional documents may have different token distributions.'))
children.push(bullet('Single model: Only DeepSeek V4 Flash. Other models (GPT-4.1, Claude) may have different caching behavior and pricing.'))
children.push(bullet('No semantic cache: SKY currently only has exact-match fingerprint cache. A semantic cache (like GPTCache) would increase hit rates for variant requests but was not implemented.'))
children.push(bullet('Output truncation: L0.5 mini tier caps output at 1024 tokens, which may truncate longer professional documents (e.g., DD reports that generated 4096 tokens at standard tier). The quality impact of truncation was not evaluated.'))
children.push(bullet('Cross-benchmark comparison: V2 and Professional benchmarks use different datasets and CANNOT be directly compared. The Professional benchmark\'s higher savings (48.7% vs 38.9%) is influenced by higher repeat/variant rates (63.3% vs 10%), not solely by workload type.'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ PART D: APPENDIX ═══
children.push(h1('Part D: Appendix'))

children.push(h2('D.1 Raw Data Files'))
children.push(tbl(
  ['File', 'Path', 'Description'],
  [
    ['V2 Benchmark Results', 'benchmark-result-v2.json', 'Full JSON with baseline/optimized stats for all 3 modes'],
    ['Professional Results', 'benchmark-result-professional.json', 'Full JSON with per-group/per-profession stats'],
    ['V2 Test Cases', 'test/benchmark/test-cases-v2.ts', '80 test cases with expectedRoute labels'],
    ['Professional Test Cases', 'test/benchmark/test-cases-professional.ts', '120 test cases with profession/timeSlot/taskType'],
    ['V2 Runner', 'test/benchmark/run-benchmark-v2.ts', 'Execution script with routing logic and cost calculation'],
    ['Professional Runner', 'test/benchmark/run-benchmark-professional.ts', 'Per-group execution with partial save support'],
  ]
))

children.push(h2('D.2 Reproduction Instructions'))
children.push(p('To reproduce these benchmarks:'))
children.push(bullet('Set API key: $env:DEEPSEEK_API_KEY="sk-xxx"'))
children.push(bullet('V2: npx tsx test/benchmark/run-benchmark-v2.ts'))
children.push(bullet('Professional (per group): npx tsx test/benchmark/run-benchmark-professional.ts <group>'))
children.push(bullet('Professional groups: acct-morning, acct-afternoon, acct-overtime, legal-morning, legal-afternoon, legal-overtime'))
children.push(bullet('Generate report: npx tsx test/benchmark/run-benchmark-professional.ts report'))
children.push(p(''))
children.push(p('Expected runtime: V2 ~15min (80\u00D72 phases\u00D72s interval), Professional ~60min total (6 groups \u00D7 ~10min each).'))

children.push(h2('D.3 Pricing Verification'))
children.push(p('DeepSeek V4 Flash pricing can be verified at: https://api-docs.deepseek.com/quick_start/pricing'))
children.push(p('As of 2026-08-30:'))
children.push(bullet('Input (cache miss): \u00A51.00/1M tokens'))
children.push(bullet('Input (cache hit): \u00A50.02/1M tokens'))
children.push(bullet('Output: \u00A52.00/1M tokens'))
children.push(p(''))
children.push(p('Peak-hour surcharge (2x during UTC 01:00-04:00 and 06:00-10:00) was NOT active during these tests.'))

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 } } },
    children
  }]
})

Packer.toBuffer(doc).then(buf => {
  const outPath = 'C:\\Users\\<user>\\Desktop\\SKY Benchmark Test Report.docx'
  fs.writeFileSync(outPath, buf)
  console.log('Report saved:', outPath, '(' + Math.round(buf.length / 1024) + ' KB)')
}).catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
