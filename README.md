# SKY

**An experimental technical preview of a local-first AI tool console** — route, validate, and execute LLM-assisted tasks from a desktop app, with the routing decisions and their costs visible instead of hidden.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Tests](https://img.shields.io/badge/tests-210%20spec%20files-blue.svg)](docs/60-测试与验收.md)

> ## ⚠️ Read this first
>
> This is a **technical preview, not a product**. It is published so the ideas can be read, run, and argued with — not because it is finished.
>
> - **No stability promise.** Interfaces, data formats, and the routing pipeline change between commits. There is no migration path for user data.
> - **No support promise.** Issues are read, but there is no SLA, no roadmap commitment, and no maintainer on call.
> - **Windows is the only tested target.** Development mode works cross-platform; packaging is Windows-only and has not been validated on macOS or Linux.
> - **You need your own LLM API key.** Without one the app falls back to its deterministic rule layer only.
> - **It can write files and run shell commands on your machine** — that is the point of the thing. The guard rails are described in [Security model](#security-model) and are deliberately conservative, but you should read them before pointing it at anything you care about.
> - **Authoritative documentation is in Chinese**, under `docs/`. This README is the English entry point.

---

## What it is

A single desktop app (Electron + Vue 3) that takes a natural-language request and decides **how cheaply it can be answered** — before spending tokens:

1. Does a built-in rule already handle this? → deterministic plan, **0 tokens**
2. Have we seen this exact request before? → fingerprint / semantic cache hit
3. Can a keyword match a known macro with high confidence? → one-step execution
4. Otherwise → LLM-assisted matching, planning, and execution

Every routing decision is recorded and visible in the UI (which layer took the request, what it cost, what it produced). That visibility is the actual thesis of the project: most AI tooling hides the routing decision, and hidden routing is where tokens and trust both leak.

## Status — read this before evaluating

Status is tracked per mechanism in [`docs/30-机制台账与边界.md`](docs/30-机制台账与边界.md) ("mechanism ledger"), with the rule that a mechanism counts as **live** only if a production call path reaches it.

| Area | State |
|---|---|
| L0 / L0.5 / L1 rule routing | **Live** — see [Routing layers](#routing-layers) |
| L2 retrieval + macro execution | **Live** |
| L3 LLM arbitration | **Live**, but only invoked when ≥2 candidates survive filtering |
| L4 exploratory planning | **Live** |
| Dual-engine security audit, FactGuard, write gate | **Live** — fail-closed |
| Execution fingerprint cache, semantic cache | **Live** |
| Competitive EMA (M16) | **Half-live** — implemented, but off by default, so the branch does not fire in production |
| Consumer-context truncation | **Half-live** — the `standard` tier still only passes ~800 characters |
| **Skill catalogue DAG execution** | **Not wired** — see [Capability layers](#capability-layers-packs--skills--mcp) |
| **MCP store coverage for skills** | **Incomplete** — 16 of 21 declared servers are not in the store |

If a claim here disagrees with the ledger, the ledger wins — it carries `file:line` anchors.

## Quick start

```bash
git clone https://github.com/sky-mirrors/SKY.git
cd SKY
npm install
npm run dev
```

Requirements: **Node.js ≥ 18**, **npm ≥ 9**.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | electron-vite dev mode with HMR |
| `npm run build` | Build main / preload / renderer into `out/` |
| `npm run typecheck` | `tsc -b` + `vue-tsc --noEmit` — **must be green** |
| `npm test` | Vitest, 210 spec files (excludes `test/e2e/**`) |
| `npm run smoke` | Real-machine journey smoke — needs the app running with CDP open |
| `npm run smoke:window-controls` | Real-machine check that every sub-window's minimize/close actually works |
| `npm run package:win` | Windows portable build → `dist/SKY <version>.exe` |
| `npm run verify:pdf` / `:image` / `:media` | Standalone Electron e2e scripts for the document / image / media pipelines |

> **`npm test` green does not mean the app works.** 30 specs stub out `electronAPI`, so the real filesystem and IPC boundaries are simulated. For evidence about the real thing, use `npm run smoke` or `npm run smoke:window-controls` — both drive a running instance over CDP. See [`docs/60-测试与验收.md`](docs/60-测试与验收.md).

### Prebuilt builds

Tagging `vX.Y.Z` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): tests → build → portable EXE → attached to a **draft** release for review before publishing.

> Packaging downloads helper binaries (winCodeSign / NSIS) from GitHub. On a restricted network set
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

## Architecture

```
input → [L0 rule] → [L0.5 keyword] → [L2 manifest/cache] → [L3 LLM] → [L4 explore]
           ↓ hit         ↓ hit              ↓ hit             ↓ miss
      deterministic   1-step plan      cached result    full LLM planning
                                                                  ↓
                                                    [dual-engine security audit]
                                                                  ↓
                                                         [DAG execution]
                                                                  ↓
                                                         [FactGuard check]
                                                                  ↓
                                                               result
```

### Routing layers

| Layer | Size | What it is |
|---|---|---|
| L0 | **12 rules** | Built-in rule table, first match wins (`src/services/l0SkillRouter.ts`) |
| L0.5 | — | Keyword quick-match for single-step manifests (gate 0.6) |
| L1 | **6** | Single-node capability direct call |
| L2 | **20 manifests** | Scenario macros (`config/l2_manifests/`), matched by `src/services/toolRetrieval.ts` |
| L3 | **98 placeholders** | Author-reserved community slots — **kept on purpose**, see the ledger |
| L4 | — | Exploratory planning (auto-executes when the plan needs no shell) |

Gates and confidence formulas live in [`docs/20-请求生命周期与路由.md`](docs/20-请求生命周期与路由.md); they are quoted with code anchors rather than duplicated here.

## Capability layers: packs / skills / MCP

Three different things that are easy to confuse, at three different depths:

| | Domain packs | Skills | MCP servers |
|---|---|---|---|
| **What it is** | Domain knowledge + constraints + execution, hooked into every routing layer | A pre-arranged DAG template + a declaration of which MCP server it needs | External tool servers, spawned as subprocesses |
| **Reaches routing?** | **Yes** — hooks at L0/L0.5/L1/L2/L3/L4 plus veto gates | **No** — no execution consumer today | **Yes** — L2 hit produces a `mcp-direct` call |
| **Who executes it** | pack runtime + constraint engine | nothing yet | main-process manager → `mcpStore.callTool` |
| **Stored in** | `{userData}/holostarmap-packs` (built-in packs ship separately) | vault key `holo-skills` | vault key `holo-mcp-connections` |

**Two honest caveats, because they are the kind of thing a README usually hides:**

1. **Installing a skill does not execute anything.** The catalogue entries carry `nodes`/`edges`, but nothing feeds them to the DAG engine (`useDagEngine` serves the pipeline canvas only), and `createSkillFromWorkflow` has no caller. Today skills are a discovery and one-click-install surface; the execution path is MCP.
2. **16 of the 21 skills declare an MCP server that the MCP store does not offer** (the store has 5). The install handler looks the declared id up in the store and, on miss, **silently does nothing** — no install, no message. The skill data already carries a full `mcpCommand`/`mcpArgs`, so the fallback exists in the data; the lookup path just does not use it.

## Security model

Fail-closed: if a check cannot conclude "safe", the action is blocked.

- **Shell allow-list**: **12** safe command prefixes (`electron/shell-security.ts` → `SHELL_ALLOWED_COMMANDS`)
- **Dangerous-pattern deny-list**: **77** regexes (`NODE_E_DANGEROUS_PATTERNS`), plus vetted `node -e` signatures
- **MCP interpreters**: 5 allowed (`npx` / `node` / `python3` / `python` / `uvx`)
- **Write-path guard**: writes are restricted to Desktop / Documents / Downloads; `node -e` write targets are resolved to absolute paths and checked, blocking `..` traversal and executable extensions
- **Dual-engine audit**: rule engine + LLM engine; either one failing blocks the command, with a 24h cache so repeats do not re-pay
- **Write approval**: write-class tools go through three-state approval (deny / once / always). **Missing grant = denied.**
- **FactGuard**: numbers, dates, percentages, contract IDs, and names in output are checked against the source; minor drift is corrected in place, hallucinated entities are blocked

Details and threat caveats: [`docs/40-安全模型.md`](docs/40-安全模型.md) and SECURITY.md.

## Verification

Measured on 2026-10-09, on this repository, with the commands below — not carried over from an older README.

| Check | Result |
|---|---|
| `npm test` | **2667 cases** — **2666 passed / 1 failed**, 210 spec files, ~8.4 s |
| Known noise | `test/unit/apiStore.timerDispose.spec.ts` fails **only while a local Ollama is running** — environment-specific, not a regression |
| `npm run typecheck` | `tsc -b` + `vue-tsc` clean |
| `npm run smoke:window-controls` | **35/35** — all seven sub-windows: buttons render, `-webkit-app-region: drag` active, minimize really minimizes, close really closes |
| `node scripts/oss-audit.mjs` | Secret / local-path / credential scan over every tracked file; `--fix` redacts machine-specific paths |

Coverage gate: 40% lines/functions/statements, 30% branches — **`src/services` + `src/stores` only**, so the number does not describe the whole codebase.

### Acceptance exam (self-assessment, warts included)

The repo ships an acceptance exam (V1 18 cases, V2 50 cases). The historical score reports have been moved out of the repository — recover them from git history if needed. The most recent V2 run: **deliverable rate 0.28**, zero-intervention rate 0.64, mean 15.0 s per case.

That is a low number and it is printed here on purpose: the exam is deliberately harsher than "does it answer" — it requires a real artifact on disk and checks the artifact, not the reply text. Do not read the routing-layer tables above as an accuracy claim.

## Project structure

```
SKY/
├── electron/                 # Main process (33 modules)
│   ├── main.ts               # Entry: windows, single-instance lock, IPC dispatch
│   ├── ipc-handlers.ts       # IPC routes (file / shell / doc / image / media / MCP / vault)
│   ├── shell-security.ts     # Shell engine (12 allow-listed prefixes, 77 dangerous patterns)
│   ├── pathValidator.ts      # Read/write path validation
│   ├── mcp-manager.ts        # MCP subprocess lifecycle
│   ├── window-manager.ts     # Seven sub-windows, all frameless
│   └── preload.ts            # contextBridge surface (121 keys)
├── src/                      # Renderer (Vue 3)
│   ├── kernel/               # Funnel orchestration, hooks, clusters, bus
│   ├── kernels/              # Kernel plugins (default / lite)
│   ├── host/                 # Hot-plug host (plugins / packs)
│   ├── domains/              # Bus channel registration points
│   ├── packs/                # Built-in domain packs (finance / geotech / legal)
│   ├── services/             # Core logic (72 modules)
│   ├── stores/               # Pinia stores (18)
│   ├── components/           # Vue components (32)
│   ├── exam/                 # Acceptance exam (V1 18 + V2 50 cases)
│   └── data/                 # Static data (manifests, skill/MCP catalogues, legacy topology)
├── test/                     # 210 spec files + 3 standalone e2e scripts
├── config/l2_manifests/      # 20 L2 manifest JSONs
├── scripts/                  # smoke / audit / report generators
└── docs/                     # Authoritative docs (Chinese)
```

## Known limitations

Ordered roughly by how likely they are to bite you:

1. **Packaging is Windows-only** and untested elsewhere.
2. **Skill DAGs do not execute** — installing a skill is a catalogue action today.
3. **16/21 skill→MCP dependencies resolve to nothing, silently** (see above).
4. **Four preload APIs have no UI entry point** (`backupList`, `appHealth`, `knowledgeListEntries`, `mcpGetStatus`) — capabilities without a door.
5. **Custom frameless windows need drag regions and controls per window**; they are hand-maintained, and one window shipped without them until a real-machine check caught it. That check is now `npm run smoke:window-controls`, but it only asserts button behaviour — **window dragging itself is verified by hand, not by automation** (synthesised mouse events do not drive native window movement).
6. **The exam scores are low** (0.28 deliverable rate on the last V2 run).
7. **The legacy `src/data/topology.ts`** (125 nodes) is data left over from a removed 3D star-map UI. It is not a description of the interface; an older README implied otherwise.
8. **Half-live mechanisms** exist (competitive EMA, consumer-context truncation) — implemented but not firing by default. The ledger marks them.

## Documentation

`docs/` is the authoritative set, in Chinese, one volume per topic, with every claim carrying a `file:line` anchor checked against the code.

| Volume | Covers |
|---|---|
| [00-总览与口径](docs/00-总览与口径.md) | What this is, plus the claims that are **no longer true** |
| [10-架构与分层](docs/10-架构与分层.md) | Process model, funnel assembly, hot-plug, domain packs |
| [20-请求生命周期与路由](docs/20-请求生命周期与路由.md) | Request lifecycle, gates, confidence formulas |
| [30-机制台账与边界](docs/30-机制台账与边界.md) | Status of every mechanism, gap list, boundaries |
| [40-安全模型](docs/40-安全模型.md) | Shell engine, path validation, write approval, FactGuard |
| [50-记忆与上下文](docs/50-记忆与上下文.md) | What is remembered, what gets injected per request |
| [60-测试与验收](docs/60-测试与验收.md) | Test boundaries, real-machine smoke, exam system |
| [90-术语表与索引](docs/90-术语表与索引.md) | Glossary and file index |
| [95-技术债与路线图](docs/95-技术债与路线图.md) | Technical debt and roadmap |

**Project rule:** code changes → update the matching volume in the same commit. Historical documents were deleted from the tree; recover them from git history (see [docs/README](docs/README.md)).

## Contributing

Issues and PRs are welcome — see CONTRIBUTING.md for setup, code style (`strict` TypeScript, no `any`, no type assertions), the `.spec.ts` convention, and the PR flow.

## License

[Apache-2.0](LICENSE). Third-party components are listed in NOTICE.

## Disclaimer

Provided **as is**, without warranty of any kind. This preview can read, write, move, and delete files and can execute shell commands on the machine it runs on, with all the obvious risk that carries. Run it against data you can afford to lose.
