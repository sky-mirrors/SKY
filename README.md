# HoloStarmap ⭐

A local-first AI tool console — route, validate, and optimize your LLM calls from one desktop app.

Built by a solo developer who got tired of copying prompts between browser tabs.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![TypeScript Strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Tests](https://img.shields.io/badge/tests-1685%2F1685-brightgreen.svg)](TEST_REPORT.md)

<!-- ![HoloStarmap Screenshot](docs/screenshot.png) -->

---

## Why This Exists

I wanted one desktop app where I could:

- **Talk to LLMs** without my data leaving my machine
- **Chain tools together** — read a PDF, analyze it, write a report — in one flow
- **Pay less** — cache what I can, skip the LLM when rules suffice
- **Stay safe** — every shell command gets double-checked before execution

No cloud backend. No API keys on someone else's server. Your keys stay on your disk.

---

## What It Does

**3D Star Map Interface** — 125 tool nodes arranged as a galaxy. Click a star, run a tool. Drag between stars, build a pipeline. It's a bit nerdy, but it makes multi-step workflows visual and fast.

**Smart Routing** — Before sending anything to an LLM, the app checks:
1. Does a local rule already handle this? → Skip the LLM entirely (0 tokens)
2. Have we seen this exact request before? → Return cached result (0 tokens)
3. Can a keyword match it with high confidence? → One-step execution
4. Otherwise → Full LLM planning with cost-optimized model selection

**Dual-Engine Security** — Every shell write command goes through rule-based checks AND an LLM audit. If either fails, the command is blocked. Fail-closed by design.

**FactGuard** — When LLM output contains numbers, dates, or contract IDs that contradict the source document, it auto-corrects small errors and blocks big ones.

**Cost Savings** — Benchmarked at **39-49% token reduction** across different workloads, mainly from caching and smart routing.

---

## Architecture at a Glance

```
Your input → [Rule Router] → [Keyword Match] → [Cache Lookup] → [LLM Planning]
               ↓ hit            ↓ hit             ↓ hit           ↓ miss
             0 tokens        1 step            cached result    full pipeline
                                                               ↓
                                                    [Dual-Engine Security Audit]
                                                               ↓
                                                    [DAG Pipeline Execution]
                                                               ↓
                                                    [FactGuard Verification]
                                                               ↓
                                                           Result
```

### Tool Topology (125 Nodes)

| Layer | Count | Examples |
|-------|-------|---------|
| L0 — You | 1 | Natural language input center |
| L1 — Core Tools | 6 | Knowledge feeder, Model gateway, Task translator, Pipeline builder, Workspace memory, Result formatter |
| L2 — Scenario Tools | 20 | Financial report analysis, Contract review, Resume screening, Sales proposal, Weekly report |
| L3 — Community Tools | 98 | SEO optimization, Sentiment analysis, Invoice OCR, and more — community-ranked with decay |

---

## Getting Started

### Prerequisites

- Node.js >= 18
- npm >= 9
- Windows (packaging currently Windows-only; dev works cross-platform)

### Run in Dev Mode

```bash
git clone https://github.com/sky-mirrors/HoloStarmap.git
cd HoloStarmap
npm install
npm run dev
```

### Build Portable EXE

```bash
npx electron-vite build
npx electron-builder --win portable
# Output: dist/HoloStarmap 0.1.0.exe
```

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| UI | Vue 3 + Pinia | Reactive state, composables for 3D logic |
| 3D | Three.js | 125-node galaxy with raycasting & drag |
| Desktop | Electron 33 | File system, multi-window, local API calls |
| Build | electron-vite + electron-builder | Fast HMR, single-exe output |
| Language | TypeScript strict | No implicit any, no type escapes |
| Embeddings | @xenova/transformers | Local vector search, no API needed |
| Documents | docx, xlsx, pdf-parse, mammoth | Read/write Word, Excel, PDF |
| Security | DOMPurify | HTML sanitization |
| Testing | Vitest | 1685 tests, 100% pass rate |

---

## Token Optimization

| Mechanism | Savings | When It Kicks In |
|-----------|---------|-----------------|
| L0 Rule Router | 100% (skip LLM) | 7 built-in patterns match |
| L0.5 Keyword Match | Skip multi-step planning | Keyword hit + confidence >= 0.8 |
| Execution Fingerprint Cache | 100% (reuse result) | Same input + same manifest |
| Rule Engine Fallback | 100% (replace LLM) | LLM unavailable + rule hits |
| Dual-Engine Audit Cache | 500-2000 tokens/audit | Repeat audit within 24h |
| FactGuard Auto-Correct | Avoid regeneration | Minor fact discrepancy |
| Disambiguation Cache | Skip LLM disambiguation | Same query within 1h |
| Model Tiering | Right-size the model | nano(512) / mini(1024) / standard(4096) / pro(8192) |
| Proactive Scheduling | 0 cost on arrival | Time/behavior rule triggers |
| Pipeline Checkpoints | Resume from breakpoint | Re-run after failure |

---

## Security Model

This project takes a **fail-closed** approach: if the security check can't give a clear "safe", the command is blocked.

### Shell Security Engine
- **Whitelist**: 19 safe command prefixes (npm install, ls, cat, echo...)
- **Blacklist**: 77 dangerous pattern regexes (child_process, eval, rm -rf, powershell...)
- **Trust signatures**: 6 vetted `node -e` require patterns (docx, xlsx, pdf-parse, mammoth, archiver, marked)
- **Write path guard**: Only Desktop/Docs directories writable
- **Timeout tiers**: Quick 10s / Standard 60s / Heavy 120s / Hard limit 180s

### Dual-Engine Audit
- **Rule engine**: Detects write ops, high-risk deletions, extracts target file paths
- **LLM engine**: Judges intent match, parameter sanity, risk level
- **Cache**: 24h TTL, max 500 entries — cache hit skips LLM audit entirely

### FactGuard
- **5 entity types**: Currency (>10% diff = critical), Dates (>3 days = critical), Percentages, Contract IDs (any mismatch = critical), Names
- **Auto-correct**: Minor differences patched in-place, zero tokens
- **Hallucination detection**: Entities in output that don't exist in source → blocked

---

## Testing

| Metric | Value |
|--------|-------|
| Test files | 87 |
| Total cases | 1685 |
| Pass rate | 100% |

See [TEST_REPORT.md](TEST_REPORT.md) for details.

---

## Project Structure

```
HoloStarmap/
├── electron/                # Main process
│   ├── main.ts              # Entry: window management + IPC dispatch
│   ├── ipc-handlers.ts      # IPC routes (file/shell/HTTP/MCP/keys)
│   ├── shell-security.ts    # Shell security engine (77 blacklist + 6 whitelist)
│   ├── mcp-manager.ts       # MCP subprocess manager
│   ├── window-manager.ts    # Multi-window creation + global shortcuts
│   ├── preload.ts           # contextBridge electronAPI
│   └── types.d.ts           # Electron API type definitions
├── src/                     # Renderer process (Vue 3)
│   ├── main.ts              # Vue app entry + Pinia init
│   ├── App.vue              # Root: starmap/preview switch + shortcuts
│   ├── models/index.ts      # Global type definitions
│   ├── components/          # 14 Vue components
│   ├── composables/         # Vue composables
│   │   ├── useThreeScene.ts # Three.js scene (camera/raycast/selection)
│   │   └── useDagEngine.ts  # DAG execution engine hook
│   ├── services/            # Core business logic (13 modules)
│   │   ├── l0SkillRouter.ts       # L0 rule routing + L0.5 keyword match
│   │   ├── pipelineExecutor.ts     # DAG executor + checkpoints
│   │   ├── scheduleOptimizer.ts    # Fingerprint cache + auto-compile + model tiering
│   │   ├── dualEngineValidator.ts  # Dual-engine security audit
│   │   ├── factGuard.ts            # Fact consistency check (5 entity types)
│   │   ├── knowledgeBase.ts        # Hybrid retrieval (vector/keyword/pseudo-vector)
│   │   ├── embedder.ts             # Local embedding + cosine similarity
│   │   └── ...
│   ├── stores/              # Pinia stores (13)
│   └── data/                # Static data
│       ├── topology.ts      # 125-node topology (golden angle sphere algorithm)
│       ├── skillCatalog.ts  # Skill marketplace catalog
│       └── l2Manifests.ts   # L2 tool compilation manifests
├── test/                    # Tests
│   ├── unit/
│   ├── integration/
│   └── chaos/
├── config/
│   └── l2_manifests/        # L2 manifest JSON configs
├── electron.vite.config.ts  # Build config
├── vitest.config.ts         # Test config
├── tsconfig.json            # TypeScript strict config
└── package.json
```

---

## Docs

| Document | Description |
|----------|-------------|
| [集成工具设计.txt](集成工具设计.txt) | Original design doc (3D starmap vision + interaction spec + skill strategy) |
| [L2工具编译标准V1.0.md](L2工具编译标准V1.0.md) | L2 tool compilation spec (Manifest types + execution modes + param mapping) |
| [TEST_REPORT.md](TEST_REPORT.md) | Test verification report |
| [SECURITY.md](SECURITY.md) | Known vulnerability assessment + remediation plan |

---

## Contributing

Issues and PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and PR flow.

---

## License

[Apache-2.0](LICENSE) — use it, fork it, just keep the attribution.
