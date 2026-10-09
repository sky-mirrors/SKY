# Security Policy

## Known Vulnerabilities

Measured with `npm audit` on **2026-10-09** (SKY `0.1.0`).

| Scope | Count | Breakdown |
|---|---|---|
| **Production dependencies** (shipped inside the packaged app) | **19** | 1 critical · 11 high · 6 moderate · 1 low |
| Dev-only dependencies (never shipped) | 10 | 2 critical (`vitest` / `tinypool`) · 2 high · 6 moderate |

> The `npm audit` headline number (29) counts dev-only advisories too. **Only the 19 production ones affect what a user downloads** — the dev-only ones are build-time tooling and never enter the packaged EXE.

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
