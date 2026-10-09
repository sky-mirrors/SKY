# Security Policy

## Known Vulnerabilities

Measured with `npm audit` on **2026-10-09** (SKY `0.1.0`).

| Scope | Count | Breakdown |
|---|---|---|
| **Production dependencies** (shipped inside the packaged app) | **19** | 1 critical · 11 high · 6 moderate · 1 low |
| Dev-only dependencies (never shipped) | 10 | 2 critical (`vitest` / `tinypool`) · 2 high · 6 moderate |

> The `npm audit` headline number (29) counts dev-only advisories too. **Only the 19 production ones affect what a user downloads** — the dev-only ones are build-time tooling and never enter the packaged EXE.

### Production-dependency advisories

All of these are **upstream** issues: they live in third-party packages, not in SKY source code. Fixing them requires upstream releases or major dependency changes.

| Package | Severity | Kind | Pulled in by | Status |
|---|---|---|---|---|
| `protobufjs` ≤ 7.2.6 | **Critical** | transitive | `@xenova/transformers` → `onnxruntime-web` | Awaits upstream |
| `electron` 33.4.0 | High | **direct** | — | CVE set applies to the 33.x line; **planned upgrade to 44.x** |
| `extract-zip` ^2.0.1 | High | **direct** | — | Symlink path traversal; needs its own assessment (see note 2 below) |
| `sharp` | High | **direct** | — | libvips inherited CVEs; awaits upstream |
| `@xenova/transformers` | High | **direct** | — | Awaits upstream |
| `vue` | High | **direct** | — | Awaits upstream patch release |
| `@vue/server-renderer` | High | transitive | `vue` | Awaits upstream; **the SSR path is not used by this desktop app** |
| `onnxruntime-web` / `onnx-proto` | High | transitive | `@xenova/transformers` | Awaits upstream |
| `brace-expansion`, `http-cache-semantics`, `source-map-js` | High | transitive | transitive chains | Awaits upstream |
| `@electron/get`, `argparse`, `global-agent`, `roarr`, `sprintf-js` | Moderate | transitive | `electron` / packaging chain | Awaits upstream |
| `mammoth` | Moderate | **direct** | — | Awaits upstream |
| `dompurify` | Low | **direct** | — | Awaits upstream patch |

### Two entries previously mis-stated — corrected

1. **`xlsx`** — earlier revisions listed `xlsx 0.18.5` and an "exceljs migration" plan. `package.json` actually pins **`0.20.3`** (SheetJS CDN tarball), so the older advisories (CVE-2023-30533 prototype pollution / CVE-2024-22363 ReDoS) as written **do not apply**. Severity and any migration plan must be re-judged against 0.20.3.
2. **`extract-zip`** — earlier revisions described it as an *electron indirect* dependency that "resolves with the Electron upgrade". It is a **direct dependency** (`package.json` → `dependencies`), so that inference does not hold; it needs its own assessment.

## Risk Assessment

SKY is a **local desktop application** — it does not expose network services or accept untrusted remote input. This significantly reduces the practical exploitability of the above vulnerabilities:

- **protobufjs / sharp / @xenova/transformers**: Only process locally-generated data via `@xenova/transformers` (embedding inference). No remote protobuf or image input.
- **xlsx**: Prototype pollution requires a maliciously-crafted file. Users load their own local files.
- **Electron CVEs**: The application uses `asar: false` packaging (most ASAR integrity CVEs do not apply). Users install and run the application locally.
- **extract-zip**: Path traversal requires a malicious ZIP archive processed by the app.
- **vue / @vue/server-renderer**: The SSR advisory path is not used — this is an Electron renderer app.

**Practical risk: Low** — but this is a judgement about *exploitability*, not a claim that the dependency tree is clean. Do not describe the dependencies as "no known vulnerabilities".

## Remediation Plan

| Action | Priority | Effort |
|--------|----------|--------|
| Upgrade Electron 33.x → 44.x (+ `@electron-toolkit` 5.x) | High — clears several High advisories | ~4–8 h + full regression pass |
| Assess / replace `extract-zip` | High — direct dependency, unpatched | ~2 h |
| Re-judge `xlsx` at 0.20.3 (decide whether migration is still warranted) | Medium | ~1 h investigation |
| Track upstream for `protobufjs` / `sharp` / `@xenova` fixes | Ongoing | — |
| Regenerate this table with `npm audit --omit=dev` before each release | Ongoing | minutes |

## Reporting

To report a security vulnerability, please open a [GitHub Issue](https://github.com/sky-mirrors/SKY/issues) with the label `security`.
