import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  WidthType,
  Packer,
  PageBreak,
  ShadingType,
  convertInchesToTwip
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';

const FONT_CN = 'Microsoft YaHei';
const FONT_CODE = 'Consolas';
const FONT_EN = 'Calibri';
const COLOR_HEADER_BG = '1F3864';
const COLOR_HEADER_TEXT = 'FFFFFF';
const COLOR_ROW_ALT = 'D6E4F0';
const COLOR_ROW_NORMAL = 'FFFFFF';
const COLOR_ACCENT = '2E75B6';
const COLOR_DARK = '1B1B1B';
const COLOR_RED = 'C00000';
const COLOR_AMBER = 'BF8F00';
const COLOR_GREEN = '548235';

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 200 },
    children: [
      new TextRun({ text, font: FONT_CN, size: 32, bold: true, color: COLOR_HEADER_BG })
    ]
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [
      new TextRun({ text, font: FONT_CN, size: 26, bold: true, color: COLOR_ACCENT })
    ]
  });
}

function heading3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({ text, font: FONT_CN, size: 22, bold: true, color: COLOR_DARK })
    ]
  });
}

function bodyText(text: string, bold = false, color?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 360 },
    children: [
      new TextRun({ text, font: FONT_CN, size: 21, bold, color: color || COLOR_DARK })
    ]
  });
}

function bodyTextMulti(runs: { text: string; bold?: boolean; color?: string; font?: string }[]): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 360 },
    children: runs.map(r =>
      new TextRun({ text: r.text, font: r.font || FONT_CN, size: 21, bold: r.bold || false, color: r.color || COLOR_DARK })
    )
  });
}

function codeBlock(lines: string[]): Paragraph[] {
  return lines.map(line =>
    new Paragraph({
      spacing: { after: 0, line: 276 },
      shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
      children: [
        new TextRun({ text: line, font: FONT_CODE, size: 18, color: '333333' })
      ]
    })
  );
}

function emptyLine(): Paragraph {
  return new Paragraph({ spacing: { after: 100 }, children: [] });
}

interface CellDef {
  text: string;
  bold?: boolean;
  color?: string;
  shading?: string;
  width?: number;
  font?: string;
}

function makeCell(def: CellDef, isHeader = false): TableCell {
  return new TableCell({
    width: def.width ? { size: def.width, type: WidthType.PERCENTAGE } : undefined,
    shading: def.shading
      ? { type: ShadingType.CLEAR, fill: def.shading }
      : isHeader
        ? { type: ShadingType.CLEAR, fill: COLOR_HEADER_BG }
        : undefined,
    children: [
      new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({
            text: def.text,
            font: def.font || FONT_CN,
            size: isHeader ? 20 : 19,
            bold: def.bold || isHeader,
            color: def.color || (isHeader ? COLOR_HEADER_TEXT : COLOR_DARK)
          })
        ]
      })
    ]
  });
}

function makeTable(headers: CellDef[], rows: CellDef[][], colWidths?: number[]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => makeCell({ ...h, width: colWidths?.[i] }, true))
  });
  const dataRows = rows.map((row, rowIdx) =>
    new TableRow({
      children: row.map((cell, i) => {
        const shading = rowIdx % 2 === 0 ? COLOR_ROW_NORMAL : COLOR_ROW_ALT;
        return makeCell({ ...cell, width: colWidths?.[i], shading: cell.shading || shading });
      })
    })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
}

function bulletPoint(text: string, level = 0, bold = false, color?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 340 },
    indent: { left: 360 + level * 360 },
    children: [
      new TextRun({
        text: `${level === 0 ? '\u2022' : '\u25E6'} ${text}`,
        font: FONT_CN,
        size: 20,
        bold,
        color: color || COLOR_DARK
      })
    ]
  });
}

function labeledBullet(label: string, desc: string, level = 0): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 340 },
    indent: { left: 360 + level * 360 },
    children: [
      new TextRun({ text: `${level === 0 ? '\u2022' : '\u25E6'} ${label}\uFF1A`, font: FONT_CN, size: 20, bold: true, color: COLOR_ACCENT }),
      new TextRun({ text: desc, font: FONT_CN, size: 20, color: COLOR_DARK })
    ]
  });
}

function numberedItem(num: number, title: string, desc: string, titleColor?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 340 },
    indent: { left: 360 },
    children: [
      new TextRun({ text: `${num}. ${title}`, font: FONT_CN, size: 20, bold: true, color: titleColor || COLOR_DARK }),
      new TextRun({ text: ` \u2014 ${desc}`, font: FONT_CN, size: 20, color: '444444' })
    ]
  });
}

function codeRef(file: string, line: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 340 },
    indent: { left: 720 },
    children: [
      new TextRun({ text: '\u25E6 ', font: FONT_CN, size: 19 }),
      new TextRun({ text: `${file}:${line}`, font: FONT_CODE, size: 17, color: COLOR_ACCENT })
    ]
  });
}

