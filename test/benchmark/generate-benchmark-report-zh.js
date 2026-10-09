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

// ═══ 封面 ═══
children.push(new Paragraph({ spacing: { before: 2000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'SKY', size: 52, bold: true, color: C.H1 })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: '\u57FA\u51C6\u6D4B\u8BD5\u62A5\u544A', size: 40, color: C.H2 })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: 'V2\u901A\u7528\u57FA\u51C6 + \u4E13\u4E1A\u5C97\u4F4D\u6A21\u62DF', size: 28, color: C.GRAY })] }))
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: '\u65E5\u671F: 2026-08-30  |  \u6A21\u578B: DeepSeek V4 Flash', size: 20, color: C.GRAY })] }))
children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ A\u90E8: \u6D4B\u8BD5\u65B9\u6CD5\u8BBA ═══
children.push(h1('A\u90E8: \u6D4B\u8BD5\u65B9\u6CD5\u8BBA'))

children.push(h2('A.1 \u6D4B\u8BD5\u73AF\u5883'))
children.push(tbl(
  ['\u53C2\u6570', '\u503C', '\u6765\u6E90'],
  [
    ['LLM\u6A21\u578B', 'deepseek-chat (DeepSeek V4 Flash)', 'DeepSeek API'],
    ['API\u7AEF\u70B9', 'https://api.deepseek.com/v1/chat/completions', 'DeepSeek API\u6587\u6863'],
    ['API Key', 'sk-***... (\u73AF\u5883\u53D8\u91CF)', 'DeepSeek API\u63A7\u5236\u53F0'],
    ['\u6D41\u5F0F\u8F93\u51FA', '\u662F (stream=true, stream_options.include_usage=true)', '\u6D4B\u91CFTTFT\u6240\u9700'],
    ['\u7F51\u7EDC', 'Windows\u673A\u5668 -> DeepSeek API (HTTPS)', '\u672C\u5730\u5F00\u53D1\u673A'],
    ['\u8FD0\u884C\u65F6', 'Node.js v24.16.0 + tsx', 'npx tsx test/benchmark/*.ts'],
    ['\u8BF7\u6C42\u95F4\u9694', '\u8FDE\u7EED\u8BF7\u6C42\u4E4B\u95F4\u95F4\u96942000ms', '\u89C4\u907F\u901F\u7387\u9650\u5236'],
    ['\u901F\u7387\u9650\u5236\u5904\u7406', '429 -> 10\u79D2\u540E\u81EA\u52A8\u91CD\u8BD5', '\u5DF2\u5728runner\u811A\u672C\u4E2D\u5B9E\u73B0'],
    ['\u8D85\u65F6', '\u6BCF\u6B21API\u8C03\u7528120000ms', 'axios\u8D85\u65F6\u914D\u7F6E'],
  ]
))

children.push(h2('A.2 \u5B9A\u4EF7\u6A21\u578B (\u6570\u636E\u6765\u6E90: DeepSeek\u5B98\u65B9\u5B9A\u4EF7\u9875)'))
children.push(p('\u6240\u6709\u6210\u672C\u8BA1\u7B97\u4F7F\u7528\u4EE5\u4E0B DeepSeek V4 Flash \u5B9A\u4EF7:'))
children.push(tbl(
  ['Token\u7C7B\u578B', '\u4EF7\u683C (\u4EBA\u6C11\u5E01/\u767E\u4E07tokens)', '\u7F8E\u5143\u7B49\u4EF7', '\u6765\u6E90'],
  [
    ['\u8F93\u5165 (\u7F13\u5B58\u672A\u547D\u4E2D)', '\u00A51.00', '~$0.14', 'https://api-docs.deepseek.com/quick_start/pricing'],
    ['\u8F93\u5165 (\u7F13\u5B58\u547D\u4E2D / KV\u7F13\u5B58)', '\u00A50.02', '~$0.0028', '\u540C\u4E0A'],
    ['\u8F93\u51FA', '\u00A52.00', '~$0.28', '\u540C\u4E0A'],
  ]
))
children.push(p(''))
children.push(bp('KV\u7F13\u5B58\u5B9A\u4EF7\u8BF4\u660E:'))
children.push(p('DeepSeek V4 Flash\u63D0\u4F9B\u81EA\u52A8\u57FA\u4E8E\u78C1\u76D8\u7684KV\u7F13\u5B58\u3002\u5F53\u8BF7\u6C42\u524D\u7F00\u4E0E\u5148\u524D\u7F13\u5B58\u7684\u524D\u7F00\u5339\u914D\u65F6\uFF0C\u5339\u914D\u7684\u8F93\u5165tokens\u6309\u7F13\u5B58\u4EF7\u683C(\u00A50.02/\u767E\u4E07)\u8BA1\u8D39\uFF0C\u800C\u975E\u672A\u7F13\u5B58\u4EF7\u683C(\u00A51.00/\u767E\u4E07)\u3002\u8FD9\u76F8\u5F53\u4E8E\u7F13\u5B58\u8F93\u5165tokens\u4EAB\u53D798%\u6298\u6263\u3002\u7F13\u5B58\u4E3A\u5C3D\u529B\u63D0\u4F9B\uFF0C\u4E0D\u4FDD\u8BC1\u547D\u4E2D\u7387\u3002TTL\u4E3A\u6570\u5C0F\u65F6\u81F3\u6570\u5929\u3002\u6765\u6E90: https://api-docs.deepseek.com/guides/kv_cache'))

children.push(h2('A.3 \u6210\u672C\u8BA1\u7B97\u516C\u5F0F'))
children.push(bp('\u5355\u6B21\u8BF7\u6C42\u6210\u672C:'))
children.push(formula('\u6210\u672C', '(\u672A\u547D\u4E2D_tokens \u00D7 \u00A51.00/\u767E\u4E07) + (\u547D\u4E2D_tokens \u00D7 \u00A50.02/\u767E\u4E07) + (\u8F93\u51FA_tokens \u00D7 \u00A52.00/\u767E\u4E07)'))
children.push(p(''))
children.push(bp('\u5176\u4E2D:'))
children.push(bullet('\u672A\u547D\u4E2D_tokens = API\u54CD\u5E94usage\u5B57\u6BB5\u4E2D\u7684prompt_cache_miss_tokens'))
children.push(bullet('\u547D\u4E2D_tokens = API\u54CD\u5E94usage\u5B57\u6BB5\u4E2D\u7684prompt_cache_hit_tokens'))
children.push(bullet('\u8F93\u51FA_tokens = API\u54CD\u5E94usage\u5B57\u6BB5\u4E2D\u7684completion_tokens'))
children.push(p(''))
children.push(bp('\u8282\u7701\u767E\u5206\u6BD4:'))
children.push(formula('\u6210\u672C\u8282\u7701%', '(\u57FA\u7EBF_\u603B\u6210\u672C - \u4F18\u5316_\u603B\u6210\u672C) / \u57FA\u7EBF_\u603B\u6210\u672C \u00D7 100'))
children.push(formula('Token\u8282\u7701%', '(\u57FA\u7EBF_\u603BTokens - \u4F18\u5316_\u603BTokens) / \u57FA\u7EBF_\u603BTokens \u00D7 100'))
children.push(formula('\u5EF6\u8FDF\u8282\u7701%', '(\u57FA\u7EBF_\u603B\u5EF6\u8FDF - \u4F18\u5316_\u603B\u5EF6\u8FDF) / \u57FA\u7EBF_\u603B\u5EF6\u8FDF \u00D7 100'))
children.push(formula('TTFT\u8282\u7701%', '(\u57FA\u7EBF_\u5E73\u5747TTFT - \u4F18\u5316_\u5E73\u5747TTFT) / \u57FA\u7EBF_\u5E73\u5747TTFT \u00D7 100'))

