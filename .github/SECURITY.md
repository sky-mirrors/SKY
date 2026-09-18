# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub Issues.**

Instead, please:

1. Use GitHub's private vulnerability reporting feature: go to the **Security** tab of this repository and click **Report a vulnerability**
2. Or contact the maintainer directly via email

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- Acknowledgment within 48 hours
- Initial assessment within 7 days
- Fix timeline communicated after assessment

## Scope

The following are in scope for security reports:

- Shell command injection bypasses
- File system access violations
- API key exposure
- IPC message validation bypasses
- MCP sandbox escapes

The following are out of scope:

- Issues in dependencies (report to the respective package)
- Social engineering attacks
- Denial of service via excessive LLM requests

## Known Security Mechanisms

HoloStarmap implements multiple security layers:

- **Shell Security Engine**: 77 dangerous pattern blacklist + 6 trusted signature whitelist
- **Dual Engine Validator**: Rule-based + LLM-based validation for write operations
- **Safe Storage**: Electron safeStorage API for API key encryption
- **Write Path Whitelist**: Only Desktop/Documents directories allowed for file writes
- **HTTP Safety**: Method whitelist + 1MB body size limit + timeout tiers