async function main() {
  const sections: Paragraph[] = [];

  // ========== COVER ==========
  for (let i = 0; i < 6; i++) sections.push(emptyLine());

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: 'HoloStarmap', font: FONT_EN, size: 56, bold: true, color: COLOR_HEADER_BG })]
  }));

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 100 },
    children: [new TextRun({ text: '\u4E94\u5927\u6280\u672F\u6DF1\u5EA6\u95EE\u9898\u5206\u6790\u62A5\u544A', font: FONT_CN, size: 44, bold: true, color: COLOR_ACCENT })]
  }));

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: '\u2014\u2014 \u4EE3\u7801\u7EA7\u8BC1\u636E + \u6539\u8FDB\u65B9\u6848 \u2014\u2014', font: FONT_CN, size: 28, color: '666666' })]
  }));

  sections.push(emptyLine());

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: '\u8DEF\u7531\u964D\u7EA7\u94FE \u00B7 \u5206\u5757\u7B56\u7565 \u00B7 CJK\u5D4C\u5165\u8D28\u91CF \u00B7 \u8BED\u4E49\u7F13\u5B58 \u00B7 \u7EF4\u5EA6\u5347\u7EA7', font: FONT_CN, size: 20, color: '888888' })]
  }));

  sections.push(emptyLine());
  sections.push(emptyLine());
  sections.push(emptyLine());

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: '2026\u5E749\u6708', font: FONT_CN, size: 22, color: '666666' })]
  }));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== TOC ==========
  sections.push(heading1('\u76EE  \u5F55'));
  sections.push(emptyLine());

  const tocItems = [
    '\u95EE\u9898\u4E00  \u516D\u5C42\u8DEF\u7531\u964D\u7EA7\u94FE\u2014\u2014\u4E1A\u754C\u4E0D\u60F3\u8BBE\u8BA1\u8FD8\u662F\u6CA1\u60F3\u5230\uFF1F',
    '\u95EE\u9898\u4E8C  \u5206\u5757\u7B56\u7565\u65E0\u91CD\u53E0\u2014\u2014\u95EE\u9898\u4E0E\u89E3\u51B3\u65B9\u6848',
    '  2.1  \u4E24\u5957\u5206\u5757\u7B97\u6CD5\u7684\u4EE3\u7801\u8BC1\u636E',
    '  2.2  \u65E0\u91CD\u53E0\u5BFC\u81F4\u7684\u56DB\u5927\u95EE\u9898',
    '  2.3  \u4E09\u6B65\u89E3\u51B3\u65B9\u6848',
    '\u95EE\u9898\u4E09  \u5D4C\u5165\u6A21\u578BCJK\u8D28\u91CF\u2014\u2014\u95EE\u9898\u89E3\u91CA\u4E0E\u4F18\u5316\u65B9\u6CD5',
    '  3.1  CJK\u8D28\u91CF\u95EE\u9898\u7684\u56DB\u4E2A\u5C42\u9762',
    '  3.2  \u4E09\u5904CJK Unicode\u8303\u56F4\u4E0D\u4E00\u81F4',
    '  3.3  \u56DB\u79CD\u4F18\u5316\u65B9\u6CD5',
    '\u95EE\u9898\u56DB  \u8BED\u4E49\u7F13\u5B58\u2014\u2014\u8BED\u4E49\u76F8\u4F3C\u5EA6vs\u7CBE\u786E\u524D\u7F00+\u6700\u5927\u6761\u76EE',
    '  4.1  \u4E24\u5C42\u67E5\u627E\u673A\u5236',
    '  4.2  \u4E3A\u4EC0\u4E48\u9700\u8981\u8BED\u4E49\u5C42',
    '  4.3  \u6700\u5927\u6761\u76EE500\u7684\u95EE\u9898\u4E0E\u89E3\u51B3',
    '\u95EE\u9898\u4E94  384\u7EF4\u5D4C\u5165\u6362\u7EF4\u5EA6\u7684\u67B6\u6784\u5F71\u54CD',
    '  5.1  \u54EA\u4E9B\u7EC4\u4EF6\u7EF4\u5EA6\u65E0\u5173',
    '  5.2  \u54EA\u4E9B\u7EC4\u4EF6\u9700\u8981\u6539\u52A8',
    '  5.3  \u6700\u5927\u7684\u95EE\u9898\uFF1A\u5DF2\u6709\u5411\u91CF\u5168\u90E8\u5931\u6548',
    '  5.4  \u5B8C\u6574\u7EF4\u5EA6\u5347\u7EA7\u65B9\u6848',
    '\u7EFC\u5408\u5B9E\u65BD\u8DEF\u7EBF\u56FE'
  ];

  tocItems.forEach(item => {
    const isSubItem = item.startsWith('  ');
    sections.push(new Paragraph({
      spacing: { after: 60 },
      indent: { left: isSubItem ? 720 : 0 },
      children: [new TextRun({ text: item.trim(), font: FONT_CN, size: isSubItem ? 20 : 22, color: isSubItem ? '444444' : COLOR_DARK })]
    }));
  });

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== PROBLEM 1 ==========
  sections.push(heading1('\u95EE\u9898\u4E00  \u516D\u5C42\u8DEF\u7531\u964D\u7EA7\u94FE\u2014\u2014\u4E1A\u754C\u4E0D\u60F3\u8BBE\u8BA1\u8FD8\u662F\u6CA1\u60F3\u5230\uFF1F'));

  sections.push(heading2('\u7ED3\u8BBA\uFF1A\u4E0D\u662F\u201C\u4E0D\u60F3\u201D\uFF0C\u662F\u201C\u573A\u666F\u9A71\u52A8\u4E0D\u540C\uFF0C\u6CA1\u9700\u6C42\u5C31\u6CA1\u8BBE\u8BA1\u201D'));

  sections.push(heading3('HoloStarmap\u516D\u5C42\u964D\u7EA7\u94FE\u5B58\u5728\u7684\u6839\u672C\u539F\u56E0'));
  sections.push(bodyText('HoloStarmap\u540C\u65F6\u662F\u8DEF\u7531\u5668+\u5DE5\u5177\u68C0\u7D22\u5668+\u5BF9\u8BDD\u7F16\u6392\u5668\u3002sendMessage()\u4E00\u4E2A\u65B9\u6CD5\u627F\u62C5\u4E86\u4E09\u4E2A\u89D2\u8272\uFF0C\u8FD9\u5728\u7ADE\u54C1\u4E2D\u662F\u72EC\u4E00\u65E0\u4E8C\u7684\u3002'));
  sections.push(emptyLine());

  sections.push(bodyText('\u5404\u5C42\u7684\u89E6\u53D1\u6761\u4EF6\u3001\u4EE3\u7801\u4F4D\u7F6E\u548C\u4EE3\u4EF7\uFF1A', true));

  sections.push(makeTable(
    [{ text: '\u5C42\u7EA7', width: 8 }, { text: '\u89E6\u53D1\u6761\u4EF6', width: 35 }, { text: '\u4EE3\u7801\u4F4D\u7F6E', width: 27 }, { text: '\u77ED\u8DEF\u4EE3\u4EF7', width: 30 }],
    [
      [{ text: 'L0' }, { text: '7\u6761\u6B63\u5219\u89C4\u5219\u547D\u4E2D' }, { text: 'l0SkillRouter.ts:400-413' }, { text: '0 token' }],
      [{ text: 'L0.5' }, { text: 'L2 Manifest\u5173\u952E\u8BCD\u5339\u914D\u22650.8\u7F6E\u4FE1' }, { text: 'l0SkillRouter.ts:415-471' }, { text: '0 token' }],
      [{ text: 'L1' }, { text: '2\u4E2AL1\u8282\u70B9\u89C4\u5219\u22650.6\u7F6E\u4FE1' }, { text: 'l0SkillRouter.ts:473-519' }, { text: '0 token' }],
      [{ text: 'RaaP' }, { text: 'RRF\u878D\u5408\u5411\u91CF+\u5173\u952E\u8BCD\uFF0CGREEN/YELLOW/RED\u4E09\u6863' }, { text: 'toolRetrieval.ts:643-677' }, { text: '0~128 token' }],
      [{ text: 'LLM FB' }, { text: 'RaaP RED\u95E8+\u22652\u5019\u9009' }, { text: 'toolRetrieval.ts:766-810' }, { text: '~128 token' }],
      [{ text: 'Explore' }, { text: '\u5168\u90E8\u5931\u8D25' }, { text: 'l0SkillRouter.ts:521-542' }, { text: '\u5168\u91CFLLM' }]
    ],
    [8, 35, 27, 30]
  ));

  sections.push(emptyLine());
  sections.push(heading3('\u7ADE\u54C1\u4E3A\u4EC0\u4E48\u6CA1\u8FD9\u4E48\u505A\uFF1F'));

  const compRows: CellDef[][] = [
    [{ text: 'ChatGPT / Claude Desktop' }, { text: '\u7EAFLLM\u5BF9\u8BDD' }, { text: '\u6CA1\u6709\u5DE5\u5177\u68C0\u7D22\u95EE\u9898\uFF0C\u76F4\u63A5\u8C03\u7528LLM\uFF0C\u65E0\u9700L0-L1\u77ED\u8DEF\u5F84' }],
    [{ text: 'DeepSeek' }, { text: 'API\u670D\u52A1\u5546' }, { text: '\u8DEF\u7531\u5728\u6A21\u578B\u5C42(Flash/Pro)\uFF0C\u4E0D\u5728\u5DE5\u5177\u5C42\u3002\u7528\u6237\u53D1\u6765\u7684\u662Fprompt\uFF0C\u4E0D\u662F\u201C\u5E2E\u6211\u67E5\u6CD5\u5F8B\u201D' }],
    [{ text: 'Cursor / Windsurf' }, { text: '\u4EE3\u7801\u7F16\u8F91\u5668' }, { text: '\u5DE5\u5177\u96C6\u56FA\u5B9A\uFF08\u6587\u4EF6\u64CD\u4F5C\u3001\u7EC8\u7AEF\u3001\u641C\u7D22\uFF09\uFF0C\u4E0D\u9700\u8981\u81EA\u9002\u5E94\u5DE5\u5177\u53D1\u73B0' }],
    [{ text: 'n8n / Dify' }, { text: '\u5DE5\u4F5C\u6D41\u5E73\u53F0' }, { text: '\u7528\u6237\u624B\u52A8\u9009\u62E9\u8282\u70B9\u2014\u2014\u8DEF\u7531\u95EE\u9898\u4E0D\u5B58\u5728\uFF0C\u7528\u6237\u5C31\u662F\u8DEF\u7531\u5668' }],
    [{ text: 'Open WebUI' }, { text: 'Python\u63D2\u4EF6' }, { text: '\u5DE5\u5177\u7531\u63D2\u4EF6\u7CFB\u7EDF\u7BA1\u7406\uFF0C\u65E0\u81EA\u52A8\u8DEF\u7531\u9700\u6C42' }],
    [{ text: 'AnythingLLM' }, { text: 'RAG\u4E13\u6CE8' }, { text: '\u4EC5\u505A\u6587\u6863\u5BF9\u8BDD\uFF0C\u65E0\u5DE5\u5177\u751F\u6001\uFF0C\u65E0\u9700\u5DE5\u5177\u8DEF\u7531' }]
  ];

  sections.push(makeTable(
    [{ text: '\u7ADE\u54C1', width: 25 }, { text: '\u4EA7\u54C1\u5B9A\u4F4D', width: 20 }, { text: '\u4E3A\u4EC0\u4E48\u4E0D\u9700\u8981\u591A\u5C42\u8DEF\u7531', width: 55 }],
    compRows,
    [25, 20, 55]
  ));

  sections.push(emptyLine());
  sections.push(heading3('\u5173\u952E\u6D1E\u5BDF'));
  sections.push(bodyTextMulti([
    { text: '\u516D\u5C42\u8DEF\u7531\u964D\u7EA7\u94FE\u662F\u201C\u5DE5\u5177\u751F\u6001\u4E30\u5BCC+\u7528\u6237\u4E0D\u624B\u52A8\u9009+\u6210\u672C\u654F\u611F\u201D', bold: true, color: COLOR_ACCENT },
    { text: '\u4E09\u4E2A\u6761\u4EF6\u540C\u65F6\u6EE1\u8DB3\u65F6\u7684\u5FC5\u7136\u4EA7\u7269\u3002' }
  ]));
  sections.push(bulletPoint('\u7ADE\u54C1\u8981\u4E48\u5DE5\u5177\u5C11\uFF08\u4E0D\u9700\u8981\u8DEF\u7531\uFF09\uFF0C\u8981\u4E48\u7528\u6237\u624B\u52A8\u9009\uFF08\u7528\u6237\u5C31\u662F\u8DEF\u7531\u5668\uFF09\uFF0C\u8981\u4E48\u4E0D\u8BA1\u6210\u672C\uFF08\u76F4\u63A5\u8C03\u6700\u5927\u6A21\u578B\uFF09'));
  sections.push(bulletPoint('HoloStarmap\u4E09\u4E2A\u6761\u4EF6\u90FD\u6EE1\u8DB3\uFF0C\u6240\u4EE5\u624D\u6F14\u5316\u51FA\u516D\u5C42'));
  sections.push(bulletPoint('\u4E0D\u662F\u201C\u6CA1\u60F3\u5230\u201D\uFF0C\u662F\u201C\u4E0D\u9700\u8981\u201D\u3002\u4F46\u4E00\u65E6\u5176\u4ED6\u4EA7\u54C1\u4E5F\u8D70\u5411\u201C\u5DE5\u5177\u751F\u6001\u4E30\u5BCC+\u81EA\u52A8\u8DEF\u7531\u201D\u7684\u65B9\u5411\uFF0C\u5B83\u4EEC\u4E5F\u4F1A\u9762\u4E34\u540C\u6837\u7684\u8BBE\u8BA1\u95EE\u9898'));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== PROBLEM 2 ==========
  sections.push(heading1('\u95EE\u9898\u4E8C  \u5206\u5757\u7B56\u7565\u65E0\u91CD\u53E0\u2014\u2014\u95EE\u9898\u4E0E\u89E3\u51B3\u65B9\u6848'));

  sections.push(heading2('2.1  \u4E24\u5957\u5206\u5757\u7B97\u6CD5\u7684\u4EE3\u7801\u8BC1\u636E'));

  sections.push(heading3('\u6E32\u67D3\u8FDB\u7A0B\uFF1A\u6BB5\u843D\u7EA7\u8D2A\u5FC3\u5408\u5E76\uFF08512 token\uFF09'));
  sections.push(...codeBlock([
    '// knowledgeBase.ts:101-119',
    'function chunkBySemantic(text: string, maxTokens: number = 512): string[] {',
    '  const paragraphs = text.split(/\\n{2,}|\\r\\n\\r\\n/)',
    '  const chunks: string[] = []',
    '  let current = \u0027\u0027',
    '  for (const para of paragraphs) {',
    '    const paraTokens = estimateTokens(para)',
    '    const currentTokens = estimateTokens(current)',
    '    if (currentTokens + paraTokens > maxTokens && current.length > 0) {',
    '      chunks.push(current.trim())',
    '      current = para  // \u2190 \u65E0\u91CD\u53E0\uFF01\u4E0B\u4E00\u6BB5\u4ECE\u65B0\u6BB5\u843D\u5F00\u59CB',
    '    } else {',
    '      current += (current ? \u0027\\n\\n\u0027 : \u0027\u0027) + para',
    '    }',
    '  }',
    '  // ...',
    '}'
  ]));

  sections.push(emptyLine());
  sections.push(heading3('Electron\u4E3B\u8FDB\u7A0B\uFF1A\u5B57\u7B26\u7EA7\u5207\u5206\uFF08512\u5B57\u7B26\uFF09'));
  sections.push(...codeBlock([
    '// ipc-handlers.ts:29-44',
    'function chunkText(text: string, chunkSize: number): string[] {',
    '  const chunks: string[] = []',
    '  let i = 0',
    '  while (i < text.length) {',
    '    let end = Math.min(i + chunkSize, text.length)',
    '    if (end < text.length) {',
    '      const lastPeriod = text.lastIndexOf(\u0027\u3002\u0027, end)',
    '      const lastNewline = text.lastIndexOf(\u0027\\n\u0027, end)',
    '      const breakPoint = Math.max(lastPeriod, lastNewline)',
    '      if (breakPoint > i) end = breakPoint + 1',
    '    }',
    '    chunks.push(text.slice(i, end))',
    '    i = end  // \u2190 \u65E0\u91CD\u53E0\uFF01',
    '  }',
    '  return chunks.filter(c => c.trim().length > 0)',
    '}'
  ]));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u786E\u8BA4\uFF1A\u4E24\u5957\u7B97\u6CD5\u90FD\u6CA1\u6709\u91CD\u53E0', bold: true, color: COLOR_RED },
    { text: '\u3002\u800C\u4E14\u4E24\u5957\u7B97\u6CD5\u4E0D\u4E00\u81F4\uFF1A\u6E32\u67D3\u7AEF\u6309\u6BB5\u843D+token\uFF0CElectron\u7AEF\u6309\u5B57\u7B26+\u53E5\u53F7\u3002\u540C\u4E00\u6587\u6863\u8D70\u4E0D\u540C\u8DEF\u5F84\u4F1A\u4EA7\u751F\u4E0D\u540C\u7684\u5206\u5757\u7ED3\u679C\u3002' }
  ]));

  sections.push(heading2('2.2  \u65E0\u91CD\u53E0\u5BFC\u81F4\u7684\u56DB\u5927\u95EE\u9898'));

  sections.push(heading3('\u95EE\u98981\uFF1A\u8DE8\u6BB5\u843D\u4E8B\u5B9E\u65AD\u88C2'));
  sections.push(bodyText('\u5047\u8BBE\u4E00\u4EFD\u5408\u540C\u7684\u4E24\u4E2A\u76F8\u90BB\u6BB5\u843D\uFF1A'));
  sections.push(bulletPoint('\u6BB5\u843D1\uFF1A\u201C\u5408\u540C\u603B\u91D1\u989D\u4E3A\u4EBA\u6C11\u5E01\u201D', 1));
  sections.push(bulletPoint('\u6BB5\u843D2\uFF1A\u201C60\u4E07\u5143\u6574\uFF0C\u5206\u4E09\u671F\u652F\u4ED8\u201D', 1));
  sections.push(bodyText('\u5206\u5757\u540E\uFF1A\u6BB5\u843D1\u843D\u5165Chunk A\uFF0C\u6BB5\u843D2\u843D\u5165Chunk B\u3002\u7528\u6237\u95EE\u201C\u5408\u540C\u91D1\u989D\u662F\u591A\u5C11\u201D\uFF0C\u5411\u91CF\u641C\u7D22\u6700\u53EF\u80FD\u8FD4\u56DEChunk B\uFF0C\u4F46\u5B83\u53EA\u5305\u542B\u201C60\u4E07\u5143\u6574\u201D\u2014\u2014\u7F3A\u5C11\u201C\u5408\u540C\u603B\u91D1\u989D\u4E3A\u4EBA\u6C11\u5E01\u201D\u7684\u4E0A\u4E0B\u6587\u3002'));

  sections.push(heading3('\u95EE\u98982\uFF1ANER\u8DE8\u5757\u8BC6\u522B\u5931\u8D25'));
  sections.push(bodyText('nerExtractor\u5BF9\u6BCF\u4E2Achunk\u72EC\u7ACB\u8FD0\u884C\u6B63\u5219\u63D0\u53D6\u3002\u5982\u679C\u91D1\u989D\u201C\u4EBA\u6C11\u5E0160\u4E07\u5143\u201D\u88AB\u5207\u65AD\u4E3A\u201C\u4EBA\u6C11\u5E01\u201D\u548C\u201C60\u4E07\u5143\u201D\u4E24\u4E2Achunk\uFF0C\u4E24\u4E2Achunk\u90FD\u65E0\u6CD5\u8BC6\u522B\u51FA\u5B8C\u6574\u91D1\u989D\u5B9E\u4F53\u3002'));

  sections.push(heading3('\u95EE\u98983\uFF1A\u68C0\u7D22\u7ED3\u679C\u65E0\u6CD5\u590D\u539F\u90BB\u63A5\u5173\u7CFB'));
  sections.push(bodyText('SearchResult\u63A5\u53E3\u6CA1\u6709chunkIndex\u5B57\u6BB5\uFF1A'));
  sections.push(...codeBlock([
    '// models/index.ts:599-604',
    'export interface SearchResult {',
    '  text: string',
    '  entryId: string',
    '  score: number',
    '  source: \u0027vector\u0027 | \u0027keyword\u0027 | \u0027hybrid\u0027 | \u0027pseudo-vector\u0027',
    '  // \u2190 \u6CA1\u6709 chunkIndex\uFF01\u8C03\u7528\u65B9\u65E0\u6CD5\u77E5\u9053\u524D\u540Echunk'
  ]));

  sections.push(heading3('\u95EE\u98984\uFF1A\u4E24\u5957\u5206\u5757\u7B97\u6CD5\u4E0D\u4E00\u81F4'));
  sections.push(bodyText('\u6E32\u67D3\u7AEF\u6309\u6BB5\u843D+token\uFF0CElectron\u7AEF\u6309\u5B57\u7B26+\u53E5\u53F7\u3002\u540C\u4E00\u6587\u6863\u8D70\u4E0D\u540C\u8DEF\u5F84\u4F1A\u4EA7\u751F\u4E0D\u540C\u7684\u5206\u5757\u7ED3\u679C\uFF0C\u5411\u91CF\u4E0D\u4E00\u81F4\u3002'));

  sections.push(heading2('2.3  \u4E09\u6B65\u89E3\u51B3\u65B9\u6848'));

  sections.push(heading3('\u65B9\u6848C\uFF1A\u7EDF\u4E00\u5206\u5757\u7B97\u6CD5\uFF08\u5FC5\u987B\u5148\u505A\uFF09'));
  sections.push(bodyText('\u6D88\u9664Electron\u7AEF\u548C\u6E32\u67D3\u7AEF\u4E24\u5957\u5206\u5757\u7684\u4E0D\u4E00\u81F4\uFF0C\u7EDF\u4E00\u5230\u4E00\u5957\u6BB5\u843D\u7EA7\u8D2A\u5FC3\u5408\u5E76\u3002\u8FD9\u662F\u96F6\u7834\u574F\u6027\u7684\u7EDF\u4E00\u3002'));

  sections.push(heading3('\u65B9\u6848B\uFF1A\u68C0\u7D22\u540E\u90BB\u63A5\u6269\u5C55\uFF08\u8F7B\u91CF\uFF0C\u4E0D\u6539\u5206\u5757\uFF09'));
  sections.push(bodyText('\u5728hybridSearch\u8FD4\u56DEtopK\u540E\uFF0C\u5BF9\u6BCF\u4E2A\u7ED3\u679C\u6269\u5C55\u5176\u524D\u540Echunk\uFF1A'));
  sections.push(...codeBlock([
    '// \u5728SearchResult\u4E2D\u52A0\u5165expandedText\u5B57\u6BB5',
    'async function expandWithNeighbors(results, allChunks) {',
    '  return results.map(r => {',
    '    const chunk = allChunks.find(c =>',
    '      c.text === r.text && c.entryId === r.entryId)',
    '    const prev = allChunks.find(c =>',
    '      c.entryId === chunk.entryId && c.chunkIndex === chunk.chunkIndex - 1)',
    '    const next = allChunks.find(c =>',
    '      c.entryId === chunk.entryId && c.chunkIndex === chunk.chunkIndex + 1)',
    '    return { ...r,',
    '      expandedText: [prev?.text, r.text, next?.text]',
    '        .filter(Boolean).join(\u0027\\n\\n\u0027) }',
    '  })',
    '}'
  ]));

  sections.push(heading3('\u65B9\u6848A\uFF1A\u53EF\u914D\u7F6E\u91CD\u53E0\uFF08Open WebUI\u9A8C\u8BC1\u6709\u6548\uFF0C\u4F46\u9700\u91CD\u65B0\u5D4C\u5165\uFF09'));
  sections.push(bodyText('\u5728chunkBySemantic\u4E2D\u52A0\u5165overlapTokens\u53C2\u6570\uFF0C\u5C06\u524D\u4E00chunk\u5C3E\u90E8\u643A\u5E26\u5230\u4E0B\u4E00chunk\u5934\u90E8\uFF1A'));
  sections.push(...codeBlock([
    'function chunkBySemantic(text, maxTokens = 512, overlapTokens = 64) {',
    '  const paragraphs = text.split(/\\n{2,}|\\r\\n\\r\\n/)',
    '  const chunks = []',
    '  let current = \u0027\u0027',
    '  let carryOver = \u0027\u0027  // \u2190 \u65B0\u589E\uFF1A\u643A\u5E26\u524D\u4E00\u6BB5\u843D\u5C3E\u90E8',
    '  for (const para of paragraphs) {',
    '    const candidate = carryOver + (carryOver ? \u0027\\n\\n\u0027 : \u0027\u0027) + para',
    '    if (currentTokens + candidateTokens > maxTokens && current.length > 0) {',
    '      chunks.push(current.trim())',
    '      carryOver = extractTailByTokens(current, overlapTokens)',
    '      current = carryOver + \u0027\\n\\n\u0027 + para',
    '    } else { current = candidate }',
    '  }',
    '  // ...',
    '}'
  ]));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u63A8\u8350\u5B9E\u65BD\u987A\u5E8F\uFF1AC\u2192B\u2192A', bold: true, color: COLOR_ACCENT },
    { text: '\u3002\u5148\u7EDF\u4E00\u5206\u5757\u7B97\u6CD5\uFF08C\uFF0C\u96F6\u98CE\u9669\uFF09\uFF0C\u518D\u52A0\u90BB\u63A5\u6269\u5C55\uFF08B\uFF0C\u96F6\u7834\u574F\u6027\uFF09\uFF0C\u6700\u540E\u52A0\u53EF\u914D\u7F6E\u91CD\u53E0\uFF08A\uFF0C\u9700\u91CD\u65B0\u5D4C\u5165\u6240\u6709\u6587\u6863\uFF09\u3002' }
  ]));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== PROBLEM 3 ==========
  sections.push(heading1('\u95EE\u9898\u4E09  \u5D4C\u5165\u6A21\u578BCJK\u8D28\u91CF\u2014\u2014\u95EE\u9898\u89E3\u91CA\u4E0E\u4F18\u5316\u65B9\u6CD5'));

  sections.push(heading2('3.1  CJK\u8D28\u91CF\u95EE\u9898\u7684\u56DB\u4E2A\u5C42\u9762'));

  sections.push(heading3('\u5C42\u97621\uFF1ACJK\u8BED\u4E49\u7A7A\u95F4\u538B\u7F29'));
  sections.push(bodyText('all-MiniLM-L6-v2\u662F\u82F1\u6587\u4E2D\u5FC3\u6A21\u578B\uFF0C\u8BAD\u7EC3\u6570\u636E\u4EE5\u82F1\u6587\u4E3A\u4E3B\u3002\u82F1\u6587\u4E2D\u201C\u5408\u540C\u5BA1\u67E5\u201D\u548C\u201C\u5408\u540C\u5BA1\u6838\u201D\u8BED\u4E49\u9AD8\u5EA6\u76F8\u4F3C\uFF0C\u4F46all-MiniLM-L6-v2\u53EF\u80FD\u7ED9\u5B83\u4EEC\u5F88\u4E0D\u540C\u7684\u5411\u91CF\uFF0C\u56E0\u4E3A\u5B83\u6CA1\u89C1\u8FC7\u8DB3\u591F\u591A\u7684\u4E2D\u6587\u540C\u4E49\u8BCD\u5BF9\u3002'));

  sections.push(heading3('\u5C42\u97622\uFF1A\u8DE8\u8BED\u8A00\u5BF9\u9F50\u5DEE'));
  sections.push(bodyText('\u4E2D\u6587\u201C\u8D37\u6B3E\u5229\u7387\u201D\u548C\u82F1\u6587\u201Cloan interest rate\u201D\u5728\u8BED\u4E49\u7A7A\u95F4\u4E2D\u8DDD\u79BB\u53EF\u80FD\u5F88\u8FDC\uFF0C\u800C\u82F1\u6587\u201Cloan rate\u201D\u548C\u201Cloan interest rate\u201D\u8DDD\u79BB\u5F88\u8FD1\u3002\u8FD9\u5BF9\u4E2D\u82F1\u6DF7\u5408\u67E5\u8BE2\u662F\u81F4\u547D\u95EE\u9898\u3002'));

  sections.push(heading3('\u5C42\u97623\uFF1A\u4F2A\u5411\u91CF\u4E0D\u662F\u771F\u6B63\u7684\u8865\u6551'));
  sections.push(bodyText('\u4F2A\u5411\u91CF\u53EA\u5728\u524D64\u7EF4\u6709\u4FE1\u53F7\uFF0C\u540E320\u7EF4\u5168\u662F\u96F6\uFF1A'));
  sections.push(...codeBlock([
    '// embedder.ts:56',
    'const meaningfulSlots = Math.min(dim, 64)  // 64/384 = 16.7%\u6709\u6548\u7EF4\u5EA6'
  ]));
  sections.push(bodyText('\u8FD9\u610F\u5473\u7740\u4F2A\u5411\u91CF\u7684\u5B9E\u9645\u8868\u793A\u80FD\u529B\u53EA\u6709384\u7EF4\u768416.7%\uFF0C\u8FDC\u4F4E\u4E8E\u771F\u5B9E\u5D4C\u5165\u3002'));

  sections.push(heading3('\u5C42\u97624\uFF1ACJK Unicode\u8303\u56F4\u4E0D\u5B8C\u6574'));
  sections.push(bodyText('\u4F2A\u5411\u91CF\u751F\u6210\u5668\u53EA\u4FDD\u7559U+4E00-9FFF\uFF08\u57FA\u672C\u6C49\u5B57\uFF09\uFF0C\u65E5\u6587\u5047\u540D(U+3040-30FF)\u548C\u97E9\u6587(U+AC00-D7AF)\u88AB\u66FF\u6362\u4E3A\u7A7A\u683C\uFF1A'));
  sections.push(...codeBlock([
    '// embedder.ts:50',
    ".replace(/[^\\w\\u4e00-\\u9fff]/g, ' ')  // \u2190 \u5047\u540D\u548C\u97E9\u6587\u4E22\u5931\uFF01"
  ]));

  sections.push(heading2('3.2  \u4E09\u5904CJK Unicode\u8303\u56F4\u4E0D\u4E00\u81F4'));

  sections.push(makeTable(
    [{ text: '\u7EC4\u4EF6', width: 30 }, { text: 'CJK\u8303\u56F4', width: 40 }, { text: '\u65E5\u6587\u5047\u540D', width: 15 }, { text: '\u97E9\u6587', width: 15 }],
    [
      [{ text: 'embedder.ts' }, { text: 'U+4E00-9FFF' }, { text: '\u274C \u4E22\u5931' }, { text: '\u274C \u4E22\u5931' }],
      [{ text: 'knowledgeBase.ts (BM25)' }, { text: 'U+4E00-9FFF' }, { text: '\u274C \u4E22\u5931' }, { text: '\u274C \u4E22\u5931' }],
      [{ text: 'toolRetrieval.ts' }, { text: 'U+4E00-9FFF + U+3400-4DBF + U+F900-FAFF' }, { text: '\u274C \u4E22\u5931' }, { text: '\u274C \u4E22\u5931' }],
      [{ text: 'tokenEstimate.ts' }, { text: 'U+4E00-9FFF + U+3040-30FF + U+AC00-D7AF' }, { text: '\u2705 \u8986\u76D6' }, { text: '\u2705 \u8986\u76D6' }]
    ],
    [30, 40, 15, 15]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u7EDF\u4E00CJK\u8303\u56F4\u662F\u5FC5\u987B\u505A\u7684\u57FA\u7840\u4FEE\u590D', bold: true, color: COLOR_RED },
    { text: '\u3002\u5EFA\u8BAE\u7EDF\u4E00\u4E3A\uFF1A' }
  ]));
  sections.push(...codeBlock([
    '// \u7EDF\u4E00CJK\u6B63\u5219',
    'const CJK_REGEX = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uF900-\\uFAFF]',
    '  \\u3040-\\u309f\\u30a0-\\u30ff\\uac00-\\ud7af]'
  ]));

  sections.push(heading2('3.3  \u56DB\u79CD\u4F18\u5316\u65B9\u6CD5'));

  sections.push(heading3('\u65B9\u6CD51\uFF1A\u6362\u591A\u8BED\u8A00\u5D4C\u5165\u6A21\u578B\uFF08\u6700\u9AD8\u4F18\u5148\uFF09'));

  sections.push(makeTable(
    [{ text: '\u6A21\u578B', width: 30 }, { text: '\u7EF4\u5EA6', width: 10 }, { text: 'CJK\u8D28\u91CF', width: 15 }, { text: '\u6D4F\u89C8\u5668\u53EF\u8FD0\u884C', width: 15 }, { text: '\u5927\u5C0F', width: 10 }, { text: '\u5B58\u50A8\u5F71\u54CD', width: 20 }],
    [
      [{ text: 'all-MiniLM-L6-v2 (\u5F53\u524D)', bold: true, color: COLOR_RED }, { text: '384' }, { text: '\u274C \u5DEE' }, { text: '\u2705' }, { text: '~80MB' }, { text: '\u57FA\u51C6' }],
      [{ text: 'paraphrase-multilingual-MiniLM-L12-v2', bold: true, color: COLOR_GREEN }, { text: '384' }, { text: '\u2705 50+\u8BED\u8A00' }, { text: '\u2705' }, { text: '~470MB' }, { text: '\u96F6\u5F71\u54CD\uFF08\u7EF4\u5EA6\u4E0D\u53D8\uFF09' }],
      [{ text: 'multilingual-e5-small' }, { text: '384' }, { text: '\u2705 \u591A\u8BED\u8A00' }, { text: '\u2705' }, { text: '~470MB' }, { text: '\u96F6\u5F71\u54CD' }],
      [{ text: 'gte-base' }, { text: '768' }, { text: '\u26A0\uFE0F \u6BD4MiniLM\u597D' }, { text: '\u2705' }, { text: '~550MB' }, { text: '\u5B58\u50A8\u7FFB\u500D' }],
      [{ text: 'text-embedding-ada-002' }, { text: '1536' }, { text: '\u2705 \u591A\u8BED\u8A00' }, { text: '\u274C \u9700API' }, { text: 'N/A' }, { text: '\u5B58\u50A84\u500D' }]
    ],
    [30, 10, 15, 15, 10, 20]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u63A8\u8350\uFF1Aparaphrase-multilingual-MiniLM-L12-v2', bold: true, color: COLOR_GREEN },
    { text: '\u2014\u2014\u7EF4\u5EA6\u4E0D\u53D8\uFF08384\uFF09\uFF0C\u6240\u6709\u5B58\u50A8\u548C\u6BD4\u8F83\u903B\u8F91\u96F6\u6539\u52A8\uFF0C\u53EA\u662FCJK\u8BED\u4E49\u8D28\u91CF\u5927\u5E45\u63D0\u5347\u3002\u4EE3\u4EF7\u662F\u6A21\u578B\u4F53\u79EF\u4ECE~80MB\u589E\u52A0\u5230~470MB\u3002' }
  ]));

  sections.push(heading3('\u65B9\u6CD52\uFF1A\u7EDF\u4E00CJK Unicode\u8303\u56F4'));
  sections.push(bodyText('\u5C06embedder.ts\u3001knowledgeBase.ts\u3001toolRetrieval.ts\u7684CJK\u6B63\u5219\u7EDF\u4E00\u4E3A\u540C\u4E00\u4E2A\u5E38\u91CF\uFF0C\u8986\u76D6\u6C49\u5B57\u6269\u5C55A + \u57FA\u672C\u6C49\u5B57 + \u517C\u5BB9\u6C49\u5B57 + \u5047\u540D + \u97E9\u6587\u3002'));

  sections.push(heading3('\u65B9\u6CD53\uFF1A\u52A0\u5F3ACJK\u5206\u8BCD\uFF08\u5DF2\u6709BM25\u8865\u4F4D\u53EF\u52A0\u5F3A\uFF09'));
  sections.push(bodyText('\u5728BM25\u4E2D\u4F7F\u7528\u4E2D\u6587\u5206\u8BCD\uFF08\u5982jieba-wasm\u6216Intl.Segmenter\uFF09\u66FF\u4EE3\u5F53\u524D\u7684simpleTokenize\uFF0C\u589E\u52A0\u4E2D\u6587\u540C\u4E49\u8BCD\u8868\u505Aquery expansion\u3002'));

  sections.push(heading3('\u65B9\u6CD54\uFF1A\u53CC\u5854\u5D4C\u5165\uFF08\u8FDC\u671F\uFF09'));
  sections.push(bodyText('\u540C\u65F6\u7EF4\u62A4\u4E2D\u82F1\u6587\u4E24\u5957\u5D4C\u5165\u6A21\u578B\uFF0C\u68C0\u7D22\u65F6\u53D6\u52A0\u6743\u878D\u5408\uFF1Ascore = \u03B1 * cosine(multilingual_emb, chunk_emb) + (1-\u03B1) * bm25_score'));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== PROBLEM 4 ==========
  sections.push(heading1('\u95EE\u9898\u56DB  \u8BED\u4E49\u7F13\u5B58\u2014\u2014\u8BED\u4E49\u76F8\u4F3C\u5EA6vs\u7CBE\u786E\u524D\u7F00+\u6700\u5927\u6761\u76EE'));

  sections.push(heading2('4.1  \u4E24\u5C42\u67E5\u627E\u673A\u5236'));

  sections.push(bodyText('\u8BED\u4E49\u7F13\u5B58\u662F\u4E24\u5C42\u67E5\u627E\uFF08semanticCache.ts:189-248\uFF09\uFF1A'));
  sections.push(emptyLine());

  sections.push(makeTable(
    [{ text: '\u5C42\u7EA7', width: 15 }, { text: '\u5339\u914D\u65B9\u5F0F', width: 25 }, { text: '\u590D\u6742\u5EA6', width: 15 }, { text: '\u7CBE\u786E\u5EA6', width: 15 }, { text: '\u4EE3\u7801\u4F4D\u7F6E', width: 30 }],
    [
      [{ text: 'Layer 1' }, { text: 'textHash\u7CBE\u786E\u5339\u914D' }, { text: 'O(1) Map' }, { text: '1.0' }, { text: 'semanticCache.ts:189-210' }],
      [{ text: 'Layer 2' }, { text: '\u4F59\u5F26\u76F8\u4F3C\u5EA6\u2265adaptive.current' }, { text: 'O(n) \u626B\u63CF' }, { text: '0.80-0.95' }, { text: 'semanticCache.ts:212-248' }]
    ],
    [15, 25, 15, 15, 30]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u5148\u505A\u7CBE\u786E\u5339\u914D\uFF0C\u518D\u505A\u8BED\u4E49\u5339\u914D', bold: true, color: COLOR_ACCENT },
    { text: '\u2014\u2014\u8FD9\u4E0D\u662F\u201C\u9009\u4E86\u8BED\u4E49\u4E0D\u7528\u7CBE\u786E\u201D\uFF0C\u800C\u662F\u201C\u7CBE\u786E\u4F18\u5148+\u8BED\u4E49\u5151\u5E95\u201D\u3002' }
  ]));

  sections.push(heading2('4.2  \u4E3A\u4EC0\u4E48\u9700\u8981\u8BED\u4E49\u5C42'));

  sections.push(bodyText('\u7528\u6237\u4E0D\u4F1A\u7528\u5B8C\u5168\u76F8\u540C\u7684\u63AA\u8F9E\u95EE\u540C\u4E00\u4E2A\u95EE\u9898\uFF1A'));

  sections.push(makeTable(
    [{ text: '\u7528\u6237\u8868\u8FF0', width: 30 }, { text: '\u7CBE\u786E\u5339\u914D', width: 20 }, { text: '\u8BED\u4E49\u5339\u914D(\u22650.92)', width: 20 }, { text: '\u7701\u7684\u662F\u4EC0\u4E48', width: 30 }],
    [
      [{ text: '\u201C\u5E2E\u6211\u5199\u4E00\u4E2APython\u6392\u5E8F\u51FD\u6570\u201D' }, { text: '\u2190 \u539F\u59CB\u67E5\u8BE2' }, { text: '' }, { text: '' }],
      [{ text: '\u201C\u5199\u4E00\u4E2A\u6392\u5E8F\u7B97\u6CD5\u7528Python\u201D' }, { text: '\u274C \u4E0D\u5339\u914D' }, { text: '\u2705 \u22480.94' }, { text: '\u5168\u91CFLLM\u8C03\u7528' }],
      [{ text: '\u201CPython\u6392\u5E8F\u4EE3\u7801\u751F\u6210\u201D' }, { text: '\u274C \u4E0D\u5339\u914D' }, { text: '\u2705 \u22480.91' }, { text: '\u5168\u91CFLLM\u8C03\u7528' }],
      [{ text: '\u201C\u7528Python\u5B9E\u73B0\u6392\u5E8F\u201D' }, { text: '\u274C \u4E0D\u5339\u914D' }, { text: '\u2705 \u22480.93' }, { text: '\u5168\u91CFLLM\u8C03\u7528' }]
    ],
    [30, 20, 20, 30]
  ));

  sections.push(emptyLine());

  sections.push(heading3('HoloStarmap\u8BED\u4E49\u7F13\u5B58 vs DeepSeek KV Cache\u7684\u672C\u8D28\u533A\u522B'));

  sections.push(makeTable(
    [{ text: '\u7EF4\u5EA6', width: 20 }, { text: 'HoloStarmap\u8BED\u4E49\u7F13\u5B58', width: 40 }, { text: 'DeepSeek KV Cache', width: 40 }],
    [
      [{ text: '\u5C42\u7EA7' }, { text: '\u5E94\u7528\u5C42\uFF08\u5BA2\u6237\u7AEF\uFF09' }, { text: '\u57FA\u7840\u8BBE\u65BD\u5C42\uFF08\u670D\u52A1\u7AEF\uFF09' }],
      [{ text: '\u5339\u914D\u65B9\u5F0F' }, { text: '\u8BED\u4E49\u76F8\u4F3C\u5EA6\uFF08\u8DE8\u63AA\u8F9E\u547D\u4E2D\uFF09' }, { text: '\u7CBE\u786E\u524D\u7F00\u5339\u914D\uFF08\u5FC5\u987B\u76F8\u540C\u524D\u7F00\uFF09' }],
      [{ text: '\u7701\u7684\u662F\u4EC0\u4E48' }, { text: '\u6574\u4E2ALLM\u8C03\u7528\uFF08100%\u8F93\u51FAtoken\uFF09' }, { text: '\u8F93\u5165\u524D\u7F00\u8BA1\u8D39\u6298\u6263\uFF08~50%\u8F93\u5165\u6210\u672C\uFF09' }],
      [{ text: '\u5FC5\u8981\u6761\u4EF6' }, { text: '\u8BED\u4E49\u76F8\u4F3C\u5EA6\u2265\u9608\u503C' }, { text: 'token\u5E8F\u5217\u524D\u7F00\u5B8C\u5168\u76F8\u540C' }],
      [{ text: '\u4E3E\u4F8B' }, { text: '\u201C\u5199Python\u6392\u5E8F\u201D\u2248\u201C\u7528Python\u5B9E\u73B0\u6392\u5E8F\u201D' }, { text: '\u53EA\u6709\u5B8C\u5168\u76F8\u540C\u7684prompt\u524D\u7F00\u624D\u547D\u4E2D' }]
    ],
    [20, 40, 40]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u6838\u5FC3\u4F18\u52BF', bold: true, color: COLOR_ACCENT },
    { text: '\uFF1A\u8BED\u4E49\u7F13\u5B58\u80FD\u8DE8\u63AA\u8F9E\u547D\u4E2D\u2014\u2014\u7701\u7684\u662F\u6574\u4E2ALLM\u8C03\u7528\uFF08100%\u8F93\u51FAtoken\uFF09\uFF0C\u800CDeepSeek KV Cache\u7701\u7684\u53EA\u662F\u8F93\u5165\u524D\u7F00\u7684\u8BA1\u8D39\u6298\u6263\uFF08~50%\u8F93\u5165\u6210\u672C\uFF09\u3002' }
  ]));

  sections.push(heading2('4.3  \u6700\u5927\u6761\u76EE500\u7684\u95EE\u9898\u4E0E\u89E3\u51B3'));

  sections.push(heading3('\u4E3A\u4EC0\u4E48\u662F500\uFF1F'));
  sections.push(bodyText('500\u6761 \u00D7 384\u7EF4 \u00D7 4\u5B57\u8282 \u2248 750KB\u7EAF\u5411\u91CF + \u6587\u672C/\u5143\u6570\u636E \u2248 \u603B\u8BA1~2-3MB\u3002\u5728Electron\u684C\u9762\u5E94\u7528\u4E2D\u8FD9\u662F\u5408\u7406\u7684\u5185\u5B58\u5360\u7528\u3002500\u6B21\u4F59\u5F26\u76F8\u4F3C\u5EA6\u8BA1\u7B97\u2248 0.5ms\u3002'));

  sections.push(heading3('\u95EE\u9898\uFF1A5000+\u6B21\u67E5\u8BE2\u65F6\u547D\u4E2D\u7387\u4E0B\u964D'));
  sections.push(bodyText('500\u6761LRU\u610F\u5473\u7740\u65E9\u671F\u6709\u4EF7\u503C\u7684\u7F13\u5B58\u6761\u76EE\u88AB\u540E\u671F\u7684\u67E5\u8BE2\u6324\u51FA\u3002'));

  sections.push(heading3('\u89E3\u51B3\u65B9\u6848'));

  sections.push(makeTable(
    [{ text: '\u65B9\u6848', width: 15 }, { text: '\u6700\u5927\u6761\u76EE', width: 12 }, { text: '\u5185\u5B58', width: 10 }, { text: '\u67E5\u627E\u5EF6\u8FDF', width: 13 }, { text: '\u5B9E\u73B0\u590D\u6742\u5EA6', width: 15 }, { text: '\u63A8\u8350', width: 15 }],
    [
      [{ text: '\u5F53\u524DLRU' }, { text: '500' }, { text: '~2MB' }, { text: '0.5ms' }, { text: '\u2705 \u5DF2\u5B9E\u73B0' }, { text: '' }],
      [{ text: '\u589E\u5927LRU', bold: true, color: COLOR_GREEN }, { text: '2000' }, { text: '~8MB' }, { text: '2ms' }, { text: '\u6539\u4E00\u4E2A\u6570\u5B57' }, { text: '\u2705 \u63A8\u8350' }],
      [{ text: 'HNSW\u7D22\u5F15' }, { text: '10000+' }, { text: '~20MB' }, { text: '<0.1ms' }, { text: '\u9AD8\u2014\u2014\u5F15\u5165hnswlib-wasm' }, { text: '\u8FDC\u671F' }]
    ],
    [15, 12, 10, 13, 15, 15]
  ));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== PROBLEM 5 ==========
  sections.push(heading1('\u95EE\u9898\u4E94  384\u7EF4\u5D4C\u5165\u6362\u7EF4\u5EA6\u7684\u67B6\u6784\u5F71\u54CD'));

  sections.push(heading2('5.1  \u54EA\u4E9B\u7EC4\u4EF6\u7EF4\u5EA6\u65E0\u5173'));

  sections.push(makeTable(
    [{ text: '\u7EC4\u4EF6', width: 30 }, { text: '\u539F\u56E0', width: 70 }],
    [
      [{ text: 'SQLite BLOB' }, { text: '\u4EFB\u610F\u5927\u5C0F\u4E8C\u8FDB\u5236\u6570\u636E\uFF0C\u65E0\u56FA\u5B9A\u5927\u5C0F\u7EA6\u675F' }],
      [{ text: 'Vault\u8BFB\u5199' }, { text: '\u900F\u4F20Buffer/base64\uFF0C\u65E0\u7EF4\u5EA6\u6821\u9A8C' }],
      [{ text: 'IPC\u901A\u9053' }, { text: 'base64\u5B57\u7B26\u4E32\u4F20\u8F93\uFF0C\u4E0E\u7EF4\u5EA6\u65E0\u5173' }],
      [{ text: 'semanticCache\u5B58\u50A8' }, { text: '\u5E8F\u5217\u5316\u65F6\u81EA\u52A8\u9002\u914D\u4EFB\u610F\u7EF4\u5EA6' }],
      [{ text: 'cosineSimilarity' }, { text: '\u901A\u7528\u5411\u91CF\u8FD0\u7B97\uFF0C\u4E0D\u4F9D\u8D56\u56FA\u5B9A\u7EF4\u5EA6' }],
      [{ text: 'generatePseudoVector' }, { text: 'dim\u53C2\u6570\u53EF\u4F20\u5165\u4EFB\u610F\u503C' }]
    ],
    [30, 70]
  ));

  sections.push(heading2('5.2  \u54EA\u4E9B\u7EC4\u4EF6\u9700\u8981\u6539\u52A8'));

  sections.push(makeTable(
    [{ text: '\u7EC4\u4EF6', width: 25 }, { text: '\u6587\u4EF6', width: 25 }, { text: '\u6539\u52A8', width: 25 }, { text: '\u96BE\u5EA6', width: 10 }],
    [
      [{ text: 'VECTOR_DIM\u5E38\u91CF' }, { text: 'embedder.ts:3' }, { text: '\u6539\u4E3A\u65B0\u503C' }, { text: '\u4E00\u884C' }],
      [{ text: '\u5D4C\u5165\u6A21\u578B' }, { text: 'embedder.ts:17' }, { text: '\u6362\u65B0\u6A21\u578B\u540D' }, { text: '\u4E00\u884C' }],
      [{ text: 'vectorStore\u786C\u7F16\u7801384' }, { text: 'vectorStore.ts:43' }, { text: '\u6539\u4E3A\u5F15\u7528VECTOR_DIM' }, { text: '\u4E00\u884C' }],
      [{ text: '7\u4E2A\u6D4B\u8BD5\u6587\u4EF6' }, { text: 'test/' }, { text: '\u66F4\u65B0\u786C\u7F16\u7801384' }, { text: '\u673A\u68B0\u66FF\u6362' }],
      [{ text: '\u5DF2\u6709\u5411\u91CF\u91CD\u5D4C\u5165' }, { text: '\u591A\u4E2A\u6587\u4EF6' }, { text: '\u6700\u5927\u95EE\u9898\uFF08\u89C1\u4E0B\u6587\uFF09' }, { text: '\u9AD8' }]
    ],
    [25, 25, 25, 10]
  ));

  sections.push(heading2('5.3  \u6700\u5927\u7684\u95EE\u9898\uFF1A\u5DF2\u6709\u5411\u91CF\u5168\u90E8\u5931\u6548'));

  sections.push(bodyText('\u5982\u679C\u7EF4\u5EA6\u4ECE384\u2192768\uFF0C\u6240\u6709\u5DF2\u5B58\u50A8\u7684384\u7EF4\u5411\u91CF\u4E0E\u65B0768\u7EF4\u67E5\u8BE2\u505A\u4F59\u5F26\u76F8\u4F3C\u5EA6\u65F6\uFF1A'));
  sections.push(...codeBlock([
    '// embedder.ts:80',
    'if (a.length !== b.length || a.length === 0) return 0  // \u2190 \u957F\u5EA6\u4E0D\u7B49\u76F4\u63A5\u8FD4\u56DE0'
  ]));
  sections.push(bodyTextMulti([
    { text: '\u6240\u6709\u7F13\u5B58\u6761\u76EE\u548C\u77E5\u8BC6\u5E93\u5411\u91CF\u7ACB\u523B\u5931\u6548', bold: true, color: COLOR_RED },
    { text: '\u3002' }
  ]));

  sections.push(heading3('\u5F53\u524D\u91CD\u5D4C\u5165\u673A\u5236\u7684\u4E24\u4E2A\u4E25\u91CDbug'));

  sections.push(labeledBullet('Bug 1\uFF1A\u91CD\u5D4C\u5165\u540E\u4E0D\u6301\u4E45\u5316', 'knowledgeBase.ts:334-338\u7684needsReembedding()\u5728\u641C\u7D22\u65F6\u61D2\u89E6\u53D1\u91CD\u5D4C\u5165\uFF0C\u4F46\u91CD\u5D4C\u5165\u540E\u7684\u5411\u91CF\u4E0D\u6301\u4E45\u5316\u2014\u2014\u53EA\u5728\u5185\u5B58\u4E2D\u6709\u6548\uFF0C\u4E0B\u6B21\u641C\u7D22\u53C8\u4F1A\u91CD\u65B0\u5D4C\u5165'));
  sections.push(labeledBullet('Bug 2\uFF1AreembedAll()\u4E0D\u5B58\u5728', 'semanticCache.ts:553\u8C03\u7528\u4E86reembedAll()\uFF0C\u4F46\u8FD9\u4E2A\u51FD\u6570\u6839\u672C\u4E0D\u5B58\u5728\u2014\u2014.catch(() => {})\u9759\u9ED8\u541E\u6389\u4E86ReferenceError'));

  sections.push(heading2('5.4  \u5B8C\u6574\u7EF4\u5EA6\u5347\u7EA7\u65B9\u6848'));

  sections.push(numberedItem(1, '\u6539VECTOR_DIM + \u6362\u6A21\u578B', '1\u884C\u00D72\u6587\u4EF6'));
  sections.push(numberedItem(2, '\u4FEE\u590DvectorStore.ts\u786C\u7F16\u7801', '\u6539\u4E3A\u5F15\u7528VECTOR_DIM\uFF081\u884C\uFF09'));
  sections.push(numberedItem(3, '\u4FEE\u590DknowledgeBase.ts\u91CD\u5D4C\u5165\u6301\u4E45\u5316', '\u5728vectorSearch\u672B\u5C3E\u52A0saveChunksToVault'));
  sections.push(numberedItem(4, '\u5B9E\u73B0semanticCache.ts\u7684reembedAll()', '\u5F53\u524D\u662F\u7A7A\u8C03\u7528'));
  sections.push(numberedItem(5, '\u589E\u52A0vault-migration.ts\u7EF4\u5EA6\u5347\u7EA7\u8FC1\u79FB', '\u68C0\u6D4B\u65E7\u7EF4\u5EA6\u2192\u6279\u91CF\u91CD\u5D4C\u5165\u2192\u6301\u4E45\u5316'));
  sections.push(numberedItem(6, '\u66F4\u65B0\u6D4B\u8BD5\u6587\u4EF6', '\u673A\u68B0\u66FF\u6362'));
  sections.push(numberedItem(7, 'npx electron-rebuild', '\u5982\u679C\u7528wasm\u6A21\u578B'));

  sections.push(emptyLine());
  sections.push(heading3('\u5B58\u50A8\u7A7A\u95F4\u53D8\u5316'));

  sections.push(makeTable(
    [{ text: '\u7EF4\u5EA6', width: 12 }, { text: '\u5355\u5411\u91CF', width: 15 }, { text: '50 chunk\u77E5\u8BC6\u6761\u76EE', width: 20 }, { text: '500\u6761\u8BED\u4E49\u7F13\u5B58', width: 18 }, { text: '\u5DE5\u5177\u7D22\u5F15(100\u5DE5\u5177)', width: 20 }],
    [
      [{ text: '384' }, { text: '1.5KB' }, { text: '~75KB' }, { text: '~1MB' }, { text: '~300KB' }],
      [{ text: '768' }, { text: '3KB' }, { text: '~150KB' }, { text: '~2MB' }, { text: '~600KB' }],
      [{ text: '1536' }, { text: '6KB' }, { text: '~300KB' }, { text: '~4MB' }, { text: '~1.2MB' }]
    ],
    [12, 15, 20, 18, 20]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u5B89\u5168\u8DEF\u5F84', bold: true, color: COLOR_GREEN },
    { text: '\uFF1A\u9009paraphrase-multilingual-MiniLM-L12-v2\u2014\u2014\u7EF4\u5EA6\u4E0D\u53D8\uFF08384\uFF09\uFF0C\u6B65\u9AA4\u4E2D3-5\u90FD\u4E0D\u9700\u8981\u89E6\u53D1\uFF0CCJK\u8D28\u91CF\u5927\u5E45\u63D0\u5347\u3002' }
  ]));
  sections.push(bodyTextMulti([
    { text: '\u6027\u4EF7\u6BD4\u8DEF\u5F84', bold: true, color: COLOR_AMBER },
    { text: '\uFF1A\u9009gte-base\uFF08768\u7EF4\uFF09\u2014\u2014\u8868\u793A\u80FD\u529B\u663E\u8457\u63D0\u5347\uFF0C\u5B58\u50A8\u5F00\u9500\u53EA\u7FFB\u500D\uFF0C\u4F46\u9700\u5B8C\u6574\u6267\u884C\u6B65\u9AA41-7\u3002' }
  ]));

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ========== COMPREHENSIVE ROADMAP ==========
  sections.push(heading1('\u7EFC\u5408\u5B9E\u65BD\u8DEF\u7EBF\u56FE'));

  sections.push(bodyText('\u4E94\u5927\u95EE\u9898\u7684\u89E3\u51B3\u65B9\u6848\u5B58\u5728\u4F9D\u8D56\u5173\u7CFB\uFF0C\u5FC5\u987B\u6309\u6B63\u786E\u987A\u5E8F\u5B9E\u65BD\uFF1A'));
  sections.push(emptyLine());

  sections.push(makeTable(
    [{ text: '\u9636\u6BB5', width: 8 }, { text: '\u4EFB\u52A1', width: 30 }, { text: '\u4F9D\u8D56', width: 22 }, { text: '\u5F71\u54CD\u8303\u56F4', width: 20 }, { text: '\u5DE5\u4F5C\u91CF', width: 20 }],
    [
      [{ text: '1' }, { text: '\u7EDF\u4E00CJK Unicode\u8303\u56F4' }, { text: '\u65E0' }, { text: 'embedder + knowledgeBase + toolRetrieval' }, { text: '\u5C0F' }],
      [{ text: '2' }, { text: '\u7EDF\u4E00\u5206\u5757\u7B97\u6CD5' }, { text: '\u65E0' }, { text: 'ipc-handlers + knowledgeBase' }, { text: '\u5C0F' }],
      [{ text: '3' }, { text: '\u6362\u591A\u8BED\u8A00\u5D4C\u5165\u6A21\u578B' }, { text: '\u9636\u6BB51' }, { text: 'embedder.ts + \u6240\u6709\u5411\u91CF\u91CD\u65B0\u751F\u6210' }, { text: '\u4E2D' }],
      [{ text: '4' }, { text: 'SearchResult\u52A0chunkIndex + \u90BB\u63A5\u6269\u5C55' }, { text: '\u9636\u6BB52' }, { text: 'knowledgeBase + models' }, { text: '\u5C0F' }],
      [{ text: '5' }, { text: '\u4FEE\u590D\u91CD\u5D4C\u5165\u6301\u4E45\u5316 + \u5B9E\u73B0reembedAll' }, { text: '\u9636\u6BB53' }, { text: 'knowledgeBase + semanticCache' }, { text: '\u4E2D' }],
      [{ text: '6' }, { text: '\u8BED\u4E49\u7F13\u5B58\u6269\u5BB9\u52302000' }, { text: '\u65E0' }, { text: 'semanticCache.ts' }, { text: '\u6781\u5C0F' }],
      [{ text: '7' }, { text: '\u53EF\u914D\u7F6E\u5206\u5757\u91CD\u53E0' }, { text: '\u9636\u6BB52+3+5' }, { text: 'knowledgeBase + vectorStore + \u5168\u91CF\u91CD\u5D4C\u5165' }, { text: '\u5927' }]
    ],
    [8, 30, 22, 20, 20]
  ));

  sections.push(emptyLine());
  sections.push(bodyTextMulti([
    { text: '\u5173\u952E\u4F9D\u8D56\u94FE', bold: true, color: COLOR_RED },
    { text: '\uFF1A\u9636\u6BB51\uFF08CJK\u7EDF\u4E00\uFF09\u2192 \u9636\u6BB53\uFF08\u6362\u6A21\u578B\uFF09\u2192 \u9636\u6BB55\uFF08\u91CD\u5D4C\u5165\u6301\u4E45\u5316\uFF09\u3002\u5982\u679C\u9009\u62E9\u7EF4\u5EA6\u4E0D\u53D8\u7684multilingual-MiniLM\uFF0C\u9636\u6BB55\u4E2D\u7684vault-migration\u53EF\u4EE5\u8DF3\u8FC7\uFF08\u56E0\u4E3A\u5411\u91CF\u53EF\u4EE5\u6309\u539F\u7EF4\u5EA6\u91CD\u65B0\u751F\u6210\uFF09\u3002' }
  ]));

  sections.push(emptyLine());
  sections.push(emptyLine());

  sections.push(new Paragraph({
    spacing: { before: 400 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: '\u2014\u2014 \u6587\u6863\u7ED3\u675F \u2014\u2014', font: FONT_CN, size: 22, color: '999999' })]
  }));

  // ========== BUILD DOCUMENT ==========
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1)
          }
        }
      },
      children: sections
    }],
    styles: {
      default: {
        document: {
          run: { font: FONT_CN, size: 21 }
        }
      }
    }
  });

  const outputPath = path.resolve('C:\\Users\\Administrator\\Desktop', 'HoloStarmap\u4E94\u5927\u6280\u672F\u6DF1\u5EA6\u95EE\u9898\u5206\u6790\u62A5\u544A.docx');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`\u2705 Document generated: ${outputPath}`);
  console.log(`   Size: ${(buffer.length / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('\u274C Error:', err);
  process.exit(1);
});
