# SKY ⭐

A local-first AI tool console — route, validate, and optimize your LLM calls from one desktop app.

Built by a solo developer who got tired of copying prompts between browser tabs.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![TypeScript Strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Tests](https://img.shields.io/badge/tests-212%20spec%20files-blue.svg)](docs/60-测试与验收.md)

<!-- ![SKY Screenshot](docs/screenshot.png) -->

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

**Workbench Interface** — one workspace where you type a request, see which routing layer took it, and get the result back with its artifacts.

> ⚠️ Earlier revisions of this README advertised a "**3D Star Map Interface**" (125 tool nodes arranged as a galaxy, drag between stars to build a pipeline). That UI **was removed in 2026-09**: there is no `three` dependency, no `useThreeScene.ts`, and `src/App.vue` mounts `WorkbenchShell`. See [docs/00-总览与口径](docs/00-总览与口径.md) for the full list of retired claims.

**Smart Routing** — Before sending anything to an LLM, the app checks:

1. Does a built-in rule already handle this? → Deterministic plan (L0)
2. Have we seen this exact request before? → Return cached result (L2 fingerprint / semantic cache)
3. Can a keyword match a known manifest with high confidence? → One-step execution (L0.5)
4. Otherwise → LLM-assisted matching and planning (L2 ambiguity / L3 / L4)

**Dual-Engine Security** — Every shell write command goes through rule-based checks AND an LLM audit. If either fails, the command is blocked. Fail-closed by design.

**FactGuard** — When LLM output contains numbers, dates, or contract IDs that contradict the source document, it auto-corrects small errors and blocks big ones.

**Cost Savings** — Measured on this machine (2026-10): requests that hit a compiled **L2 macro** execute with **0 added LLM tokens** (the DAG runs its steps deterministically), and semantic caching / the rule router skip the LLM entirely on repeated or simple inputs. ⚠️ An earlier revision claimed "**39–49% token reduction**"; that figure could **not be reproduced** and has been removed pending a reproducible benchmark. See [docs/20-请求生命周期与路由](docs/20-请求生命周期与路由.md) for the measured breakdown (a plain request carries ~3.5K prompt tokens, ~80% of which is the tool schema).

---

## Architecture at a Glance

```
Your input → [L0 Rule Router] → [L0.5 Keyword Match] → [L2 Manifest/Cache] → [L3 LLM Arbitration] → [L4 Explore]
                    ↓ hit              ↓ hit                 ↓ hit                  ↓ miss
               deterministic      1-step plan          cached result          full LLM planning
                                                                                      ↓
                                                                          [Dual-Engine Security Audit]
                                                                                      ↓
                                                                            [DAG Pipeline Execution]
                                                                                      ↓
                                                                              [FactGuard Verification]
                                                                                      ↓
                                                                                    Result
```

### Routing Layers

| Layer | Count | What it is |
|-------|-------|------------|
| L0 | **12 rules** | Built-in rule router (`src/services/l0SkillRouter.ts:272`) |
| L0.5 | — | Keyword quick-match for single-step manifests (gate `l05Pass = 0.6`) |
| L1 | **6** | Single-node capability direct-call |
| L2 | **20 manifest files** | Scenario macros (`config/l2_manifests/`), matched by `src/services/toolRetrieval.ts` |
| L3 | **98 placeholders** | Author-reserved community slots — **kept on purpose, do not clean up** |
| L4 | — | Exploratory planning (auto-executes when the plan contains no shell) |

> The old "**125 tool nodes**" figure refers to `src/data/topology.ts`, a **legacy data file** left over from the star-map era. It is not a UI description.

---

## Getting Started

### Prerequisites

- Node.js >= 18
- npm >= 9
- Windows (packaging currently Windows-only; dev works cross-platform)

### Run in Dev Mode

```bash
git clone https://github.com/sky-mirrors/SKY.git
cd SKY
npm install
npm run dev
```

### Download / Release

Prebuilt **Windows portable** builds are published on the [Releases](../../releases) page — no install needed, just double-click.

Tagging `vX.Y.Z` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): it runs the test suite → builds → packages a portable EXE → attaches it to a **draft** release for you to review before publishing.

To build locally:

```bash
npm install
npm run package:win        # → dist\SKY <version>.exe
```

