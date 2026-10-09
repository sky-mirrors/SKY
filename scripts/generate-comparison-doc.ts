import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  Packer,
  PageBreak,
  ShadingType,
  TableLayoutType,
  convertInchesToTwip
} from 'docx';
import * as fs from 'fs';
import * as os from 'os';
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
const COLOR_BLUE_LIGHT = 'D6E4F0';

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 200 },
    children: [
      new TextRun({
        text,
        font: FONT_CN,
        size: 32,
        bold: true,
        color: COLOR_HEADER_BG
      })
    ]
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [
      new TextRun({
        text,
        font: FONT_CN,
        size: 26,
        bold: true,
        color: COLOR_ACCENT
      })
    ]
  });
}

function heading3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        font: FONT_CN,
        size: 22,
        bold: true,
        color: COLOR_DARK
      })
    ]
  });
}

function bodyText(text: string, bold = false, color?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 360 },
    children: [
      new TextRun({
        text,
        font: FONT_CN,
        size: 21,
        bold,
        color: color || COLOR_DARK
      })
    ]
  });
}

function bodyTextMulti(runs: { text: string; bold?: boolean; color?: string; font?: string }[]): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 360 },
    children: runs.map(r =>
      new TextRun({
        text: r.text,
        font: r.font || FONT_CN,
        size: 21,
        bold: r.bold || false,
        color: r.color || COLOR_DARK
      })
    )
  });
}

function codeBlock(lines: string[]): Paragraph[] {
  return lines.map(line =>
    new Paragraph({
      spacing: { after: 0, line: 276 },
      shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
      children: [
        new TextRun({
          text: line,
          font: FONT_CODE,
          size: 18,
          color: '333333'
        })
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

function makeTable(
  headers: CellDef[],
  rows: CellDef[][],
  colWidths?: number[]
): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      makeCell({ ...h, width: colWidths?.[i] || undefined }, true)
    )
  });

  const dataRows = rows.map((row, rowIdx) =>
    new TableRow({
      children: row.map((cell, i) => {
        const shading = rowIdx % 2 === 0 ? COLOR_ROW_NORMAL : COLOR_ROW_ALT;
        return makeCell({
          ...cell,
          width: colWidths?.[i] || undefined,
          shading: cell.shading || shading
        });
      })
    })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows]
  });
}

function bulletPoint(text: string, level = 0, bold = false, color?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 340 },
    indent: { left: 360 + level * 360 },
    children: [
      new TextRun({
        text: `${level === 0 ? '•' : '◦'} ${text}`,
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
      new TextRun({
        text: `${level === 0 ? '•' : '◦'} ${label}：`,
        font: FONT_CN,
        size: 20,
        bold: true,
        color: COLOR_ACCENT
      }),
      new TextRun({
        text: desc,
        font: FONT_CN,
        size: 20,
        color: COLOR_DARK
      })
    ]
  });
}

function priorityTag(tag: string, color: string): Paragraph {
  return new Paragraph({
    spacing: { before: 150, after: 80 },
    children: [
      new TextRun({
        text: `【${tag}】`,
        font: FONT_CN,
        size: 24,
        bold: true,
        color
      })
    ]
  });
}

function numberedItem(num: number, title: string, desc: string, titleColor?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80, line: 340 },
    indent: { left: 360 },
    children: [
      new TextRun({
        text: `${num}. ${title}`,
        font: FONT_CN,
        size: 20,
        bold: true,
        color: titleColor || COLOR_DARK
      }),
      new TextRun({
        text: ` — ${desc}`,
        font: FONT_CN,
        size: 20,
        color: '444444'
      })
    ]
  });
}