children.push(h2('A.4 \u8DEF\u7531\u67B6\u6784 (\u6570\u636E\u6765\u6E90: src/services/l0SkillRouter.ts)'))
children.push(p('SKY\u4F7F\u75244\u5C42\u8DEF\u7531\u7CFB\u7EDF\u6765\u51B3\u5B9A\u6BCF\u4E2A\u8BF7\u6C42\u7684\u5904\u7406\u65B9\u5F0F:'))
children.push(tbl(
  ['\u5C42\u7EA7', '\u5339\u914D\u903B\u8F91', '\u6700\u5927\u8F93\u51FATokens', 'Token\u6210\u672C', '\u5178\u578B\u547D\u4E2D\u7387'],
  [
    ['L0\u672C\u5730', 'triggerPatterns\u5339\u914D + forbiddenPatterns\u672A\u5339\u914D + \u65E0\u9700LLM', '0 (\u65E0API\u8C03\u7528)', '0 tokens', '17.5% (V2)'],
    ['L0 + LLM (nano)', 'triggerPatterns\u5339\u914D + forbiddenPatterns\u672A\u5339\u914D + \u9700\u8981LLM', '512', '~\u6807\u51C6\u768412.5%', '12.5% (V2)'],
    ['L0.5 Mini', 'L05_KEYWORDS\u5173\u952E\u8BCD\u5339\u914D (\u4EC5\u5355\u6B65\u9AA4manifest)', '1024', '~\u6807\u51C6\u768425%', '27.5% (V2)'],
    ['RaaP\u6807\u51C6', '\u65E0L0/L0.5\u5339\u914D -> \u5B8C\u6574\u89C4\u5212+\u6267\u884C', '4096', '100%', '32.5% (V2)'],
    ['\u6307\u7EB9\u7F13\u5B58', '\u5B8C\u5168\u8F93\u5165\u54C8\u5E0C\u5339\u914D (\u540E\u7EED\u76F8\u540C\u8BF7\u6C42)', '0 (\u7F13\u5B58\u7ED3\u679C)', '0 tokens', '10% (V2)'],
  ]
))
children.push(p(''))
children.push(bp('L0\u89C4\u5219 (\u6765\u6E90 l0SkillRouter.ts skillRules[]):'))
children.push(tbl(
  ['\u89C4\u5219\u540D\u79F0', '\u89E6\u53D1\u6A21\u5F0F (\u7B80\u5199)', '\u7981\u6B62\u6A21\u5F0F', '\u662F\u5426\u9700\u8981LLM'],
  [
    ['\u6587\u4EF6\u683C\u5F0F\u8F6C\u6362', '/(convert|export|save as).*(docx|pdf|txt|md|xlsx)/i', '/(review|compliance|contract)/', '\u662F'],
    ['\u5FEB\u901FShell\u547D\u4EE4', '/^(ls|dir|pwd|whoami|npm|node|git)\\b/i', '/(format|convert|analyze|report)/', '\u5426'],
    ['\u7B80\u5355\u6587\u672C\u751F\u6210', '/^(write|generate|draft).{0,30}?(code|email|notice)/i', '/(weekly|contract|expense)/', '\u662F'],
    ['\u7B80\u5355\u67E5\u8BE2', '/^(what time|calculate|what date|how many)\\b/i', '/(analyze|report|review)/', '\u662F'],
    ['\u6587\u4EF6\u521B\u5EFA', '/(create|new|write).*(docx|txt|document|file)/i', '/(review|contract|report|budget|summary)/', '\u5426'],
    ['HTTP\u8BF7\u6C42', '/^(curl|fetch|request|download)\\s+/i', '\u65E0', '\u5426'],
    ['\u521B\u5EFA\u6587\u4EF6\u5939', '/(create|new).*(folder|directory)/i', '/(document|analyze|write)/', '\u5426'],
    ['\u5FEB\u901F\u6587\u4EF6\u8BFB\u53D6', '/^(read|view|open|show).{0,30}$/i', '/(analyze|review|edit|risk)/', '\u5426'],
  ]
))
children.push(p(''))
children.push(bp('L0.5\u5173\u952E\u8BCD (\u6765\u6E90 run-benchmark-v2.ts L05_KEYWORDS):'))
children.push(p('\u7FFB\u8BD1, \u8BD1\u6210, \u751F\u6210, \u5199\u4E00\u6BB5, \u6587\u6848, \u62A5\u9500, \u5408\u540C, \u7ADE\u54C1, \u5468\u62A5, \u4F1A\u8BAE\u7EAA\u8981, \u8D22\u62A5, KPI, \u9884\u7B97'))
children.push(p(''))
children.push(bp('\u6307\u7EB9\u7F13\u5B58:'))
children.push(p('\u4F7F\u7528\u54C8\u5E0C\u51FD\u6570(FNV-1a\u53D8\u4F53)\u5BF9\u5B8C\u6574\u8F93\u5165\u5B57\u7B26\u4E32\u8FDB\u884C\u54C8\u5E0C\u3002\u4EC5\u5B8C\u5168\u5339\u914D\u3002\u7F13\u5B58\u7ED3\u679C\u5B58\u50A8{content, inputTokens, outputTokens}\u3002\u7F13\u5B58\u547D\u4E2D\u65F6: \u5EF6\u8FDF += 5ms, \u6210\u672C += \u00A50.0001 (\u4F30\u8BA1\u672C\u5730\u5904\u7406\u5F00\u9500)\u3002'))

children.push(h2('A.5 TTFT\u6D4B\u91CF\u65B9\u6CD5'))
children.push(p('\u9996Token\u65F6\u95F4(TTFT)\u4F7F\u7528\u6D41\u5F0FAPI\u6309\u4EE5\u4E0B\u65B9\u6CD5\u6D4B\u91CF:'))
children.push(bullet('\u53D1\u9001\u8BF7\u6C42\uFF0C\u8BBE\u7F6Estream=true\u548Cstream_options.include_usage=true'))
children.push(bullet('\u8BB0\u5F55\u8BF7\u6C42\u5F00\u59CB\u65F6\u95F4: startTime = Date.now()'))
children.push(bullet('\u76D1\u542CSSE\u6D41\u4E2D\u7684\u7B2C\u4E00\u4E2Adelta.content'))
children.push(bullet('\u6536\u5230\u7B2C\u4E00\u4E2A\u5185\u5BB9\u65F6: ttftMs = Date.now() - startTime'))
children.push(bullet('\u5982\u679C\u672A\u6536\u5230\u5185\u5BB9delta\u4F46\u6D41\u7ED3\u675F: ttftMs = Date.now() - startTime (\u540E\u5907\u65B9\u6848)'))
children.push(p(''))
children.push(p('\u6CE8\u610F: TTFT\u5305\u542B\u4ECE\u6D4B\u8BD5\u673A\u5230DeepSeek API\u670D\u52A1\u5668\u7684\u7F51\u7EDC\u5F80\u8FD4\u65F6\u95F4(~200-400ms)\u3002\u5B9E\u9645\u6A21\u578B\u63A8\u7406\u65F6\u95F4\u4E3ATTFT\u51CF\u53BB\u7F51\u7EDC\u5EF6\u8FDF\u3002\u7531\u4E8E\u57FA\u7EBF\u548C\u4F18\u5316\u8FD0\u884C\u7684\u7F51\u7EDC\u6761\u4EF6\u4E00\u81F4\uFF0C\u56E0\u6B64\u76F8\u5BF9\u6BD4\u8F83\u662F\u6709\u6548\u7684\u3002'))

children.push(h2('A.6 KV\u7F13\u5B58\u547D\u4E2D\u7387\u6D4B\u91CF'))
children.push(p('DeepSeek API\u5728\u6D41\u5F0F\u54CD\u5E94\u7684usage\u5B57\u6BB5\u4E2D\u8FD4\u56DE\u7F13\u5B58\u547D\u4E2D/\u672A\u547D\u4E2D\u4FE1\u606F:'))
children.push(formula('KV\u7F13\u5B58\u547D\u4E2D\u7387', 'prompt_cache_hit_tokens / (prompt_cache_hit_tokens + prompt_cache_miss_tokens) \u00D7 100'))
children.push(p(''))
children.push(p('\u8FD9\u4E9B\u5B57\u6BB5\u4ECE\u5305\u542Busage\u6570\u636E\u7684\u6700\u540ESSE\u5757\u4E2D\u63D0\u53D6\u3002\u57FA\u7EBF\u8FD0\u884C\u4E2D\uFF0C\u6240\u6709\u8BF7\u6C42\u4F7F\u7528\u6807\u51C6\u5C42(max_tokens=4096)\uFF0C\u56E0\u6B64KV\u7F13\u5B58\u547D\u4E2D\u6765\u81EA\u8BF7\u6C42\u95F4\u7684\u524D\u7F00\u590D\u7528\u3002\u4F18\u5316\u8FD0\u884C\u4E2D\uFF0C\u4E0D\u540C\u5C42\u7EA7\u53EF\u80FD\u6709\u4E0D\u540C\u7684\u7F13\u5B58\u884C\u4E3A\uFF0C\u56E0\u4E3Amax_tokens\u4F1A\u5F71\u54CD\u7F13\u5B58\u8FB9\u754C\u3002'))