> ⚠️ Packaging downloads helper binaries (winCodeSign / NSIS) **from GitHub**. On a restricted network set
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`, or let CI do the packaging instead.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| UI | Vue 3 + Pinia | Reactive state, composables for workflow logic |
| Desktop | Electron 33 | File system, multi-window, local API calls |
| Build | electron-vite + electron-builder | Fast HMR, single-exe output |
| Language | TypeScript strict | No implicit any, no type escapes |
| Embeddings | @xenova/transformers | Local vector search, no API needed |
| Documents | docx, xlsx, pdf-parse, mammoth | Read/write Word, Excel, PDF |
| Security | DOMPurify | HTML sanitization |
| Testing | Vitest | 212 spec files — see [docs/60-测试与验收](docs/60-测试与验收.md) for the exact coverage boundaries |

---

## Token Optimization

| Mechanism | Savings | When It Kicks In |
|-----------|---------|-----------------|
| L0 Rule Router | Skips LLM planning | Built-in rule matches |
| L0.5 Keyword Match | Skips multi-step planning | Keyword hit + confidence >= gate (0.6) |
| L2 Macro Execution | **0 added tokens** | Compiled manifest matches |
| Execution Fingerprint Cache | Reuses result | Same input + same manifest |
| Rule Engine Fallback | Replaces LLM | LLM unavailable + rule hits |
| Dual-Engine Audit Cache | 500-2000 tokens/audit | Repeat audit within 24h |
| FactGuard Auto-Correct | Avoids regeneration | Minor fact discrepancy |
| Disambiguation Cache | Skips LLM disambiguation | Same query within 1h |
| Model Tiering | Right-size the model | nano(512) / mini(1024) / standard(4096) / pro(8192) maxTokens |
| Pipeline Checkpoints | Resume from breakpoint | Re-run after failure |

---

## Security Model

This project takes a **fail-closed** approach: if the security check can't give a clear "safe", the command is blocked.

### Shell Security Engine
- **Whitelist**: **12** safe command prefixes (`electron/shell-security.ts:4` → `SHELL_ALLOWED_COMMANDS`)
- **Blacklist**: **82** dangerous-pattern regexes (`electron/shell-security.ts:38` → `NODE_E_DANGEROUS_PATTERNS`), plus **6** vetted `node -e` trust signatures (`:123`)
- **MCP executables**: 5 allowed (`npx` / `node` / `python3` / `python` / `uvx`)
- **Write path guard**: only Desktop / Docs directories writable; `node -e` write targets are resolved to absolute paths and checked (blocks `..` traversal and executable extensions)
- **Timeout tiers**: Quick 10s / Standard 60s / Heavy 120s / Hard limit 180s

### Dual-Engine Audit
- **Rule engine**: Detects write ops, high-risk deletions, extracts target file paths
- **LLM engine**: Judges intent match, parameter sanity, risk level
- **Cache**: 24h TTL, max 500 entries — cache hit skips LLM audit entirely
- Read-class actions are only audited when the target path is sensitive

### Write Approval
- 12 write-class tools go through `src/services/writeGate.ts` three-state approval (deny / once / always). Missing grant = denied (fail-closed).

### FactGuard
- **5 entity types**: Currency (>10% diff = critical), Dates (>3 days = critical), Percentages, Contract IDs (any mismatch = critical), Names
- Extraction runs over the **whole document in overlapping chunks** (5000 chars, 500 overlap) — not just the first 5000 chars
- **Auto-correct**: Minor differences patched in-place, zero tokens
- **Hallucination detection**: Entities in output that don't exist in source → blocked

Full details: [docs/40-安全模型](docs/40-安全模型.md).

---

## Testing

| Metric | Value |
|--------|-------|
| Test files | **212** on disk (`.spec.ts`) — **209 collected** by the runner (3 e2e specs excluded) |
| Test cases | **2753** — **2752 passed / 1 failed** (the known Ollama noise below), measured 2026-10-09 |
| E2E specs | 6 in `test/e2e/` — **excluded from `npm test`**, no runner script |
| Coverage gate | 40% lines/functions/statements, 30% branches — **only `src/services` + `src/stores`** |
| Real-machine smoke | `npm run smoke` → drives the running app over CDP and asserts 5 user journeys |
| Known noise | 1 case (`apiStore.timerDispose.spec.ts`) fails **only while a local Ollama is running** — environment-specific, not a regression |

> ℹ️ **`npm test` all-green does NOT mean the app works.** 30 specs stub out `electronAPI`, so the real file-system and IPC boundaries are simulated. Numbers in earlier revisions (1685 / 2653 / 1129) are stale — re-run `npm test` before quoting any figure. `TEST_REPORT.md` was retired; its content folded into [docs/60-测试与验收](docs/60-测试与验收.md).

---

## Project Structure

```
SKY/
├── electron/                # Main process (32 modules)
│   ├── main.ts              # Entry: window management + IPC dispatch
│   ├── ipc-handlers.ts      # IPC routes (file/shell/HTTP/MCP/keys)
│   ├── shell-security.ts    # Shell security engine (12 whitelist + 82 blacklist patterns)
│   ├── pathValidator.ts     # Path read/write validation
│   ├── mcp-manager.ts       # MCP subprocess manager
│   ├── window-manager.ts    # Multi-window creation + global shortcuts
│   ├── preload.ts           # contextBridge electronAPI
│   └── file*.ts             # File operators (pure planning cores: rename / unzip / sort / convert)
├── src/                     # Renderer process (Vue 3)
│   ├── main.ts              # Vue app entry + Pinia init
│   ├── App.vue              # Root: workbench/preview switch + shortcuts
│   ├── kernel/              # Six-layer funnel orchestration + hooks + clusters
│   ├── kernels/             # Kernel plugins (default / lite)
│   ├── host/                # Hot-plug host (plugins / domains / packs)
│   ├── domains/             # Domain handlers (bus channel registration points)
│   ├── packs/               # Built-in domain packs (finance / hr / legal)
│   ├── services/            # Core business logic (72 modules)
│   │   ├── l0SkillRouter.ts       # L0 rule routing + L0.5 quick match + L1 + L4
│   │   ├── toolRetrieval.ts       # L2 matching + gates + RRF fusion
│   │   ├── compositeIntent.ts     # Composite-intent engine (table-driven)
│   │   ├── macroExecutor.ts       # DAG executor + tool loop + fingerprints
│   │   ├── dualEngineValidator.ts # Dual-engine security audit
│   │   ├── factGuard.ts           # Fact consistency check (5 entity types)
│   │   ├── writeGate.ts           # Write-class tool approval
│   │   ├── deliverableCheck.ts    # Artifact verification (anti "fake success")
│   │   ├── knowledgeBase.ts       # Hybrid retrieval
│   │   └── ...
│   ├── stores/              # Pinia stores (18)
│   ├── exam/                # Acceptance exam system (V1 18 + V2 50 cases)
│   └── data/                # Static data (manifests registry, skill catalog, legacy topology)
├── test/                    # 212 spec files
├── config/l2_manifests/     # 20 L2 manifest JSONs
├── scripts/scenario-smoke.mjs  # Real-machine smoke test
├── electron.vite.config.ts  # Build config
├── vitest.config.ts         # Test config
└── package.json
```

---

## Docs

The authoritative documentation is a **set of per-topic volumes** under `docs/`. Each claim in them carries a `file:line` anchor checked against the code.

| Volume | Covers |
|--------|--------|
| [docs/00-总览与口径](docs/00-总览与口径.md) | What this is, and the seven claims that are **no longer true** |
| [docs/10-架构与分层](docs/10-架构与分层.md) | Process model, funnel assembly, hot-plug, domain packs |
| [docs/20-请求生命周期与路由](docs/20-请求生命周期与路由.md) | Request lifecycle, routing formulas & gates, composite intents |
| [docs/30-机制台账与边界](docs/30-机制台账与边界.md) | Status of all 20 mechanisms, gap list, known boundaries |
| [docs/40-安全模型](docs/40-安全模型.md) | Shell engine, path validation, write approval, FactGuard |
| [docs/50-记忆与上下文](docs/50-记忆与上下文.md) | What the app remembers, and what gets injected per request |
| [docs/60-测试与验收](docs/60-测试与验收.md) | Test boundaries, smoke test, exam system |
| [docs/90-术语表与索引](docs/90-术语表与索引.md) | Glossary (internal jargon → plain language) + file index |
| [集成工具设计.txt](集成工具设计.txt) | Original design doc (historical) |
| L2工具编译标准V1.0.md | L2 tool compilation spec |
| SECURITY.md | Known upstream vulnerabilities + remediation plan |

**Rule:** code changed → update the matching volume in the same commit. No new documents. Historical documents were deleted; recover them from git history (see [docs/README](docs/README.md)).

---

## Contributing

Issues and PRs welcome! See CONTRIBUTING.md for setup, code style, and PR flow.

---

## License

[Apache-2.0](LICENSE) — use it, fork it, just keep the attribution.