async function main() {
  const sections: Paragraph[] = [];

  // ===================== COVER PAGE =====================
  for (let i = 0; i < 6; i++) sections.push(emptyLine());

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: 'SKY',
          font: FONT_EN,
          size: 56,
          bold: true,
          color: COLOR_HEADER_BG
        })
      ]
    })
  );

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: '功能全景与业界对比',
          font: FONT_CN,
          size: 44,
          bold: true,
          color: COLOR_ACCENT
        })
      ]
    })
  );

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: '—— 技术深度版 ——',
          font: FONT_CN,
          size: 28,
          color: '666666'
        })
      ]
    })
  );

  sections.push(emptyLine());

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: '6维度全面对比 + 编排架构/RAG/成本控制三大技术深度剖析',
          font: FONT_CN,
          size: 22,
          color: '888888'
        })
      ]
    })
  );

  sections.push(emptyLine());
  sections.push(emptyLine());

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: '对比产品：ChatGPT/Claude Desktop · Cursor/Windsurf · Dify/Coze · Obsidian+Copilot',
          font: FONT_CN,
          size: 18,
          color: '999999'
        })
      ]
    })
  );

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: 'DeepSeek · MetaGPT · AutoGPT · LobeChat · AnythingLLM · Open WebUI · n8n',
          font: FONT_CN,
          size: 18,
          color: '999999'
        })
      ]
    })
  );

  sections.push(emptyLine());
  sections.push(emptyLine());
  sections.push(emptyLine());

  sections.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: '2026年9月',
          font: FONT_CN,
          size: 22,
          color: '666666'
        })
      ]
    })
  );

  sections.push(
    new Paragraph({ children: [new PageBreak()] })
  );

  // ===================== TABLE OF CONTENTS =====================
  sections.push(heading1('目  录'));
  sections.push(emptyLine());

  const tocItems = [
    '第一章  功能全景速查（20大类 · 70+子功能）',
    '第二章  编排架构深度对比',
    '  2.1  三大架构范式对比',
    '  2.2  SKY完整执行流程',
    '  2.3  竞品可借鉴模式',
    '第三章  RAG架构深度对比',
    '  3.1  分块策略',
    '  3.2  嵌入模型',
    '  3.3  检索算法',
    '  3.4  CJK关键词匹配',
    '第四章  成本控制架构深度对比',
    '  4.1  智能路由',
    '  4.2  Token预算',
    '  4.3  语义缓存',
    '  4.4  成本透明度',
    '第五章  综合评估',
    '  5.1  12项独有优势',
    '  5.2  10项技术弱点',
    '  5.3  架构定位差异',
    '第六章  发展建议'
  ];

  tocItems.forEach(item => {
    const isSubItem = item.startsWith('  ');
    sections.push(
      new Paragraph({
        spacing: { after: 60 },
        indent: { left: isSubItem ? 720 : 0 },
        children: [
          new TextRun({
            text: item.trim(),
            font: FONT_CN,
            size: isSubItem ? 20 : 22,
            color: isSubItem ? '444444' : COLOR_DARK
          })
        ]
      })
    );
  });

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 1 =====================
  sections.push(heading1('第一章  功能全景速查'));
  sections.push(bodyText('20大类 · 70+子功能一览表。'));
  sections.push(emptyLine());

  const featureRows: CellDef[][] = [
    [{ text: 'A. AI对话' }, { text: '三模式对话(Command/Plan/Teach)、SSE流式渲染、对话摘要、CJK Token估算、结果美化' }, { text: '模式切换影响提示词构建和UI布局' }],
    [{ text: 'B. 工具系统' }, { text: 'MCP协议集成、混合检索(向量+关键词)、L0技能路由、技能安装管理、宏执行器、DAG编辑器、Pipeline执行器、DAG断点、@提及工具搜索、文件附件' }, { text: 'MCP客户端完整生命周期管理' }],
    [{ text: 'C. 知识管理' }, { text: '知识库CRUD、文档分块嵌入、向量存储(Float32Array二进制)、RAG注入、伪向量降级、跨文档验证' }, { text: '本地嵌入模型+伪向量双保险' }],
    [{ text: 'D. 路由调度' }, { text: '智能路由(nano/mini/standard/pro)、提示翻译器、调度优化器、语义缓存(自适应阈值0.80-0.95)、主动调度' }, { text: 'ZOL零令牌学习动态调整路由阈值' }],
    [{ text: 'E. 安全审核' }, { text: '双引擎验证(规则+LLM)、Shell安全白名单、路径校验器、安全集群、审计日志' }, { text: '规则引擎首过+LLM复审双保险' }],
    [{ text: 'F. 记忆系统' }, { text: '对话记忆、三级记忆(session/project/global)、记忆适配器、会话归档' }, { text: '跨会话、跨项目记忆持久化' }],
    [{ text: 'G. 数据管理' }, { text: '数据导出(ZIP)、数据导入(预览+确认)、存储监控(分类用量)、Vault客户端(缓存+写穿)、Vault服务端(SQLite+WAL+AES)、Vault迁移、安全存储' }, { text: 'localStorage→SQLite完整迁移路径' }],
    [{ text: 'H. 调试开发' }, { text: '调试探针、调试日志、调试窗口(Ctrl+Shift+D)、Pipeline调试页(时间旅行滑块)、基准窗口' }, { text: '时间旅行回放pipeline执行过程' }],
    [{ text: 'I. 配置个性化' }, { text: '配置存储、设置页(多Tab)、API多供应商管理、术语映射(技术→通俗)、引导向导(5步)、命令面板(Ctrl+Shift+P)、角色个性化' }, { text: '角色(金融/法律/HR)影响搜索和路由' }],
    [{ text: 'J. 桌面集成' }, { text: 'Electron主进程、多窗口管理、Preload/ContextBridge、IPC全通道、规则审查窗口' }, { text: '4个独立窗口(main/pipeline/debug/benchmark)' }],
    [{ text: 'K. 架构基础' }, { text: 'HoloKernel微内核、HoloEventBus事件总线、5个内核集群、12个领域处理器、15个Pinia Store、完整类型系统' }, { text: 'Iron Rules 3/4/5已实施' }],
    [{ text: 'L. NLP/约束' }, { text: 'NER提取器、领域约束库(金融/劳动/合同)、规则引擎' }, { text: '中文法律领域自动约束' }],
    [{ text: 'M. 成本控制' }, { text: 'Token预算三模式、ZOL/MAB优化器、策略选择器、Token定价' }, { text: '三档白名单强制约束' }],
    [{ text: 'N. 优化算法' }, { text: 'FNV-1a哈希、语义缓存自适应阈值、MAB多臂赌博机' }, { text: '零额外LLM调用的自适应' }],
    [{ text: 'O. 文件处理' }, { text: '文件上下文、文档解析(PDF/DOCX/XLSX/TXT)、编码检测' }, { text: '多格式统一解析' }],
    [{ text: 'P. 可视化' }, { text: '3D星图(125节点Three.js)、Pipeline DAG可视化' }, { text: '工具生态全息拓扑' }],
    [{ text: 'Q. 通知反馈' }, { text: '通知系统、工作流日志、反馈权重' }, { text: '单一通知真相源' }],
    [{ text: 'R. MCP集成' }, { text: 'MCP Store、MCP生命周期管理、MCP工具搜索' }, { text: '协议级工具发现和调用' }],
    [{ text: 'S. Pipeline' }, { text: 'Pipeline编辑器、Pipeline执行器、Pipeline Store、DAG断点续跑' }, { text: '可视化编排+执行持久化' }],
    [{ text: 'T. 会话管理' }, { text: '会话Store、会话归档、对话摘要、会话预算' }, { text: '会话级成本追踪' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '类别', width: 15 },
        { text: '功能清单', width: 55 },
        { text: '亮点', width: 30 }
      ],
      featureRows,
      [15, 55, 30]
    )
  );

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 2 =====================
  sections.push(heading1('第二章  编排架构深度对比'));

  sections.push(heading2('2.1  三大架构范式对比'));

  const archRows: CellDef[][] = [
    [{ text: '范式' }, { text: '微内核+事件总线' }, { text: 'Cordis插件框架' }, { text: 'SOP消息发布/订阅' }],
    [{ text: '核心抽象' }, { text: 'Kernel→Cluster→Handler' }, { text: 'Bundle→Plugin→Seam' }, { text: 'Role→Action→Message' }],
    [{ text: '调度流程' }, { text: 'dispatch 8步管线: cache→route→budget→security→LLM→fact-check' }, { text: 'turn/start→claim→assemble→pre-step→step/start→llm/stream→tool/call→step/end' }, { text: 'env.run()→role.observe→role.act→msg.publish' }],
    [{ text: 'Handler注册' }, { text: 'bus.registerHandler(channel, fn) — 覆写警告' }, { text: 'provider.register(SeamType, impl) — 作用域隔离' }, { text: 'role._watch(ActionType, handler) — 实例方法' }],
    [{ text: '消息传递' }, { text: '同步request()+异步requestAsync()+流式requestStream()' }, { text: '全异步Promise' }, { text: '全异步asyncio' }],
    [{ text: '类型安全' }, { text: '❌ 弱 — payload: any，request<T>()仅类型断言' }, { text: '✅ 强 — Seam<T>泛型约束' }, { text: '⚠️ 中 — Message固定结构但content是str' }],
    [{ text: '通道名安全' }, { text: '❌ 字符串字面量，拼写错误仅运行时发现' }, { text: '✅ 类引用，拼写错误编译时发现' }, { text: '✅ 类引用，拼写错误导入时发现' }],
    [{ text: '循环依赖' }, { text: '❌ 无检测 — handler间递归request→栈溢出' }, { text: '✅ ServiceProvider检测循环解析' }, { text: '❌ 无检测 — 角色间循环watch→无限消息' }],
    [{ text: '作用域' }, { text: '全局单例globalBus' }, { text: 'Context层次可覆盖' }, { text: '每Environment独立' }],
    [{ text: '消息历史' }, { text: '❌ 无 — 总线不存储消息' }, { text: '❌ 无 — Seam无状态' }, { text: '✅ Environment维护完整消息历史' }],
    [{ text: '同步开销' }, { text: '✅ 最小 — Map.get + 函数调用 O(1)' }, { text: '较高 — 全Promise包装' }, { text: '中等 — asyncio事件循环' }],
    [{ text: '热路径' }, { text: 'dialogStore每次sendMessage调用~15-20次bus.request()' }, { text: 'Seam解析需作用域链查找' }, { text: 'O(N)消息路由(N=订阅角色数)' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY EventBus', width: 28 },
        { text: 'DeepSeek Harness Cordis', width: 29 },
        { text: 'MetaGPT SOP', width: 28 }
      ],
      archRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(heading3('关键发现'));
  sections.push(bulletPoint('SKY的同步request()是性能最优的——Map.get+函数调用零调度延迟，DeepSeek和MetaGPT都是全异步'));
  sections.push(bulletPoint('类型安全是最大弱点——dialogStore.ts有30+处as any强转，通道名拼写错误仅运行时暴露'));
  sections.push(bulletPoint('DeepSeek Harness的Seam/ServiceProvider模式在可替换性和作用域隔离上优于SKY的Port模式'));
  sections.push(bulletPoint('MetaGPT的SOP消息模式在流程可验证性和审计追踪上优于SKY'));

  sections.push(heading2('2.2  SKY完整执行流程'));
  sections.push(bodyText('用户输入到LLM响应的完整路径：'));

  const flowLines = [
    'sendMessage() [dialogStore.ts]',
    '├─ Phase A: 规划',
    '│  ├─ L0 Skill Router — 规则直跳，零LLM',
    '│  ├─ L0.5 Quick Match — 关键词匹配L2 Manifest',
    '│  ├─ L1 Capability Check — 单Pipeline路由',
    '│  ├─ RaaP — 向量+关键词混合检索',
    '│  │  ├─ GREEN gate: 直接匹配',
    '│  │  ├─ YELLOW gate: MAB选择消歧策略',
    '│  │  └─ RED gate: LLM Fallback',
    '│  └─ Explore Mode — 最终降级',
    '├─ Phase A2: 计划自检',
    '├─ Phase A3: 用户确认',
    '└─ Phase B: 执行',
    '   ├─ 原生工具快速路径 — 零LLM',
    '   ├─ Direct模式 — 单次LLM调用',
    '   ├─ Macro/Chain模式 — DAG排序步骤执行',
    '   └─ 完整DAG循环 — 依赖解析+步骤失败重规划',
    '      └─ FactGuard — 事实冲突暂停'
  ];
  sections.push(...codeBlock(flowLines));

  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: '六层路由降级链', bold: true, color: COLOR_ACCENT },
      { text: '（L0→L0.5→L1→RaaP→LLM Fallback→Explore）是独有设计——无竞品具备此级别的自适应路由。' }
    ])
  );

  sections.push(heading2('2.3  竞品可借鉴模式'));

  const borrowRows: CellDef[][] = [
    [{ text: 'Seam/ServiceProvider作用域隔离' }, { text: 'DeepSeek Harness' }, { text: 'Port模式增加Context层次，支持测试隔离和运行时替换' }],
    [{ text: 'SOP流程可验证' }, { text: 'MetaGPT' }, { text: '增加Action声明式约束，_watch图谱可视化' }],
    [{ text: '消息历史/审计追踪' }, { text: 'MetaGPT Environment' }, { text: 'EventBus增加消息存储，支持回放和审计' }],
    [{ text: '编译时通道名安全' }, { text: 'DeepSeek/MetaGPT' }, { text: '用Token模式替代字符串通道名' }],
    [{ text: 'Mock数据+数据钉住' }, { text: 'n8n' }, { text: 'DebugPage增加Probe冻结功能' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '可借鉴模式', width: 30 },
        { text: '来源', width: 20 },
        { text: '对SKY的启示', width: 50 }
      ],
      borrowRows,
      [30, 20, 50]
    )
  );

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 3 =====================
  sections.push(heading1('第三章  RAG架构深度对比'));

  sections.push(heading2('3.1  分块策略'));

  const chunkRows: CellDef[][] = [
    [{ text: '策略' }, { text: '段落级贪心合并' }, { text: '递归字符分割+重叠' }, { text: '固定大小+智能边界' }],
    [{ text: '最大块' }, { text: '512 tokens' }, { text: '~1000 chars' }, { text: '~1000 tokens' }],
    [{ text: '重叠' }, { text: '❌ 无' }, { text: '✅ 可配置(~200 chars)' }, { text: '❌ 默认无' }],
    [{ text: '边界检测' }, { text: '双换行\\n\\n' }, { text: '递归: \\n\\n→\\n→. →chars' }, { text: '句子+段落' }],
    [{ text: '去重' }, { text: '✅ djb2 hash+文本长度指纹' }, { text: '❌ 无' }, { text: '文档级hash' }],
    [{ text: 'CJK处理' }, { text: '分词尊重CJK但边界仅换行' }, { text: '无特殊CJK分块' }, { text: '无特殊CJK分块' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'Open WebUI', width: 29 },
        { text: 'AnythingLLM', width: 28 }
      ],
      chunkRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: 'SKY无重叠的风险', bold: true, color: COLOR_RED },
      { text: '：跨段落边界的事实可能丢失，但避免了检索结果重复。' }
    ])
  );

  sections.push(heading2('3.2  嵌入模型'));

  const embedRows: CellDef[][] = [
    [{ text: '模型' }, { text: 'all-MiniLM-L6-v2 (384d)' }, { text: '可配置(ada-002/本地)' }, { text: '可配置(内置/云)' }],
    [{ text: '运行时' }, { text: '✅ 浏览器内transformers.js' }, { text: '服务端Python' }, { text: '服务端Python' }],
    [{ text: '离线' }, { text: '✅ 伪向量(hash+sin编码64/384维)' }, { text: '❌ 失败' }, { text: '❌ 失败' }],
    [{ text: 'CJK质量' }, { text: '差(英文中心模型)' }, { text: '中(多语言ada)' }, { text: '中' }],
    [{ text: '量化' }, { text: 'fp32' }, { text: 'fp32' }, { text: 'fp32' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'Open WebUI', width: 29 },
        { text: 'AnythingLLM', width: 28 }
      ],
      embedRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(heading3('伪向量算法详解'));
  const pseudoVecLines = [
    '1. simpleTokenize(text) — 保留CJK Unicode范围\\u4e00-\\u9fff',
    '2. 对每个token在位置i:',
    '   - djb2 hash',
    '   - 对64个slot: vec[j] += sin(hash * (j+1) * 0.01) * (1/(i+1))',
    '3. L2归一化 → 384维向量(前64维有信号，后320维零)'
  ];
  sections.push(...codeBlock(pseudoVecLines));
  sections.push(
    bodyTextMulti([
      { text: '这是所有竞品都不具备的', bold: true, color: COLOR_ACCENT },
      { text: '——零ML依赖时仍可近似语义搜索。' }
    ])
  );

  sections.push(heading2('3.3  检索算法'));

  const retrRows: CellDef[][] = [
    [{ text: '主检索' }, { text: '余弦相似度' }, { text: '向量搜索' }, { text: '余弦距离' }],
    [{ text: '辅检索' }, { text: '✅ BM25 (k1=1.5, b=0.75)' }, { text: '✅ BM25' }, { text: '❌ 无' }],
    [{ text: '融合' }, { text: '✅ RRF (k=60)' }, { text: '✅ RRF或加权' }, { text: 'N/A' }],
    [{ text: '重排序' }, { text: '❌ 无' }, { text: '✅ 交叉编码器重排序' }, { text: '❌ 无' }],
    [{ text: '阈值' }, { text: '✅ 动态(p5/p50/p95自适应)' }, { text: '固定可配置' }, { text: '固定0.25' }],
    [{ text: 'Top-K' }, { text: '5(默认),预取20' }, { text: '可配置' }, { text: '可配置' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'Open WebUI', width: 29 },
        { text: 'AnythingLLM', width: 28 }
      ],
      retrRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: 'SKY独有', bold: true, color: COLOR_ACCENT },
      { text: '：动态阈值(computeDynamicThreshold)基于得分分布历史自适应，不依赖固定截断值。' }
    ])
  );
  sections.push(
    bodyTextMulti([
      { text: 'Open WebUI优势', bold: true, color: COLOR_GREEN },
      { text: '：交叉编码器重排序在RRF融合后显著提升精度，代价是延迟。' }
    ])
  );

  sections.push(heading2('3.4  CJK关键词匹配（SKY独有）'));
  sections.push(bodyText('5层匹配策略：'));

  const cjkRows: CellDef[][] = [
    [{ text: '1' }, { text: '精确子串包含' }, { text: '1.0' }],
    [{ text: '2' }, { text: 'CJK片段重叠(≥70%)' }, { text: '0.8' }],
    [{ text: '3' }, { text: '分隔符分割后全部件匹配' }, { text: '0.8' }],
    [{ text: '4' }, { text: '短关键词(2-4字)N-gram匹配' }, { text: '0.6' }],
    [{ text: '5' }, { text: 'N-gram重叠(≥max(2, 30%))' }, { text: '0.5×(overlap/total)' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '层级', width: 10 },
        { text: '方法', width: 60 },
        { text: '信用', width: 30 }
      ],
      cjkRows,
      [10, 60, 30]
    )
  );

  sections.push(emptyLine());
  sections.push(bulletPoint('否定词降权(0.3x): "不要""别""禁止""排除"'));
  sections.push(bulletPoint('语义奖励(+0.3): 中文创建+文档词匹配工具描述'));
  sections.push(bulletPoint('角色加成(1.3x): 工具支持选定角色'));
  sections.push(bulletPoint('文件上下文加成: 活跃文件扩展→领域关键词'));
  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: '无竞品具备CJK感知的关键词匹配', bold: true, color: COLOR_ACCENT },
      { text: '——所有竞品依赖嵌入模型的隐式语义，对CJK查询效果差。' }
    ])
  );

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 4 =====================
  sections.push(heading1('第四章  成本控制架构深度对比'));

  sections.push(heading2('4.1  智能路由'));

  const routeRows: CellDef[][] = [
    [{ text: '路由机制' }, { text: '四档nano/mini/standard/pro' }, { text: '双档V4-Flash/V4-Pro' }, { text: '规则+LLM分类混合' }],
    [{ text: '复杂度分类' }, { text: '5维评分(长度+约束+步骤+历史+创意)' }, { text: '无(用户手动选择)' }, { text: '关键词+token+时间+图片' }],
    [{ text: '自适应' }, { text: '✅ ZOL: 每20次结果调整阈值, ±30%钳位' }, { text: '❌ 无' }, { text: '❌ 无' }],
    [{ text: '过度杀检测' }, { text: '✅ 实际token<档位上限20%→overkill' }, { text: '❌ 无' }, { text: '❌ 无' }],
    [{ text: '预算约束' }, { text: '✅ 三模式白名单+日/月/会话预算' }, { text: '❌ 仅账号余额' }, { text: '❌ 无' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'DeepSeek', width: 29 },
        { text: 'AnythingLLM', width: 28 }
      ],
      routeRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(heading3('ZOL自适应详解'));
  const zolLines = [
    '每20次路由结果:',
    '  成功率<70% → 阈值×1.05 (收紧，更多查询走高档)',
    '  成功率>95% → 阈值×0.95 (放松，更多查询走低档)',
    '  钳位: [默认×0.7, 默认×1.3]'
  ];
  sections.push(...codeBlock(zolLines));
  sections.push(
    bodyTextMulti([
      { text: '这是唯一零额外LLM调用的自适应路由', bold: true, color: COLOR_ACCENT },
      { text: '——所有竞品要么静态，要么需要额外LLM调用来决策。' }
    ])
  );

  sections.push(heading2('4.2  Token预算'));

  const budgetRows: CellDef[][] = [
    [{ text: '预算模式' }, { text: '✅ zero/economy/standard三档白名单' }, { text: '❌ 无' }, { text: '❌ 仅订阅档位' }],
    [{ text: '日预算' }, { text: '✅ 10 CNY' }, { text: '❌ 无' }, { text: '❌ 无' }],
    [{ text: '月预算' }, { text: '✅ 200 CNY' }, { text: '❌ 无' }, { text: '❌ 订阅上限' }],
    [{ text: '会话预算' }, { text: '✅ 5 CNY' }, { text: '❌ 无' }, { text: '❌ 无' }],
    [{ text: '超支策略' }, { text: '✅ degrade(降档)/block(阻断)/warn(警告)' }, { text: '❌ 限速' }, { text: '❌ 硬阻断' }],
    [{ text: '预算透明' }, { text: '✅ 完整(档位/类别/缓存节省明细)' }, { text: '❌ 不透明' }, { text: '⚠️ 用量页面' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'DeepSeek', width: 29 },
        { text: 'ChatGPT', width: 28 }
      ],
      budgetRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: 'zero模式硬保证', bold: true, color: COLOR_ACCENT },
      { text: '：用户在zero模式下，无论路由器决定什么，pro档调用不可能发生——白名单在预算检查之前强制执行。' }
    ])
  );

  sections.push(heading2('4.3  语义缓存'));

  const cacheRows: CellDef[][] = [
    [{ text: '层级' }, { text: '应用层(客户端)' }, { text: '基础设施层(服务端)' }, { text: '基础设施层(服务端)' }],
    [{ text: '匹配方式' }, { text: '语义相似度(余弦≥0.80-0.95)' }, { text: '精确前缀匹配' }, { text: '精确前缀匹配' }],
    [{ text: '自适应' }, { text: '✅ 目标命中率30%, 每20次查询调整阈值' }, { text: '❌ 自动但非自适应' }, { text: '❌ 无' }],
    [{ text: '域感知' }, { text: '✅ 按domain/constraint过滤' }, { text: '❌ 无' }, { text: '❌ 无' }],
    [{ text: '最大条目' }, { text: '500' }, { text: '无限' }, { text: '无限' }],
    [{ text: 'TTL' }, { text: '24h' }, { text: '请求级' }, { text: '隐式' }],
    [{ text: '成本追踪' }, { text: '✅ 已节省token+已节省CNY' }, { text: '❌ 隐含在定价中' }, { text: '❌ 反映在用量' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '维度', width: 15 },
        { text: 'SKY', width: 28 },
        { text: 'DeepSeek KV Cache', width: 29 },
        { text: 'ChatGPT', width: 28 }
      ],
      cacheRows,
      [15, 28, 29, 28]
    )
  );

  sections.push(emptyLine());
  sections.push(
    bodyTextMulti([
      { text: 'SKY是唯一具备客户端语义缓存的应用', bold: true, color: COLOR_ACCENT },
      { text: '——DeepSeek和ChatGPT的缓存是基础设施级的精确前缀匹配，不是语义匹配。"帮我写一个Python排序函数"和"写一个排序算法用Python"在SKY中可命中同一缓存条目。' }
    ])
  );

  sections.push(heading2('4.4  成本透明度'));

  const transRows: CellDef[][] = [
    [{ text: '路由原因' }, { text: '✅ human-readable reason string' }, { text: '❌' }, { text: '⚠️ 仅模型名' }, { text: '❌' }],
    [{ text: '成本明细' }, { text: '✅ 按档位+按类别' }, { text: '❌' }, { text: '❌' }, { text: '⚠️ 聚合用量' }],
    [{ text: '缓存命中' }, { text: '✅ 命中率+节省token+节省CNY' }, { text: '❌' }, { text: '❌' }, { text: '❌' }],
    [{ text: '置信度' }, { text: '✅ 0.6(预算受限)/0.9(正常)' }, { text: '❌' }, { text: '❌' }, { text: '❌' }],
    [{ text: '预算状态' }, { text: '✅ ok/warning/critical/exceeded' }, { text: '❌' }, { text: '❌' }, { text: '⚠️ 接近上限' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '可见信息', width: 20 },
        { text: 'SKY', width: 25 },
        { text: 'DeepSeek', width: 15 },
        { text: 'AnythingLLM', width: 20 },
        { text: 'ChatGPT', width: 20 }
      ],
      transRows,
      [20, 25, 15, 20, 20]
    )
  );

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 5 =====================
  sections.push(heading1('第五章  综合评估'));

  sections.push(heading2('5.1  SKY 12项独有优势'));
  sections.push(bodyText('技术实现确认的独有特性：'));
  sections.push(emptyLine());

  const uniqueAdvantages = [
    ['三模式对话', 'dialogStore.mode影响promptAssembly+UI布局', '所有竞品单模式'],
    ['四档智能路由+ZOL', 'smartRouter.classify + ZeroTokenLearner(5%步长, ±30%钳位)', '所有竞品静态路由'],
    ['三模式Token预算', 'zero/economy/standard白名单 + daily/monthly/session CostRecord', '所有竞品无应用层成本管理'],
    ['双引擎安全审核', 'dualEngineValidator: 规则首过→LLM复审', '所有竞品单层过滤'],
    ['中国法律领域约束库', 'domainConstraints: 利率上限/试用期/格式条款 + 可靠性评级 + 自动降级', '所有竞品无'],
    ['中文NER提取器', 'nerExtractor: 正则+中文数字归一化', '所有竞品无'],
    ['跨文档验证', 'crossDocValidator: 金额0.1%/日期1天/百分比0.1%容差', '所有竞品无'],
    ['伪向量降级', 'embedder: Xenova→generatePseudoVector(hash+sin编码64/384维)', '所有竞品嵌入不可用时直接失败'],
    ['DAG断点续跑', 'dagCheckpoint: completedResults/totalSteps + 24h过期 + max 20', '所有竞品无Pipeline级断点'],
    ['执行时间旅行', 'debugStore: Probe采集 + DebugPage滑块回放', '所有竞品无'],
    ['微内核+12域隔离+EventBus', 'HoloKernel dispatch + 12 domain handlers + 71 call sites via EventBus', '所有竞品单体架构'],
    ['写穿缓存+Vault迁移', 'VaultClient: sync cache + async write + 100ms debounce + 47键名映射', '所有竞品无迁移路径']
  ];

  const advRows: CellDef[][] = uniqueAdvantages.map((item, i) => [
    { text: `${i + 1}` },
    { text: item[0], bold: true },
    { text: item[1] },
    { text: item[2] }
  ]);

  sections.push(
    makeTable(
      [
        { text: '#', width: 5 },
        { text: '独有特性', width: 18 },
        { text: '技术实现', width: 42 },
        { text: '竞品状态', width: 35 }
      ],
      advRows,
      [5, 18, 42, 35]
    )
  );

  sections.push(emptyLine());
  sections.push(heading2('5.2  SKY 10项技术弱点'));

  const weaknesses = [
    ['EventBus类型安全弱', 'payload: any + 30+处as any强转 + 字符串通道名', 'DeepSeek Seam<T>泛型约束'],
    ['无循环依赖检测', 'handler间递归request→栈溢出无诊断', 'DeepSeek ServiceProvider检测'],
    ['全局单例bus', '所有测试共享globalBus，需手动clear', 'DeepSeek Context作用域隔离'],
    ['dialogStore上帝对象', '2298行+30+bus调用点，既是编排器又是状态容器', 'MetaGPT分离Role'],
    ['无交叉编码器重排序', 'RRF融合后无精排', 'Open WebUI交叉编码器'],
    ['英文中心嵌入模型', 'all-MiniLM-L6-v2对CJK语义差', 'OpenAI ada-002多语言'],
    ['线性扫描检索', 'O(n)遍历所有条目', '竞品用HNSW/IVF索引'],
    ['无分块重叠', '跨段落事实可能丢失', 'Open WebUI可配置重叠'],
    ['384维嵌入', '表示能力低于1536维', '竞品普遍1536维'],
    ['客户端成本估算', '非实际API成本', '服务端精确追踪']
  ];

  const weakRows: CellDef[][] = weaknesses.map((item, i) => [
    { text: `${i + 1}` },
    { text: item[0], bold: true, color: COLOR_RED },
    { text: item[1] },
    { text: item[2] }
  ]);

  sections.push(
    makeTable(
      [
        { text: '#', width: 5 },
        { text: '弱点', width: 20 },
        { text: '技术根因', width: 40 },
        { text: '最强竞品方案', width: 35 }
      ],
      weakRows,
      [5, 20, 40, 35]
    )
  );

  sections.push(emptyLine());
  sections.push(heading2('5.3  架构定位差异'));

  const archPosRows: CellDef[][] = [
    [{ text: 'SKY' }, { text: '微内核+领域隔离' }, { text: '解耦最大化，代价：开发复杂度+EventBus注册时序+类型安全弱' }],
    [{ text: 'DeepSeek Harness' }, { text: 'Cordis插件' }, { text: '可替换最大化，代价：学习曲线+配置复杂度' }],
    [{ text: 'n8n' }, { text: 'DAG工作流' }, { text: '集成最大化(500+)，代价：节点间数据传递开销' }],
    [{ text: 'MetaGPT' }, { text: 'SOP消息' }, { text: '角色协作最大化，代价：SOP固定+消息图调试难' }],
    [{ text: 'Open WebUI' }, { text: 'Python插件' }, { text: '扩展最大化(exec加载)，代价：安全性风险' }],
    [{ text: 'AnythingLLM' }, { text: 'RAG专注' }, { text: '文档对话最大化，代价：工作流能力弱' }]
  ];

  sections.push(
    makeTable(
      [
        { text: '产品', width: 20 },
        { text: '架构范式', width: 20 },
        { text: '核心权衡', width: 60 }
      ],
      archPosRows,
      [20, 20, 60]
    )
  );

  sections.push(new Paragraph({ children: [new PageBreak()] }));

  // ===================== CHAPTER 6 =====================
  sections.push(heading1('第六章  发展建议'));
  sections.push(bodyText('技术深度确认版，按优先级分为4级共24项建议。'));
  sections.push(emptyLine());

  // Urgent
  sections.push(priorityTag('紧急 Priority 1', COLOR_RED));
  const urgentItems = [
    ['EventBus类型安全增强', 'Token模式替代字符串通道名，泛型约束payload类型', '修复#1技术弱点'],
    ['条件分支/循环节点', 'Pipeline DAG增加IF/ELSE和Loop节点', '最大功能缺口 vs n8n/Dify'],
    ['HTTP/API集成节点', 'Pipeline增加HTTP Request节点', '最大功能缺口 vs n8n/Dify'],
    ['代码执行沙箱', '至少JS/Python执行+沙箱隔离', '竞品标配能力'],
    ['MCP Server暴露', '将技能/管道暴露为MCP工具', '双向MCP集成']
  ];
  urgentItems.forEach((item, i) => {
    sections.push(numberedItem(i + 1, item[0], `${item[1]}（${item[2]}）`, COLOR_RED));
  });

  sections.push(emptyLine());

  // Important
  sections.push(priorityTag('重要 Priority 2', COLOR_AMBER));
  const importantItems = [
    ['交叉编码器重排序', 'RRF融合后增加精排层', 'Open WebUI已验证有效'],
    ['多语言嵌入模型', '替换all-MiniLM-L6-v2为paraphrase-multilingual-MiniLM', 'CJK语义质量提升'],
    ['DeepSeek推理链集成', 'reasoning_content+reasoning_effort', 'Chain-of-Thought可见性'],
    ['BM25+重排序混合检索', '知识库增加BM25层+交叉编码器', '检索质量提升'],
    ['智能技能选择', 'Schema级过滤省80%Token', 'AnythingLLM已验证'],
    ['Web搜索RAG', 'SearXNG等搜索引擎', '开放域知识获取'],
    ['Mock数据+Probe钉住', 'DebugPage数据冻结', 'n8n调试优势'],
    ['多Agent协作', '_watch+Message模式', 'MetaGPT已验证']
  ];
  importantItems.forEach((item, i) => {
    sections.push(numberedItem(i + 6, item[0], `${item[1]}（${item[2]}）`, COLOR_AMBER));
  });

  sections.push(emptyLine());

  // Enhance
  sections.push(priorityTag('增强 Priority 3', COLOR_GREEN));
  const enhanceItems = [
    ['循环依赖检测', 'request()调用图分析+运行时检测', '架构健壮性'],
    ['dialogStore拆分', '编排器与状态容器分离', '可维护性'],
    ['EventBus消息历史', '支持回放和审计', '可调试性'],
    ['HNSW/IVF索引', '替代线性扫描', '检索性能'],
    ['分块重叠', '可配置overlap', '检索完整性'],
    ['RBAC/多用户', '企业场景', '商业化']
  ];
  enhanceItems.forEach((item, i) => {
    sections.push(numberedItem(i + 14, item[0], `${item[1]}（${item[2]}）`, COLOR_GREEN));
  });

  sections.push(emptyLine());

  // Differentiate
  sections.push(priorityTag('差异化 Priority 4', COLOR_ACCENT));
  const diffItems = [
    ['约束库扩展', '金融/劳动/合同→医疗/教育/数据保护', '垂直领域深化'],
    ['NER增强', '更多行业实体类型', 'NLP能力深化'],
    ['ZOL产品化', '零令牌学习包装为可复用SDK', '技术输出'],
    ['Vault SDK', '写穿缓存+迁移提取为独立包', '技术输出'],
    ['伪向量SDK', 'hash+sin编码提取为独立包', '技术输出']
  ];
  diffItems.forEach((item, i) => {
    sections.push(numberedItem(i + 20, item[0], `${item[1]}（${item[2]}）`, COLOR_ACCENT));
  });

  sections.push(emptyLine());
  sections.push(emptyLine());

  // Closing
  sections.push(
    new Paragraph({
      spacing: { before: 400 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: '—— 文档结束 ——',
          font: FONT_CN,
          size: 22,
          color: '999999'
        })
      ]
    })
  );

  // ===================== BUILD DOCUMENT =====================
  const doc = new Document({
    sections: [
      {
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
      }
    ],
    styles: {
      default: {
        document: {
          run: {
            font: FONT_CN,
            size: 21
          }
        }
      }
    }
  });

  // 输出到当前用户桌面（开源后可移植）；需要放别处时用 HOLO_REPORT_DIR 指定
  const outputDir = process.env.HOLO_REPORT_DIR || path.join(os.homedir(), 'Desktop');
  const outputPath = path.resolve(outputDir, 'SKY功能全景与业界对比（技术深度版）.docx');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`✅ Document generated: ${outputPath}`);
  console.log(`   Size: ${(buffer.length / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