children.push(h2('A.7 \u7ED5\u8FC7\u7387'))
children.push(formula('\u7ED5\u8FC7\u7387', '(L0_\u672C\u5730 + L0_LLM + L0.5_Mini + \u6307\u7EB9\u7F13\u5B58) / \u603B\u8BF7\u6C42\u6570 \u00D7 100'))
children.push(p('\u7ED5\u8FC7\u7387\u8861\u91CF\u672A\u7ECF\u8FC7\u6700\u6602\u8D35\u7684\u6807\u51C6\u5C42RaaP\u7BA1\u7EBF\u7684\u8BF7\u6C42\u767E\u5206\u6BD4\u3002\u5982\u679C\u8BF7\u6C42\u88AB\u66F4\u4FBF\u5B9C\u7684\u5C42\u7EA7\u5904\u7406\u6216\u4ECE\u7F13\u5B58\u670D\u52A1\uFF0C\u5219\u88AB\u89C6\u4E3A"\u7ED5\u8FC7"\u3002'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ B\u90E8: V2\u901A\u7528\u57FA\u51C6 ═══
children.push(h1('B\u90E8: V2\u901A\u7528\u57FA\u51C6'))

children.push(h2('B.1 \u6D4B\u8BD5\u8BBE\u8BA1'))
children.push(tbl(
  ['\u53C2\u6570', '\u503C'],
  [
    ['\u603B\u6D4B\u8BD5\u7528\u4F8B', '80'],
    ['\u57DF', '8 (\u6587\u4EF6\u3001\u7CFB\u7EDF\u3001\u521B\u5EFA\u3001\u7FFB\u8BD1\u3001\u6CD5\u5F8B\u3001\u8D22\u52A1\u3001\u4EE3\u7801\u3001\u529E\u516C)'],
    ['\u6BCF\u57DF\u7528\u4F8B\u6570', '10'],
    ['\u5B8C\u5168\u91CD\u590D', '8 (10%) - \u6BCF\u57DF1\u6761\uFF0C\u7B2C10\u6761\u91CD\u590D\u7B2C1\u6761'],
    ['\u8BED\u4E49\u53D8\u4F53', '0'],
    ['\u6267\u884C\u6A21\u5F0F', '3\u79CD: \u8FDE\u7EED\u3001\u8870\u51CF\u3001\u968F\u673A'],
    ['\u7528\u4F8B\u8BBE\u8BA1\u539F\u5219', '\u6BCF\u57DF: 3\u6761L0\u9884\u671F + 3\u6761L0.5\u9884\u671F + 3\u6761RaaP\u9884\u671F + 1\u6761\u91CD\u590D'],
    ['\u8F93\u5165\u6587\u672C\u957F\u5EA6', '\u77ED (1-50\u5B57\u7B26) \u5230 \u4E2D\u7B49 (\u9644\u52A0\u5408\u540C/\u8D22\u52A1\u6587\u672C~300 tokens)'],
    ['\u6D4B\u8BD5\u7528\u4F8B\u6570\u636E\u6765\u6E90', 'test/benchmark/test-cases-v2.ts (\u5F00\u53D1\u8005\u624B\u5DE5\u7F16\u5199)'],
  ]
))

children.push(h2('B.2 \u6267\u884C\u6A21\u5F0F'))
children.push(tbl(
  ['\u6A21\u5F0F', '\u8BF4\u660E', 'KV\u7F13\u5B58\u884C\u4E3A', '\u6307\u7EB9\u7F13\u5B58'],
  [
    ['\u8FDE\u7EED', '\u6240\u670980\u6761\u7528\u4F8B\u63092\u79D2\u95F4\u9694\u987A\u5E8F\u6267\u884C', '\u987A\u5E8F\u8BF7\u6C42\u95F4\u524D\u7F00\u590D\u7528\u7387\u9AD8', '\u5355\u6B21\u4F1A\u8BDD\uFF0C8\u6761\u5B8C\u5168\u91CD\u590D\u547D\u4E2D\u7F13\u5B58'],
    ['\u8870\u51CF', '8\u4E2A\u57DF\u7EC4\u987A\u5E8F\u6267\u884C\uFF0C\u7EC4\u95F4\u95F4\u96945\u5206\u949F', 'KV\u7F13\u5B58\u53EF\u80FD\u5728\u7EC4\u95F4\u90E8\u5206\u8870\u51CF', '\u4E0E\u8FDE\u7EED\u76F8\u540C'],
    ['\u968F\u673A', '80\u6761\u7528\u4F8B\u968F\u673A\u6253\u4E71', '\u524D\u7F00\u590D\u7528\u7387\u6700\u4F4E', '\u6307\u7EB9\u547D\u4E2D\u7387\u9884\u671F\u8F83\u4F4E'],
  ]
))
children.push(p('\u6CE8\u610F: \u968F\u673A\u6A21\u5F0F\u4F18\u5316\u9636\u6BB5\u572854/80\u6761\u65F6\u8D85\u65F6\u3002\u4EC5\u57FA\u7EBF\u6570\u636E\u5B8C\u6574\u3002\u6570\u636E\u4EC5\u4F9B\u53C2\u8003\uFF0C\u6807\u8BB0\u4E3A\u4E0D\u5B8C\u6574\u3002'))

children.push(h2('B.3 \u8FDE\u7EED\u6A21\u5F0F - \u5B8C\u6574\u7ED3\u679C'))
children.push(h3('B.3.1 \u57FA\u7EBF (\u65E0\u4F18\u5316)'))
children.push(tbl(
  ['\u6307\u6807', '\u503C', '\u5907\u6CE8'],
  [
    ['\u603B\u8BF7\u6C42\u6570', '80', '\u6BCF\u4E2A\u8BF7\u6C42\u4F7F\u7528\u6807\u51C6\u5C42 (max_tokens=4096)'],
    ['LLM API\u8C03\u7528', '80', '100%\u7684\u8BF7\u6C42\u8FDB\u884CAPI\u8C03\u7528'],
    ['\u603B\u8F93\u5165tokens', '4,436', '\u6240\u6709\u8BF7\u6C42prompt_tokens\u4E4B\u548C'],
    ['\u603B\u8F93\u51FAtokens', '95,894', '\u6240\u6709\u8BF7\u6C42completion_tokens\u4E4B\u548C'],
    ['KV\u7F13\u5B58\u547D\u4E2Dtokens', '2,240', 'DeepSeek\u81EA\u52A8KV\u7F13\u5B58\u547D\u4E2D (\u524D\u7F00\u590D\u7528)'],
    ['KV\u7F13\u5B58\u672A\u547D\u4E2Dtokens', '2,152', '\u65B0\u524D\u7F00\u4E0D\u5728\u7F13\u5B58\u4E2D'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.1939', '\u4F7FA.3\u8282\u5B9A\u4EF7\u516C\u5F0F\u8BA1\u7B97'],
    ['\u603B\u5EF6\u8FDF', '849,800ms (14.2\u5206\u949F)', '\u4ECE\u7B2C\u4E00\u4E2A\u8BF7\u6C42\u5230\u6700\u540E\u4E00\u4E2A\u54CD\u5E94\u7684\u5899\u949F\u65F6\u95F4'],
    ['\u5E73\u5747TTFT', '529ms', '\u5305\u542B\u7F51\u7EDC\u5F80\u8FD4(~200-400ms)'],
    ['\u9519\u8BEF', '0', '\u65E0API\u9519\u8BEF\u6216\u8D85\u65F6'],
  ]
))

children.push(h3('B.3.2 \u4F18\u5316 (\u542F\u7528\u8DEF\u7531)'))
children.push(tbl(
  ['\u6307\u6807', '\u503C', '\u5907\u6CE8'],
  [
    ['\u603B\u8BF7\u6C42\u6570', '80', '\u4E0E\u57FA\u7EBF\u76F8\u540C\u7684\u6D4B\u8BD5\u7528\u4F8B'],
    ['LLM API\u8C03\u7528', '60', '75% - 20\u6761\u8BF7\u6C42\u88AB\u7ED5\u8FC7 (L0\u672C\u5730 + \u6307\u7EB9\u7F13\u5B58)'],
    ['L0\u672C\u5730\u547D\u4E2D', '14 (17.5%)', '\u6D88\u80170 tokens (shell\u547D\u4EE4\u3001\u6587\u4EF6\u8BFB\u53D6)'],
    ['L0 + LLM\u547D\u4E2D', '10 (12.5%)', 'nano\u5C42\uFF0Cmax_tokens=512'],
    ['L0.5 mini\u547D\u4E2D', '22 (27.5%)', 'mini\u5C42\uFF0Cmax_tokens=1024'],
    ['\u6307\u7EB9\u7F13\u5B58\u547D\u4E2D', '8 (10.0%)', '\u6BCF\u57DF\u7B2C\u4E00\u6761\u7528\u4F8B\u7684\u5B8C\u5168\u91CD\u590D'],
    ['RaaP\u6807\u51C6\u8C03\u7528', '26 (32.5%)', '\u6807\u51C6\u5C42\uFF0Cmax_tokens=4096'],
    ['\u603B\u8F93\u5165tokens', '3,755', '\u56E0\u66F4\u5C11/\u5206\u5C42API\u8C03\u7528\u800C\u51CF\u5C11'],
    ['\u603B\u8F93\u51FAtokens', '57,394', '\u56EAnano/mini\u8F93\u51FA\u4E0A\u9650\u800C\u51CF\u5C11'],
    ['KV\u7F13\u5B58\u547D\u4E2Dtokens', '3,200', '\u56E0\u5206\u5C42max_tokens\u800C\u9AD8\u4E8E\u57FA\u7EBF'],
    ['KV\u7F13\u5B58\u672A\u547D\u4E2Dtokens', '1,372', '\u56E0\u66F4\u5C11\u552F\u4E00\u524D\u7F00\u800C\u964D\u4F4E'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.1184', '\u4F7FA.3\u8282\u5B9A\u4EF7\u516C\u5F0F\u8BA1\u7B97'],
    ['\u603B\u5EF6\u8FDF', '563,600ms (9.4\u5206\u949F)', '\u56E0\u7F13\u5B58\u547D\u4E2D\u548C\u672C\u5730\u5904\u7406\u800C\u51CF\u5C11'],
    ['\u5E73\u5747TTFT', '497ms', '\u7565\u4F4E\u4E8E\u57FA\u7EBF(529ms)'],
    ['\u9519\u8BEF', '0', '\u65E0API\u9519\u8BEF\u6216\u8D85\u65F6'],
  ]
))

children.push(h3('B.3.3 \u8282\u7701\u6C47\u603B (\u8FDE\u7EED\u6A21\u5F0F)'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '100,330', '61,149', '39,181', '39.04%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.1939', '\u00A50.1184', '\u00A50.0755', '38.94%'],
    ['\u603B\u5EF6\u8FDF', '849.8s', '563.6s', '286.2s', '33.68%'],
    ['\u5E73\u5747TTFT', '529ms', '497ms', '32ms', '5.74%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '51.0% (\u57FA\u7EBF)', '70.0% (\u4F18\u5316)', '+19pp', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0\u672C\u5730)', '0%', '17.5%', '+17.5pp', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '67.5%', '+67.5pp', 'N/A'],
  ]
))

children.push(h2('B.4 \u8870\u51CF\u6A21\u5F0F - \u5B8C\u6574\u7ED3\u679C'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603B\u8BF7\u6C42\u6570', '80', '80', 'N/A'],
    ['LLM API\u8C03\u7528', '80', '60', '-25%'],
    ['\u603B\u8F93\u5165tokens', '4,573', '3,976', '-13.1%'],
    ['\u603B\u8F93\u51FAtokens', '93,794', '59,508', '-36.5%'],
    ['KV\u7F13\u5B58\u547D\u4E2Dtokens', '3,840', '3,200', '-16.7%'],
    ['KV\u7F13\u5B58\u672A\u547D\u4E2Dtokens', '1,589', '1,372', '-13.7%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.1891', '\u00A50.1231', '34.90%'],
    ['\u603B\u5EF6\u8FDF', '872.4s', '569.0s', '34.72%'],
    ['\u5E73\u5747TTFT', '500ms', '494ms', '1.10%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '70.7%', '70.0%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '17.5%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '67.5%', 'N/A'],
  ]
))
children.push(p(''))
children.push(bp('\u8870\u51CF\u6A21\u5F0F vs \u8FDE\u7EED\u6A21\u5F0F:'))
children.push(p('\u8870\u51CF\u6A21\u5F0F\u8282\u7701\u7387\u6BD4\u8FDE\u7EED\u6A21\u5F0F\u4F4E~3-4\u4E2A\u767E\u5206\u70B9\u3002\u57DF\u7EC4\u4E4B\u95F45\u5206\u949F\u7684\u95F4\u9694\u5E76\u672A\u5BFC\u81F4\u663E\u8457\u7684KV\u7F13\u5B58\u8870\u51CF \u2014\u2014 DeepSeek V4 Flash KV\u7F13\u5B58TTL\u4E3A\u6570\u5C0F\u65F6\u3002\u8282\u7701\u7387\u8F83\u4F4E\u4E3B\u8981\u662F\u7531\u4E8EAPI\u54CD\u5E94\u7684\u81EA\u7136\u6CE2\u52A8(\u8F93\u51FAtoken\u6570\u5728\u4E0D\u540C\u8FD0\u884C\u95F4\u6709\u53D8\u5316)\u3002'))

children.push(h2('B.5 \u8DEF\u7531\u5206\u5E03 (V2\u8FDE\u7EED)'))
children.push(tbl(
  ['\u8DEF\u7531\u5C42', '\u547D\u4E2D\u6570', '\u767E\u5206\u6BD4', '\u5E73\u5747\u8F93\u51FAtokens', '\u6BCF\u8BF7\u6C42\u6210\u672C'],
  [
    ['L0\u672C\u5730', '14', '17.5%', '0', '\u00A50.0001 (\u4F30\u8BA1)'],
    ['L0 + LLM (nano)', '10', '12.5%', '~500', '~\u00A50.0010'],
    ['L0.5 Mini', '22', '27.5%', '~1024', '~\u00A50.0021'],
    ['\u6307\u7EB9\u7F13\u5B58', '8', '10.0%', '0 (\u7F13\u5B58)', '\u00A50.0001 (\u4F30\u8BA1)'],
    ['RaaP\u6807\u51C6', '26', '32.5%', '~4096', '~\u00A50.0047'],
    ['\u5408\u8BA1', '80', '100%', '', ''],
  ]
))

children.push(h2('B.6 \u6309\u8DEF\u7531\u5C42\u6210\u672C\u5206\u89E3'))
children.push(p('\u5404\u8DEF\u7531\u5C42\u4F30\u8BA1\u6210\u672C\u8D21\u732E (\u8FDE\u7EED\u6A21\u5F0F\uFF0C\u4F18\u5316\u9636\u6BB5):'))
children.push(tbl(
  ['\u8DEF\u7531\u5C42', '\u8BF7\u6C42\u6570', '\u8F93\u5165tokens', '\u8F93\u51FAtokens', '\u4F30\u8BA1\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u5360\u6BD4'],
  [
    ['L0\u672C\u5730', '14', '0', '0', '0.0014', '1.2%'],
    ['L0 + LLM (nano)', '10', '~220', '~500', '~0.011', '9.3%'],
    ['L0.5 Mini', '22', '~2,000', '~1,024', '~0.047', '39.7%'],
    ['\u6307\u7EB9\u7F13\u5B58', '8', '0', '0', '0.0008', '0.7%'],
    ['RaaP\u6807\u51C6', '26', '~1,535', '~2,210', '~0.059', '49.8%'],
    ['\u5408\u8BA1', '80', '~3,755', '~57,394', '~0.1184', '100%'],
  ]
))
children.push(p('\u6CE8\u610F: L0.5 Mini\u548CRaaP\u6807\u51C6\u5408\u8BA1\u5360\u4F18\u5316\u9636\u6BB5\u6210\u672C\u7684~90%\u3002L0\u672C\u5730\u548C\u6307\u7EB9\u7F13\u5B58\u51E0\u4E4E\u514D\u8D39\u3002\u6700\u5927\u8282\u7701\u6765\u81EA(1) L0.5\u5C06\u8F93\u51FA\u9650\u5236\u4E3A1024 tokens vs \u6807\u51C6\u76844096\uFF0C\u4EE5\u53CA(2) L0\u672C\u5730\u5B8C\u5168\u6D88\u9664API\u8C03\u7528\u3002'))

children.push(h2('B.7 \u8DEF\u7531\u51C6\u786E\u6027'))
children.push(p('\u9884\u671F\u8DEF\u7531 (\u6D4B\u8BD5\u7528\u4F8B\u8BBE\u8BA1\u8005\u8BBE\u5B9A) vs \u5B9E\u9645\u8DEF\u7531 (runner\u903B\u8F91\u786E\u5B9A) \u5BF9\u6BD4:'))
children.push(tbl(
  ['\u7528\u4F8B', '\u9884\u671F\u8DEF\u7531', '\u5B9E\u9645\u8DEF\u7531', '\u95EE\u9898'],
  [
    ['A6: "\u751F\u6210\u6587\u6863\u6458\u8981"', 'L0.5', 'L0 (\u6587\u4EF6\u521B\u5EFA\u89C4\u5219)', 'L0 "\u521B\u5EFA\u6587\u4EF6"\u6A21\u5F0F\u5339\u914D"\u751F\u6210"+"document"'],
    ['A8: "\u5BA1\u67E5\u5408\u540C\u6761\u6B3E\u98CE\u9669"', 'RaaP', 'L0.5 (\u5408\u540C\u5173\u952E\u8BCD)', 'L0.5\u5173\u952E\u8BCD"\u5408\u540C"\u5339\u914D\uFF0C\u4F46\u4EFB\u52A1\u662F\u590D\u6742\u5206\u6790'],
    ['D4: "\u4ECA\u5929\u51E0\u53F7?"', 'L0', 'RaaP', 'L0\u67E5\u8BE2\u6A21\u5F0F\u53EF\u80FD\u4E0D\u5339\u914D\u4E2D\u6587\u65E5\u671F\u683C\u5F0F'],
    ['D6: "\u73B0\u5728\u51E0\u70B9\u51E0\u5206?"', 'L0', 'RaaP', 'L0\u67E5\u8BE2\u6A21\u5F0F\u53EF\u80FD\u4E0D\u5339\u914D\u4E2D\u6587\u65F6\u95F4\u683C\u5F0F'],
    ['E1: "\u5199\u4E00\u4EFDNDA"', 'L0.5', 'RaaP', 'L0.5\u5173\u952E\u8BCD\u65E0"\u5408\u540C"; NDA\u4E0D\u5728\u5173\u952E\u8BCD\u5217\u8868\u4E2D'],
    ['C9: "\u751F\u6210\u5E02\u573A\u8C03\u7814\u62A5\u544A"', 'RaaP', 'L0.5', 'L0.5\u5173\u952E\u8BCD"\u751F\u6210"\u5339\u914D'],
  ]
))
children.push(p(''))
children.push(p('\u8FD9\u4E9B\u4E0D\u5339\u914D\u5DF2\u5728\u540E\u7EED\u4EE3\u7801\u66F4\u65B0\u4E2D\u4FEE\u590D: "\u51E0\u53F7"/"\u51E0\u70B9\u51E0\u5206"\u6A21\u5F0F\u5DF2\u52A0\u5165L0\u67E5\u8BE2\u89C4\u5219; "\u6458\u8981|\u8BF4\u660E|\u7B80\u4ECB"\u5DF2\u52A0\u5165\u6587\u4EF6\u521B\u5EFA\u7981\u6B62\u6A21\u5F0F\u3002\u53C2\u89C1 test/unit/l0SkillRouter.spec.ts \u66F4\u65B0\u540E\u7684\u5355\u5143\u6D4B\u8BD5\u3002'))

children.push(h2('B.8 \u5C40\u9650\u6027\u4E0E\u8BF4\u660E'))
children.push(bullet('\u6D4B\u8BD5\u89C4\u6A21: 80\u6761\u5408\u6210\u7528\u4F8B\uFF0C\u975E\u771F\u5B9E\u7528\u6237\u5DE5\u4F5C\u8D1F\u8F7D\u3002\u5B9E\u9645\u8282\u7701\u7387\u53EF\u80FD\u4E0D\u540C\u3002'))
children.push(bullet('\u91CD\u590D\u6A21\u5F0F: \u4EC580/80 = 10%\u5B8C\u5168\u91CD\u590D\u3002\u771F\u5B9E\u7528\u6237\u53EF\u80FD\u6709\u66F4\u9AD8\u91CD\u590D\u7387 (\u5C24\u5176\u662F\u4E13\u4E1A\u573A\u666F)\u3002'))
children.push(bullet('KV\u7F13\u5B58TTL: DeepSeek KV\u7F13\u5B58\u6301\u7EED\u6570\u5C0F\u65F6\u81F3\u6570\u5929\u3002\u4E945\u5206\u949F\u8870\u51CF\u95F4\u9694\u672A\u5BFC\u81F4\u660E\u663E\u7F13\u5B58\u8870\u51CF\u3002'))
children.push(bullet('\u7F51\u7EDC\u5EF6\u8FDF: \u6240\u6709\u5EF6\u8FDF/TTFT\u6D4B\u91CF\u5305\u542B\u7F51\u7EDC\u5F80\u8FD4(~200-400ms)\u3002'))
children.push(bullet('\u5355\u6A21\u578B: \u4EC5\u6D4B\u8BD5DeepSeek V4 Flash\u3002\u7ED3\u679C\u53EF\u80FD\u4E0D\u9002\u7528\u4E8E\u5176\u4ED6\u6A21\u578B\u3002'))
children.push(bullet('\u968F\u673A\u6A21\u5F0F: \u4E0D\u5B8C\u6574 (54/80\u4F18\u5316\u7528\u4F8B)\u3002\u6570\u636E\u672A\u7EB3\u5165\u4E3B\u8981\u5206\u6790\u3002'))
children.push(bullet('\u6210\u672C\u7EDD\u5BF9\u503C: \u7EDD\u5BF9\u6210\u672C\u5F88\u5C0F (80\u6B21\u8BF7\u6C42\u00A50.19)\uFF0C\u56E0\u4E3ADeepSeek V4 Flash\u6781\u4FBF\u5B9C\u3002\u8282\u7701\u767E\u5206\u6BD4\u6BD4\u7EDD\u5BF9\u91D1\u989D\u66F4\u6709\u610F\u4E49\u3002'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ C\u90E8: \u4E13\u4E1A\u5C97\u4F4D\u6A21\u62DF\u57FA\u51C6 ═══
children.push(h1('C\u90E8: \u4E13\u4E1A\u5C97\u4F4D\u6A21\u62DF\u57FA\u51C6'))

children.push(h2('C.1 \u6D4B\u8BD5\u8BBE\u8BA1'))
children.push(tbl(
  ['\u53C2\u6570', '\u503C'],
  [
    ['\u603B\u6D4B\u8BD5\u7528\u4F8B', '120'],
    ['\u4E13\u4E1A\u5C97\u4F4D', '2 (\u4F1A\u8BA1\u3001\u6CD5\u52A1)'],
    ['\u6BCF\u5C97\u4F4D\u7528\u4F8B\u6570', '60'],
    ['\u6BCF\u5C97\u4F4D\u65F6\u6BB5\u6570', '3 (\u4E0A\u53488:30-12:00\u3001\u4E0B\u534813:00-17:30\u3001\u52A0\u73ED18:00-20:00)'],
    ['\u6BCF\u65F6\u6BB5\u7528\u4F8B\u6570', '20'],
    ['\u5B8C\u5168\u91CD\u590D (isRepeat)', '29 (24.2%)', '\u76F8\u540C\u8F93\u5165\u6587\u672C\u5728\u65F6\u6BB5\u5185\u51FA\u73B0\u4E24\u6B21'],
    ['\u8BED\u4E49\u53D8\u4F53 (isVariant)', '47 (39.2%)', '\u76F8\u540C\u6A21\u677F\uFF0C\u4E0D\u540C\u53C2\u6570 (\u5982\u76F8\u540C\u7A0E\u79CD\u3001\u4E0D\u540C\u6536\u5165)'],
    ['\u6709\u7F13\u5B58\u6536\u76CA\u7684\u603B\u8BA1', '76 (63.3%)', '\u5B8C\u5168\u91CD\u590D + \u8BED\u4E49\u53D8\u4F53\u5408\u8BA1'],
    ['\u4F1A\u8BA1\u4EFB\u52A1\u7C7B\u578B', '6: \u53D1\u7968\u3001\u6570\u636E\u5F55\u5165\u3001\u62A5\u8868\u3001\u7A0E\u52A1\u3001\u5408\u89C4\u3001\u9884\u7B97'],
    ['\u6CD5\u52A1\u4EFB\u52A1\u7C7B\u578B', '5: \u5408\u540C\u5BA1\u67E5\u3001NDA\u3001\u6CD5\u5F8B\u7814\u7A76\u3001\u5C3D\u804C\u8C03\u67E5\u3001\u5408\u89C4\u3001\u4E89\u8BAE\u89E3\u51B3'],
    ['\u8F93\u5165\u6587\u672C\u6765\u6E90', '\u4EBA\u5DE5\u5408\u6210\u7684\u5408\u540C\u3001\u53D1\u7968\u3001\u8D22\u52A1\u62A5\u8868\u3001NDA\u6A21\u677F\u3001\u5C3D\u8C03\u6E05\u5355'],
    ['\u6D4B\u8BD5\u7528\u4F8B\u6570\u636E\u6765\u6E90', 'test/benchmark/test-cases-professional.ts'],
    ['\u6267\u884C\u65B9\u5F0F', '\u6309\u7EC4\u6267\u884C (6\u7EC4)\uFF0C\u7EC4\u95F4\u6E05\u9664\u6307\u7EB9\u7F13\u5B58'],
  ]
))
children.push(p(''))
children.push(bp('\u4E0EV2\u7684\u5173\u952E\u8BBE\u8BA1\u5DEE\u5F02:'))
children.push(p('\u4E13\u4E1A\u57FA\u51C6\u6A21\u62DF\u771F\u5B9E\u7684\u65E5\u5E38\u5DE5\u4F5C\u6D41\u3002\u7528\u4F8B\u6309\u65F6\u6BB5\u6392\u5E8F (\u4E0A\u5348: \u53D1\u7968/\u5408\u540C -> \u4E0B\u5348: \u62A5\u8868/\u7814\u7A76 -> \u52A0\u73ED: \u9884\u7B97/\u5408\u89C4)\u3002\u8FD9\u79CD\u6392\u5E8F\u589E\u52A0\u4E86\u7F13\u5B58\u547D\u4E2D\u7387\uFF0C\u56E0\u4E3A\u76F8\u4F3C\u4EFB\u52A1\u805A\u96C6\u5728\u4E00\u8D77\u3002\u6307\u7EB9\u7F13\u5B58\u5728\u7EC4\u95F4\u6E05\u9664\uFF0C\u4EE5\u9694\u79BB\u6BCF\u4E2A\u65F6\u6BB5\u7684\u884C\u4E3A\u3002'))

children.push(h2('C.2 \u4F1A\u8BA1\u6D4B\u8BD5\u7528\u4F8B\u5206\u5E03'))
children.push(tbl(
  ['\u65F6\u6BB5', '\u4EFB\u52A1\u7C7B\u578B', '\u7528\u4F8B\u6570', '\u91CD\u590D', '\u53D8\u4F53', '\u5178\u578B\u8F93\u5165'],
  [
    ['\u4E0A\u5348 (8:30-12:00)', '\u53D1\u7968\u5904\u7406 + \u6570\u636E\u5F55\u5165', '20', '4 (20%)', '6 (30%)', '\u5B8C\u6574\u53D1\u7968\u6587\u672C(~140 tokens) + \u63D0\u53D6/\u6838\u5BF9\u6307\u4EE4'],
    ['\u4E0B\u5348 (13:00-17:30)', '\u62A5\u8868\u751F\u6210 + \u7A0E\u52A1\u8BA1\u7B97 + \u5408\u89C4', '20', '2 (10%)', '5 (25%)', '\u8D22\u52A1\u62A5\u8868(~280 tokens)\u6216\u7A0E\u52A1\u8BA1\u7B97\u63D0\u793A(~30 tokens)'],
    ['\u52A0\u73ED (18:00-20:00)', '\u9884\u7B97\u9884\u6D4B + \u7D27\u6025\u67E5\u8BE2', '20', '4 (20%)', '5 (25%)', '\u9884\u7B97\u660E\u7EC6(~50 tokens)\u6216\u7B80\u5355\u8BA1\u7B97(~20 tokens)'],
  ]
))

children.push(h2('C.3 \u6CD5\u52A1\u6D4B\u8BD5\u7528\u4F8B\u5206\u5E03'))
children.push(tbl(
  ['\u65F6\u6BB5', '\u4EFB\u52A1\u7C7B\u578B', '\u7528\u4F8B\u6570', '\u91CD\u590D', '\u53D8\u4F53', '\u5178\u578B\u8F93\u5165'],
  [
    ['\u4E0A\u5348 (8:30-12:00)', '\u5408\u540C\u5BA1\u67E5 + NDA\u8D77\u8349', '20', '4 (20%)', '4 (20%)', '\u5B8C\u6574\u5408\u540C\u6587\u672C(~300 tokens) + \u5BA1\u67E5\u6307\u4EE4'],
    ['\u4E0B\u5348 (13:00-17:30)', '\u6CD5\u5F8B\u7814\u7A76 + \u5C3D\u804C\u8C03\u67E5', '20', '2 (10%)', '4 (20%)', '\u6CD5\u6761\u67E5\u8BE2(~25 tokens)\u6216\u5C3D\u8C03\u6E05\u5355(~200 tokens)'],
    ['\u52A0\u73ED (18:00-20:00)', '\u5408\u89C4\u5BA1\u67E5 + \u4E89\u8BAE\u89E3\u51B3', '20', '4 (20%)', '4 (20%)', '\u5408\u89C4\u67E5\u8BE2(~30 tokens)\u6216\u4E89\u8BAE\u5206\u6790(~45 tokens)'],
  ]
))

children.push(h2('C.4 \u4F1A\u8BA1\u5206\u65F6\u6BB5\u7ED3\u679C'))

children.push(h3('C.4.1 \u4E0A\u5348: \u53D1\u7968\u5904\u7406 + \u6570\u636E\u5F55\u5165'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '8,414', '6,353', '24.49%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0130', '\u00A50.0100', '22.71%'],
    ['\u603B\u5EF6\u8FDF', '59.4s', '46.4s', '21.93%'],
    ['\u5E73\u5747TTFT', '435ms', '509ms', '-17.01% (\u53D8\u5DEE)'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '75.2%', '74.6%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '15.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '71.43%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '30.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0+LLM nano=15%\uFF0C\u6307\u7EB9\u7F13\u5B58=15%\uFF0CRaaP\u6807\u51C6=70%\u3002\u5927\u591A\u6570\u53D1\u7968/\u6570\u636E\u5F55\u5165\u7528\u4F8B\u547D\u4E2DRaaP\uFF0C\u56E0\u4E3AL0\u89C4\u5219\u6CA1\u6709\u53D1\u7968\u63D0\u53D6\u6216\u6570\u636E\u5F55\u5165\u7684\u7279\u5B9A\u6A21\u5F0F\u3002"\u8BA1\u7B97"\u7684L0\u89C4\u5219\u80FD\u6355\u83B7\u90E8\u5206\u8BA1\u7B97\u8BF7\u6C42\u3002'))

children.push(h3('C.4.2 \u4E0B\u5348: \u62A5\u8868 + \u7A0E\u52A1 + \u5408\u89C4'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '16,404', '12,287', '25.10%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0295', '\u00A50.0222', '24.68%'],
    ['\u603B\u5EF6\u8FDF', '135.1s', '107.6s', '20.33%'],
    ['\u5E73\u5747TTFT', '454ms', '467ms', '-2.92% (\u53D8\u5DEE)'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '62.6%', '62.2%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '50.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '25.0%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '85.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0+LLM nano=35%\uFF0CL0.5 mini=35%\uFF0C\u6307\u7EB9\u7F13\u5B58=15%\uFF0CRaaP\u6807\u51C6=15%\u3002\u7A0E\u52A1\u8BA1\u7B97\u7528\u4F8B\u547D\u4E2DL0+LLM nano (\u7531"\u8BA1\u7B97/\u6838\u5BF9"\u6A21\u5F0F\u89E6\u53D1)\u3002\u62A5\u8868\u751F\u6210\u7528\u4F8B\u547D\u4E2DL0.5 mini (\u7531"\u751F\u6210/\u62A5\u8868/\u9884\u7B97"\u5173\u952E\u8BCD\u89E6\u53D1)\u3002\u8FD9\u662F\u4F1A\u8BA1\u6700\u9AD8\u7ED5\u8FC7\u7387(85%)\u3002'))

children.push(h3('C.4.3 \u52A0\u73ED: \u9884\u7B97 + \u7D27\u6025\u67E5\u8BE2'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '12,454', '8,181', '34.31%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0243', '\u00A50.0163', '32.79%'],
    ['\u603B\u5EF6\u8FDF', '112.7s', '75.7s', '32.78%'],
    ['\u5E73\u5747TTFT', '442ms', '448ms', '-1.40% (\u53D8\u5DEE)'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '0.0%', '0.0%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '65.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '0.0%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '95.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0+LLM nano=30%\uFF0CL0.5 mini=45%\uFF0C\u6307\u7EB9\u7F13\u5B58=20%\uFF0CRaaP\u6807\u51C6=5%\u3002\u8FD9\u662F\u6240\u6709\u7EC4\u4E2D\u6700\u9AD8\u7ED5\u8FC7\u7387(95%)\u3002\u9884\u7B97\u8BA1\u7B97\u548C\u7B80\u5355\u67E5\u8BE2\u51E0\u4E4E\u5168\u90E8\u547D\u4E2DL0/L0.5\u3002KV\u7F13\u5B58\u547D\u4E2D\u7387\u4E3A0%\uFF0C\u56E0\u4E3A\u8FD9\u662F\u5728\u5355\u72EC\u6267\u884C\u4F1A\u8BDD\u4E2D\u8FD0\u884C\u7684\u6700\u540E\u4E00\u7EC4\uFF0C\u65E0\u5148\u524D\u7F13\u5B58\u9884\u70ED\u3002'))

children.push(h3('C.4.4 \u4F1A\u8BA1\u603B\u4F53'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '37,272', '26,821', '28.04%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0667', '\u00A50.0486', '27.24%'],
    ['\u603B\u5EF6\u8FDF', '307.1s', '229.7s', '25.20%'],
    ['\u5E73\u5747TTFT', '444ms', '476ms', '-7.14% (\u53D8\u5DEE)'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '59.9%', '60.2%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '43.33%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '30.43%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '70.0%', 'N/A'],
  ]
))

children.push(h2('C.5 \u6CD5\u52A1\u5206\u65F6\u6BB5\u7ED3\u679C'))

children.push(h3('C.5.1 \u4E0A\u5348: \u5408\u540C\u5BA1\u67E5 + NDA\u8D77\u8349'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '42,469', '17,806', '58.07%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0760', '\u00A50.0307', '59.53%'],
    ['\u603B\u5EF6\u8FDF', '417.2s', '167.2s', '59.93%'],
    ['\u5E73\u5747TTFT', '577ms', '496ms', '14.07%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '78.4%', '76.5%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '80.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '100.0%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '80.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0.5 mini=45%\uFF0C\u6307\u7EB9\u7F13\u5B58=35%\uFF0CRaaP\u6807\u51C6=20%\uFF0CL0+LLM nano=0%\u3002\u542B"\u5408\u540C"\u5173\u952E\u8BCD\u7684\u5408\u540C\u5BA1\u67E5\u7528\u4F8B\u547D\u4E2DL0.5 mini (\u8F93\u51FA\u9650\u52361024 vs \u57FA\u7EBF2000-2700 tokens\uFF0C\u8282\u770150-60%\u8F93\u51FA\u6210\u672C)\u3002\u65E0"\u5408\u540C"\u5173\u952E\u8BCD\u7684NDA\u8D77\u8349\u7528\u4F8B\u8FDB\u5165RaaP\u300235%\u6307\u7EB9\u7F13\u5B58\u547D\u4E2D\u6765\u81EA\u91CD\u590D\u7684\u5408\u540C\u5BA1\u67E5\u8BF7\u6C42\u3002100%\u53D8\u4F53KV\u547D\u4E2D\u7387\u8868\u793A\u6240\u6709"\u76F8\u540C\u5408\u540C\u3001\u4E0D\u540C\u5BA1\u67E5\u89D2\u5EA6"\u7684\u53D8\u4F53\u90FD\u83B7\u5F97\u4E86KV\u7F13\u5B58\u547D\u4E2D\u3002'))

children.push(h3('C.5.2 \u4E0B\u5348: \u6CD5\u5F8B\u7814\u7A76 + \u5C3D\u804C\u8C03\u67E5'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '48,444', '18,742', '61.31%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0946', '\u00A50.0364', '61.49%'],
    ['\u603B\u5EF6\u8FDF', '439.0s', '179.1s', '59.19%'],
    ['\u5E73\u5747TTFT', '505ms', '478ms', '5.48%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '50.4%', '48.7%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '70.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '37.5%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '70.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0.5 mini=45%\uFF0C\u6307\u7EB9\u7F13\u5B58=25%\uFF0CRaaP\u6807\u51C6=30%\u3002\u542B"\u751F\u6210/\u68C0\u7D22/\u5217\u51FA"\u5173\u952E\u8BCD\u7684\u6CD5\u5F8B\u7814\u7A76\u67E5\u8BE2\u547D\u4E2DL0.5 mini\u3002\u542B\u5B8C\u6574\u6E05\u5355\u6587\u672C(~200 tokens)\u7684\u5C3D\u8C03\u62A5\u544A\u5F53\u5B58\u5728"\u751F\u6210"\u5173\u952E\u8BCD\u65F6\u547D\u4E2DL0.5 mini\uFF0C\u5426\u5219\u8FDB\u5165RaaP\u3002\u5C3D\u8C03\u62A5\u544A\u4EA7\u751F\u6781\u957F\u8F93\u51FA (\u6807\u51C6\u5C424096 tokens)\uFF0C\u88ABmini\u5C42\u9650\u5236\u4E3A1024\uFF0C\u5BFC\u81F4\u5DE8\u5927\u8F93\u51FAtoken\u8282\u7701\u3002'))

children.push(h3('C.5.3 \u52A0\u73ED: \u5408\u89C4\u5BA1\u67E5 + \u4E89\u8BAE\u89E3\u51B3'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '37,523', '21,933', '41.55%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.0745', '\u00A50.0442', '40.67%'],
    ['\u603B\u5EF6\u8FDF', '355.5s', '210.2s', '40.89%'],
    ['\u5E73\u5747TTFT', '469ms', '446ms', '5.00%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '0.0%', '0.0%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '50.0%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '0.0%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '60.0%', 'N/A'],
  ]
))
children.push(p(''))
children.push(p('\u8DEF\u7531\u5206\u5E03: L0.5 mini=15%\uFF0CL0+LLM nano=10%\uFF0C\u6307\u7EB9\u7F13\u5B58=35%\uFF0CRaaP\u6807\u51C6=40%\u3002\u5408\u89C4\u68C0\u67E5\u503E\u5411\u4E8E\u8FDB\u5165RaaP (\u590D\u6742\u5206\u6790)\u3002\u4E89\u8BAE\u89E3\u51B3\u7528\u4F8B\u4E5F\u8FDB\u5165RaaP\u3002\u7B80\u5355\u65E5\u671F\u67E5\u8BE2("\u4ECA\u5929\u51E0\u53F7?")\u547D\u4E2DL0+LLM nano\u3002KV\u7F13\u5B58\u547D\u4E2D\u7387\u4E3A0%\uFF0C\u56E0\u4E3A\u8FD9\u662F\u5355\u72EC\u4F1A\u8BDD\u4E2D\u7684\u6700\u540E\u4E00\u7EC4\uFF0C\u65E0\u7F13\u5B58\u9884\u70ED\u3002'))

children.push(h3('C.5.4 \u6CD5\u52A1\u603B\u4F53'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701%'],
  [
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '128,436', '58,481', '54.47%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.2451', '\u00A50.1114', '54.56%'],
    ['\u603B\u5EF6\u8FDF', '1211.7s', '556.5s', '54.08%'],
    ['\u5E73\u5747TTFT', '517ms', '473ms', '8.49%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '66.6%', '64.2%', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '66.67%', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '58.33%', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '70.0%', 'N/A'],
  ]
))

children.push(h2('C.6 \u4E13\u4E1A\u57FA\u51C6\u603B\u4F53\u7ED3\u679C'))
children.push(tbl(
  ['\u6307\u6807', '\u57FA\u7EBF', '\u4F18\u5316', '\u8282\u7701', '\u8282\u7701%'],
  [
    ['\u603B\u8BF7\u6C42\u6570', '120', '120', '', ''],
    ['LLM API\u8C03\u7528', '120', '91', '-29', '-24.2%'],
    ['\u603B\u8F93\u5165tokens', '165,708', '85,302', '-80,406', 'N/A'],
    ['\u603B\u8F93\u51FAtokens', '(\u5DF2\u5305\u542B\u5728\u4E0A\u65B9)', '', '', ''],
    ['\u603Btokens (\u8F93\u5165+\u8F93\u51FA)', '165,708', '85,302', '-80,406', '48.52%'],
    ['\u603B\u6210\u672C (\u4EBA\u6C11\u5E01)', '\u00A50.3119', '\u00A50.1600', '\u00A50.1519', '48.71%'],
    ['\u603B\u5EF6\u8FDF', '1518.9s (25.3\u5206\u949F)', '786.2s (13.1\u5206\u949F)', '732.7s (12.2\u5206\u949F)', '48.24%'],
    ['\u5E73\u5747TTFT', '481ms', '475ms', '6ms', '1.25%'],
    ['KV\u7F13\u5B58\u547D\u4E2D\u7387', '63.9%', '62.4%', '', 'N/A'],
    ['\u53D8\u4F53KV\u547D\u4E2D\u7387', 'N/A', '44.68%', '', 'N/A'],
    ['\u7F13\u5B58\u547D\u4E2D\u7387 (\u6307\u7EB9+L0)', '0%', '55.0%', '+55pp', 'N/A'],
    ['\u7ED5\u8FC7\u7387', '0%', '70.0%', '+70pp', 'N/A'],
  ]
))

children.push(h2('C.7 \u8DEF\u7531\u5206\u5E03\u5BF9\u6BD4'))
children.push(tbl(
  ['\u8DEF\u7531\u5C42', '\u4F1A\u8BA1%', '\u6CD5\u52A1%', '\u603B\u4F53%', '\u8BF4\u660E'],
  [
    ['L0\u672C\u5730', '0%', '0%', '0%', '\u4E13\u4E1A\u573A\u666F\u4E2D\u65E0"ls/dir/pwd"\u7C7B\u578B\u547D\u4EE4'],
    ['L0 + LLM (nano)', '26.7%', '3.3%', '15.0%', '\u4F1A\u8BA1: \u7A0E\u52A1/\u9884\u7B97\u8BA1\u7B97; \u6CD5\u52A1: \u7F55\u89C1\u65E5\u671F\u67E5\u8BE2'],
    ['L0.5 Mini', '26.7%', '35.0%', '30.8%', '\u4F1A\u8BA1: \u62A5\u8868/\u9884\u7B97\u5173\u952E\u8BCD; \u6CD5\u52A1: \u5408\u540C/\u751F\u6210\u5173\u952E\u8BCD'],
    ['\u6307\u7EB9\u7F13\u5B58', '16.7%', '31.7%', '24.2%', '\u6CD5\u52A1\u6709\u66F4\u591A\u5B8C\u5168\u91CD\u590D (\u5408\u540C\u5BA1\u67E5\u3001NDA\u6A21\u677F)'],
    ['RaaP\u6807\u51C6', '30.0%', '30.0%', '30.0%', '\u4E24\u4E2A\u5C97\u4F4D: \u590D\u6742\u5206\u6790\u59CB\u7EC8\u8FDB\u5165RaaP'],
  ]
))

children.push(h2('C.8 TTFT\u5206\u6790: \u4E3A\u4F55\u4F18\u5316\u540ETTFT\u6709\u65F6\u66F4\u5DEE'))
children.push(p('\u5728\u591A\u4E2A\u4F1A\u8BA1\u5206\u7EC4\u4E2D\uFF0C\u4F18\u5316\u5E73\u5747TTFT\u9AD8\u4E8E\u57FA\u7EBF\u3002\u8FD9\u5E76\u975E\u56E0\u4E3A\u8DEF\u7531\u589E\u52A0\u4E86\u5EF6\u8FDF\u3002\u89E3\u91CA\u5982\u4E0B:'))
children.push(bullet('\u57FA\u7EBF: \u6240\u670980\u6B21\u8BF7\u6C42\u4F7F\u7528\u6807\u51C6\u5C42(max_tokens=4096)\u3002DeepSeek\u5FEB\u901F\u751F\u6210tokens\uFF0C\u56E0\u4E3A\u6CA1\u6709\u8F93\u51FA\u538B\u7F29\u538B\u529B\u3002'))
children.push(bullet('\u4F18\u5316: L0.5 mini\u5C42\u5C06max_tokens\u9650\u5236\u4E3A1024\u3002\u6A21\u578B\u4ECD\u5904\u7406\u5B8C\u6574\u8F93\u5165\uFF0C\u4F46\u5FC5\u987B\u5C06\u8F93\u51FA\u538B\u7F29\u5230\u66F4\u5C11\u7684tokens\u4E2D\uFF0C\u8FD9\u53EF\u80FD\u5BFC\u81F4\u9996Token\u751F\u6210\u65F6\u95F4\u7565\u957F\uFF0C\u56E0\u4E3A\u6A21\u578B\u9700\u8981"\u89C4\u5212"\u66F4\u7B80\u6D01\u7684\u56DE\u7B54\u3002'))
children.push(bullet('L0+LLM nano\u5C42\u5C06max_tokens\u9650\u5236\u4E3A512\u3002\u540C\u6837\u7684\u538B\u7F29\u5F00\u9500\u3002'))
children.push(bullet('\u7F51\u7EDC\u6CE2\u52A8: TTFT\u65B9\u5DEE\u5F88\u5927 (\u8FD0\u884C\u95F4200-1400ms)\u3002\u6BCF\u7EC4\u4EC520\u6761\u7528\u4F8B\uFF0C\u51E0\u4E2A\u5F02\u5E38TTFT\u5C31\u53EF\u4EE5\u6B6A\u66F2\u5E73\u5747\u503C\u3002'))
children.push(p(''))
children.push(bp('\u7ED3\u8BBA: \u8DEF\u7531\u5BF9TTFT\u7684\u6539\u5584\u5FAE\u4E4E\u5176\u5FAE(1-6%)\u3002\u771F\u6B63\u7684\u5EF6\u8FDF\u8282\u7701\u6765\u81EA\u5B8C\u5168\u6D88\u9664API\u8C03\u7528 (L0\u672C\u5730\u3001\u6307\u7EB9\u7F13\u5B58) \u548C\u51CF\u5C11\u603B\u54CD\u5E94\u65F6\u95F4 (\u66F4\u5C11\u8F93\u51FAtokens = \u66F4\u77ED\u6D41\u5F0F\u65F6\u95F4)\u3002'))

children.push(h2('C.9 \u53D8\u4F53KV\u7F13\u5B58\u547D\u4E2D\u7387\u5206\u6790'))
children.push(p('"\u8BED\u4E49\u53D8\u4F53"\u662F\u4F7F\u7528\u76F8\u540C\u6A21\u677F\u4F46\u53C2\u6570\u4E0D\u540C\u7684\u8BF7\u6C42 (\u5982\u76F8\u540C\u7A0E\u52A1\u8BA1\u7B97\u516C\u5F0F\u4F46\u4E0D\u540C\u6536\u5165\u91D1\u989D\u3001\u76F8\u540C\u5408\u540C\u5BA1\u67E5\u6A21\u677F\u4F46\u4E0D\u540C\u5BF9\u65B9\u65B9)\u3002\u5B83\u4EEC\u4E0D\u662F\u5B8C\u5168\u91CD\u590D\uFF0C\u56E0\u6B64\u6307\u7EB9\u7F13\u5B58\u4E0D\u4F1A\u547D\u4E2D\u3002\u7136\u800C\uFF0CDeepSeek KV\u7F13\u5B58\u53EF\u80FD\u90E8\u5206\u5339\u914D\u5171\u4EAB\u524D\u7F00\u3002'))
children.push(tbl(
  ['\u5206\u7EC4', '\u53D8\u4F53\u6570', 'KV\u7F13\u5B58\u547D\u4E2D', '\u547D\u4E2D\u7387', '\u8BF4\u660E'],
  [
    ['\u4F1A\u8BA1\u4E0A\u5348', '7', '5', '71.4%', '\u76F8\u540C\u53D1\u7968\u683C\u5F0F\uFF0C\u4E0D\u540C\u91D1\u989D - \u957F\u5171\u4EAB\u524D\u7F00'],
    ['\u4F1A\u8BA1\u4E0B\u5348', '4', '1', '25.0%', '\u7A0E\u52A1\u516C\u5F0F\u4E0D\u540C\u6570\u5B57 - \u8F83\u77ED\u5171\u4EAB\u524D\u7F00'],
    ['\u4F1A\u8BA1\u52A0\u73ED', '2', '0', '0.0%', '\u65E0\u7F13\u5B58\u9884\u70ED (\u5355\u72EC\u4F1A\u8BDD)'],
    ['\u6CD5\u52A1\u4E0A\u5348', '5', '5', '100.0%', '\u76F8\u540C\u5408\u540C\u6587\u672C\uFF0C\u4E0D\u540C\u5BA1\u67E5\u95EE\u9898 - \u5B8C\u5168\u524D\u7F00\u5339\u914D'],
    ['\u6CD5\u52A1\u4E0B\u5348', '8', '3', '37.5%', '\u4E0D\u540C\u6CD5\u6761\u6587\u7AE0 - \u8F83\u77ED\u5171\u4EAB\u524D\u7F00'],
    ['\u6CD5\u52A1\u52A0\u73ED', '2', '0', '0.0%', '\u65E0\u7F13\u5B58\u9884\u70ED (\u5355\u72EC\u4F1A\u8BDD)'],
    ['\u603B\u4F53', '28', '14', '44.7%', '\u8FD1\u534A\u6570\u8BED\u4E49\u53D8\u4F53\u53D7\u76CA\u4E8EKV\u7F13\u5B58'],
  ]
))

children.push(h2('C.10 \u5C40\u9650\u6027\u4E0E\u8BF4\u660E (\u4E13\u4E1A\u57FA\u51C6)'))
children.push(bullet('\u7EC4\u95F4\u7F13\u5B58\u6E05\u9664: \u6307\u7EB9\u7F13\u5B58\u57286\u7EC4\u4E4B\u95F4\u6E05\u9664\u3002\u8FD9\u964D\u4F4E\u4E86\u6307\u7EB9\u547D\u4E2D\u7387\uFF0C\u76F8\u6BD4\u7F13\u5B58\u5728\u6574\u4E2A\u5DE5\u4F5C\u4F1A\u8BDD\u4E2D\u6301\u7EED\u5B58\u5728\u7684\u771F\u5B9E\u573A\u666F\u3002'))
children.push(bullet('KV\u7F13\u5B58\u9884\u70ED: "\u52A0\u73ED"\u7EC4 (\u4F1A\u8BA1\u548C\u6CD5\u52A1\u5747\u662F) \u663E\u793A0% KV\u7F13\u5B58\u547D\u4E2D\u7387\uFF0C\u56E0\u4E3A\u5B83\u4EEC\u5728\u5355\u72EC\u4F1A\u8BDD\u4E2D\u8FD0\u884C\uFF0C\u65E0\u5148\u524D\u7F13\u5B58\u9884\u70ED\u3002\u5728\u771F\u5B9E\u7684\u8FDE\u7EED\u5DE5\u4F5C\u4F1A\u8BDD\u4E2D\uFF0C\u4E0A\u5348/\u4E0B\u5348\u7684KV\u7F13\u5B58\u5728\u52A0\u73ED\u65F6\u4ECD\u7136\u6E29\u70ED\u3002'))
children.push(bullet('\u5408\u6210\u6570\u636E: \u6240\u6709\u53D1\u7968\u3001\u5408\u540C\u548C\u8D22\u52A1\u62A5\u8868\u5747\u4E3A\u5408\u6210\u6570\u636E\u3002\u771F\u5B9E\u4E13\u4E1A\u6587\u6863\u7684token\u5206\u5E03\u53EF\u80FD\u4E0D\u540C\u3002'))
children.push(bullet('\u5355\u6A21\u578B: \u4EC5DeepSeek V4 Flash\u3002\u5176\u4ED6\u6A21\u578B (GPT-4.1\u3001Claude) \u53EF\u80FD\u6709\u4E0D\u540C\u7684\u7F13\u5B58\u884C\u4E3A\u548C\u5B9A\u4EF7\u3002'))
children.push(bullet('\u65E0\u8BED\u4E49\u7F13\u5B58: SKY\u76EE\u524D\u4EC5\u6709\u5B8C\u5168\u5339\u914D\u7684\u6307\u7EB9\u7F13\u5B58\u3002\u8BED\u4E49\u7F13\u5B58 (\u5982GPTCache) \u4F1A\u63D0\u9AD8\u53D8\u4F53\u8BF7\u6C42\u7684\u547D\u4E2D\u7387\uFF0C\u4F46\u672A\u5B9E\u73B0\u3002'))
children.push(bullet('\u8F93\u51FA\u622A\u65AD: L0.5 mini\u5C42\u5C06\u8F93\u51FA\u9650\u5236\u4E3A1024 tokens\uFF0C\u53EF\u80FD\u622A\u65AD\u8F83\u957F\u7684\u4E13\u4E1A\u6587\u6863 (\u5982\u6807\u51C6\u5C42\u751F\u62104096 tokens\u7684\u5C3D\u8C03\u62A5\u544A)\u3002\u622A\u65AD\u5BF9\u8D28\u91CF\u7684\u5F71\u54CD\u672A\u8BC4\u4F30\u3002'))
children.push(bullet('\u8DE8\u57FA\u51C6\u5BF9\u6BD4: V2\u548C\u4E13\u4E1A\u57FA\u51C6\u4F7F\u7528\u4E0D\u540C\u6570\u636E\u96C6\uFF0C\u4E0D\u53EF\u76F4\u63A5\u6BD4\u8F83\u3002\u4E13\u4E1A\u57FA\u51C6\u66F4\u9AD8\u7684\u8282\u7701\u7387(48.7% vs 38.9%)\u53D7\u66F4\u9AD8\u91CD\u590D/\u53D8\u4F53\u7387(63.3% vs 10%)\u5F71\u54CD\uFF0C\u800C\u975E\u4EC5\u4EC5\u56E0\u4E3A\u5DE5\u4F5C\u8D1F\u8F7D\u7C7B\u578B\u3002'))

children.push(new Paragraph({ children: [new PageBreak()] }))

// ═══ D\u90E8: \u9644\u5F55 ═══
children.push(h1('D\u90E8: \u9644\u5F55'))

children.push(h2('D.1 \u539F\u59CB\u6570\u636E\u6587\u4EF6'))
children.push(tbl(
  ['\u6587\u4EF6', '\u8DEF\u5F84', '\u8BF4\u660E'],
  [
    ['V2\u57FA\u51C6\u7ED3\u679C', 'benchmark-result-v2.json', '\u5B8C\u6574JSON\uFF0C\u5305\u542B3\u79CD\u6A21\u5F0F\u7684\u57FA\u7EBF/\u4F18\u5316\u7EDF\u8BA1'],
    ['\u4E13\u4E1A\u57FA\u51C6\u7ED3\u679C', 'benchmark-result-professional.json', '\u5B8C\u6574JSON\uFF0C\u5305\u542B\u5206\u7EC4/\u5206\u5C97\u4F4D\u7EDF\u8BA1'],
    ['V2\u6D4B\u8BD5\u7528\u4F8B', 'test/benchmark/test-cases-v2.ts', '80\u6761\u6D4B\u8BD5\u7528\u4F8B\uFF0C\u542BexpectedRoute\u6807\u7B7E'],
    ['\u4E13\u4E1A\u6D4B\u8BD5\u7528\u4F8B', 'test/benchmark/test-cases-professional.ts', '120\u6761\u6D4B\u8BD5\u7528\u4F8B\uFF0C\u542B\u5C97\u4F4D/\u65F6\u6BB5/\u4EFB\u52A1\u7C7B\u578B'],
    ['V2\u6267\u884C\u5668', 'test/benchmark/run-benchmark-v2.ts', '\u6267\u884C\u811A\u672C\uFF0C\u542B\u8DEF\u7531\u903B\u8F91\u548C\u6210\u672C\u8BA1\u7B97'],
    ['\u4E13\u4E1A\u6267\u884C\u5668', 'test/benchmark/run-benchmark-professional.ts', '\u5206\u7EC4\u6267\u884C\uFF0C\u652F\u6301partial save'],
  ]
))

children.push(h2('D.2 \u590D\u73B0\u6307\u4EE4'))
children.push(p('\u590D\u73B0\u8FD9\u4E9B\u57FA\u51C6\u6D4B\u8BD5:'))
children.push(bullet('\u8BBE\u7F6EAPI\u5BC6\u94A5: $env:DEEPSEEK_API_KEY="sk-xxx"'))
children.push(bullet('V2: npx tsx test/benchmark/run-benchmark-v2.ts'))
children.push(bullet('\u4E13\u4E1A (\u5206\u7EC4): npx tsx test/benchmark/run-benchmark-professional.ts <\u7EC4\u540D>'))
children.push(bullet('\u4E13\u4E1A\u7EC4\u540D: acct-morning, acct-afternoon, acct-overtime, legal-morning, legal-afternoon, legal-overtime'))
children.push(bullet('\u751F\u6210\u62A5\u544A: npx tsx test/benchmark/run-benchmark-professional.ts report'))
children.push(p(''))
children.push(p('\u9884\u8BA1\u8FD0\u884C\u65F6\u95F4: V2 ~15\u5206\u949F (80\u00D72\u9636\u6BB5\u00D72\u79D2\u95F4\u9694)\uFF0C\u4E13\u4E1A ~60\u5206\u949F\u603B\u8BA1 (6\u7EC4 \u00D7 ~10\u5206\u949F/\u7EC4)\u3002'))

children.push(h2('D.3 \u5B9A\u4EF7\u9A8C\u8BC1'))
children.push(p('DeepSeek V4 Flash\u5B9A\u4EF7\u53EF\u5728\u4EE5\u4E0B\u5730\u5740\u9A8C\u8BC1: https://api-docs.deepseek.com/quick_start/pricing'))
children.push(p('\u622A\u81F3 2026-08-30:'))
children.push(bullet('\u8F93\u5165 (\u7F13\u5B58\u672A\u547D\u4E2D): \u00A51.00/\u767E\u4E07tokens'))
children.push(bullet('\u8F93\u5165 (\u7F13\u5B58\u547D\u4E2D): \u00A50.02/\u767E\u4E07tokens'))
children.push(bullet('\u8F93\u51FA: \u00A52.00/\u767E\u4E07tokens'))
children.push(p(''))
children.push(p('\u9AD8\u5CF0\u65F6\u6BB5\u9644\u52A0\u8D39 (UTC 01:00-04:00\u548C06:00-10:00\u671F\u95F4\u4E3A2\u500D) \u5728\u8FD9\u4E9B\u6D4B\u8BD5\u4E2D\u672A\u6FC0\u6D3B\u3002'))

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 } } },
    children
  }]
})

Packer.toBuffer(doc).then(buf => {
  const outPath = 'C:\\Users\\Administrator\\Desktop\\SKY \u57FA\u51C6\u6D4B\u8BD5\u62A5\u544A.docx'
  fs.writeFileSync(outPath, buf)
  console.log('\u62A5\u544A\u5DF2\u4FDD\u5B58:', outPath, '(' + Math.round(buf.length / 1024) + ' KB)')
}).catch(err => {
  console.error('\u9519\u8BEF:', err)
  process.exit(1)
})
