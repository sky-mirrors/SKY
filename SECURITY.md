# Security Policy

## Known Vulnerabilities (npm audit)

The following vulnerabilities are present in **upstream transitive dependencies**. They do not originate from HoloStarmap source code and cannot be fixed without upstream updates or major dependency changes.

| Package | Severity | CVE/Issue | Source | Status |
|---------|----------|-----------|--------|--------|
| protobufjs ≤ 7.2.6 | Critical | RCE, prototype pollution | `@xenova/transformers` → `onnxruntime-web` | Awaits upstream update |
| xlsx 0.18.5 | High | Prototype pollution, ReDoS | Direct dependency | SheetJS CE unmaintained; planned migration to exceljs |
| sharp | High | libvips inherited CVEs | `@xenova/transformers` → `sharp` | Awaits upstream update |
| electron 33.4.0 | High | 32 ASAR/IPC/use-after-free CVEs | `@electron-toolkit/utils` pins 33.x | Planned upgrade to Electron 44.x |
| extract-zip | High | Symlink path traversal | electron indirect dependency | Resolves with Electron upgrade |

## Risk Assessment

HoloStarmap is a **local desktop application** — it does not expose network services or accept untrusted remote input. This significantly reduces the practical exploitability of the above vulnerabilities:

- **protobufjs / sharp**: Only process locally-generated data via `@xenova/transformers` (embedding inference). No remote protobuf input.
- **xlsx**: Prototype pollution requires a maliciously-crafted file. Users load their own local files.
- **Electron CVEs**: The application uses `asar: false` packaging (most ASAR integrity CVEs do not apply). Users install and run the application locally.
- **extract-zip**: Path traversal requires a malicious ZIP archive during installation.

**Practical risk: Low.**

## Remediation Plan

| Action | Timeline | Effort |
|--------|----------|--------|
| Replace xlsx with exceljs | Phase 2 | ~2 hours |
| Upgrade Electron to 44.x + @electron-toolkit 5.x | Phase 2 | ~4-8 hours |
| Monitor @xenova/transformers updates for protobufjs/sharp fixes | Ongoing | — |

## Reporting

To report a security vulnerability, please open a [GitHub Issue](https://github.com/sky-mirrors/HoloStarmap/issues) with the label `security`.
