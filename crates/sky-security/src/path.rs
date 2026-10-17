//! 路径校验。
//!
//! 对应现状 `electron/pathValidator.ts`（269 行）。
//!
//! **必须保留的历史修复**：
//! - **V2-S04**：输入路径中任何 `..` 段一律拒绝。仅校验 `resolve()` 归一化后的落点
//!   会漏判 `out\..\..\Windows\evil.md` 这类「归一化后仍在允许目录内」的穿越
//!   （`pathValidator.ts:159-165`）
//! - **A-20**：读路径与写路径对称——NTFS ADS 冒号与尾随点/空格同样拒绝，
//!   否则可读 `file.txt:stream` 绕过扩展名管控（`pathValidator.ts:195-204`）
//! - **P0-6**：写路径额外拒绝可执行/脚本扩展名（`pathValidator.ts:207-224`）
//! - **E-2**：`openPath` 从黑名单升级为「黑名单优先 + 白名单兜底」fail-closed
//!   （`pathValidator.ts:226-233`）

use std::path::{Path, PathBuf};

/// 路径校验结果。
#[derive(Debug, Clone, PartialEq)]
pub struct PathCheck {
    pub safe: bool,
    pub resolved: PathBuf,
    pub reason: Option<String>,
}

impl PathCheck {
    pub fn ok(resolved: PathBuf) -> Self {
        Self {
            safe: true,
            resolved,
            reason: None,
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            safe: false,
            resolved: PathBuf::new(),
            reason: Some(reason.into()),
        }
    }
}

/// 危险扩展名（写入禁止）。对应 `pathValidator.ts` 的 `DANGEROUS_EXTENSIONS`。
pub const DANGEROUS_EXTENSIONS: &[&str] = &[
    ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".pif", ".msi", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".wsh", ".ps1", ".psm1", ".psd1", ".jar", ".lnk", ".url", ".reg", ".hta", ".cpl",
    ".sys", ".drv",
];

/// 可安全打开的扩展名白名单（E-2 fail-closed 兜底）。
pub const SAFE_OPEN_EXTENSIONS: &[&str] = &[
    ".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml", ".toml", ".ini", ".pdf",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".mp4", ".mp3", ".wav", ".html",
    ".css",
];

/// 敏感目录模式（读）。对应 `pathValidator.ts` 的 `FORBIDDEN_READ_PATHS`。
pub const FORBIDDEN_READ_PATTERNS: &[&str] = &[
    r"\\windows\\system32",
    r"\\windows\\syswow64",
    r"\.ssh\\",
    r"\.aws\\",
    r"\.gnupg\\",
    r"\\appdata\\roaming\\microsoft\\crypto",
    r"\\appdata\\local\\microsoft\\credentials",
];

/// 敏感目录模式（写）。对应 `FORBIDDEN_WRITE_PATHS`。
pub const FORBIDDEN_WRITE_PATTERNS: &[&str] = &[
    r"\\windows\\",
    r"\\program files",
    r"\\programdata\\",
    r"\.ssh\\",
    r"\.aws\\",
];

/// V2-S04：输入路径中任何 `..` 段一律拒绝。
///
/// 注意：只看**输入串**，不看归一化结果——`resolve()` 会把 `..` 折叠掉，
/// 落点看似合法，实则已穿越。
pub fn has_traversal_segment(input: &str) -> bool {
    input
        .split(['\\', '/'])
        .any(|seg| seg == "..")
}

/// A-20：文件名以点/空格结尾（Windows 剥离语义）或含 NTFS ADS 冒号。
pub fn has_suspicious_basename(path: &str) -> bool {
    let base = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path);
    base.ends_with('.') || base.ends_with(' ') || base.contains(':')
}

/// 扩展名（小写，含点）。无扩展名返回 None。
pub fn get_safe_extension(path: &str) -> Option<String> {
    let base = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path);
    // ADS 冒号后的部分不算扩展名
    if base.contains(':') {
        return None;
    }
    let dot = base.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(base[dot..].to_lowercase())
}

fn normalize_separators(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// 基础路径校验。
///
/// 对应 `pathValidator.ts:167` `validatePath`。
///
/// **注意**：`allowed_dirs` 为空时视为无允许目录 → 一律拒绝（fail-closed）。
pub fn validate_path(input: &str, allowed_dirs: &[PathBuf]) -> PathCheck {
    if input.is_empty() {
        return PathCheck::deny("路径为空");
    }

    // V2-S04：先看输入串有无穿越段
    if has_traversal_segment(input) {
        return PathCheck::deny(format!("路径包含 '..' 穿越段，被安全策略拒绝: {input}"));
    }

    let resolved = resolve_lexical(input);

    // fail-closed：无允许目录即拒绝
    if allowed_dirs.is_empty() {
        return PathCheck::deny(format!("路径不在允许目录内: {}", resolved.display()));
    }

    let is_allowed = allowed_dirs.iter().any(|dir| {
        let d = dir.to_string_lossy().to_lowercase();
        let r = resolved.to_string_lossy().to_lowercase();
        r == d || r.starts_with(&format!("{d}\\")) || r.starts_with(&format!("{d}/"))
    });

    if !is_allowed {
        return PathCheck::deny(format!("路径不在允许目录内: {}", resolved.display()));
    }

    let normalized = normalize_separators(&resolved.to_string_lossy());
    for pattern in FORBIDDEN_READ_PATTERNS {
        if normalized.contains(pattern) {
            return PathCheck::deny(format!("路径包含敏感目录: {}", resolved.display()));
        }
    }

    PathCheck::ok(resolved)
}

/// 读路径校验。对应 `pathValidator.ts:195`。
pub fn validate_read_path(input: &str, allowed_dirs: &[PathBuf]) -> PathCheck {
    let r = validate_path(input, allowed_dirs);
    if !r.safe {
        return r;
    }
    // A-20：读路径与写路径对称
    if has_suspicious_basename(&r.resolved.to_string_lossy()) {
        return PathCheck {
            safe: false,
            resolved: r.resolved.clone(),
            reason: Some("文件名以点/空格结尾或包含冒号，被安全策略拒绝".into()),
        };
    }
    r
}

/// 写路径校验。对应 `pathValidator.ts:207`。P0-6。
pub fn validate_write_path(input: &str, allowed_dirs: &[PathBuf]) -> PathCheck {
    let r = validate_path(input, allowed_dirs);
    if !r.safe {
        return r;
    }

    let s = r.resolved.to_string_lossy().to_string();
    let normalized = normalize_separators(&s);
    for pattern in FORBIDDEN_WRITE_PATTERNS {
        if normalized.contains(pattern) {
            return PathCheck {
                safe: false,
                resolved: r.resolved.clone(),
                reason: Some(format!("敏感写入目标，被安全策略拒绝: {s}")),
            };
        }
    }

    if has_suspicious_basename(&s) {
        return PathCheck {
            safe: false,
            resolved: r.resolved.clone(),
            reason: Some("文件名以点/空格结尾或包含冒号，被安全策略拒绝".into()),
        };
    }

    if let Some(ext) = get_safe_extension(&s) {
        if DANGEROUS_EXTENSIONS.contains(&ext.as_str()) {
            return PathCheck {
                safe: false,
                resolved: r.resolved.clone(),
                reason: Some(format!("禁止写入可执行/脚本文件: {ext}")),
            };
        }
    }

    r
}

/// 打开路径校验。对应 `pathValidator.ts:233`。E-2：黑名单优先 + 白名单兜底。
///
/// fail-closed：未知扩展名或无扩展名一律拒绝。
pub fn validate_open_path(input: &str, allowed_dirs: &[PathBuf]) -> PathCheck {
    let r = validate_read_path(input, allowed_dirs);
    if !r.safe {
        return r;
    }

    let s = r.resolved.to_string_lossy().to_string();

    // ① 黑名单
    if let Some(ext) = get_safe_extension(&s) {
        if DANGEROUS_EXTENSIONS.contains(&ext.as_str()) {
            return PathCheck {
                safe: false,
                resolved: r.resolved.clone(),
                reason: Some(format!("禁止打开可执行/脚本/快捷方式: {ext}")),
            };
        }
        // ② 白名单兜底
        if !SAFE_OPEN_EXTENSIONS.contains(&ext.as_str()) {
            return PathCheck {
                safe: false,
                resolved: r.resolved.clone(),
                reason: Some(format!("扩展名不在允许打开的白名单内: {ext}")),
            };
        }
    } else {
        // 无扩展名一并拒绝
        return PathCheck {
            safe: false,
            resolved: r.resolved.clone(),
            reason: Some("无扩展名，不在允许打开的白名单内".into()),
        };
    }

    r
}

/// 词法归一化（折叠 `.`，不解析符号链接）。
///
/// 与 Node `path.resolve` 的差异：本实现不访问文件系统，
/// 因此不会因文件不存在而失败。安全语义等价——`..` 已在入口拒绝。
fn resolve_lexical(input: &str) -> PathBuf {
    let normalized = input.replace('/', "\\");
    let mut out: Vec<String> = Vec::new();

    // 盘符前缀
    let mut prefix = String::new();
    let mut rest = normalized.as_str();
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        prefix = normalized[..2].to_string();
        rest = &normalized[2..];
    } else if normalized.starts_with('\\') {
        prefix = "\\".to_string();
    }

    for seg in rest.split('\\') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        out.push(seg.to_string());
    }

    let joined = out.join("\\");
    if prefix.is_empty() {
        PathBuf::from(joined)
    } else if prefix == "\\" {
        PathBuf::from(format!("\\{joined}"))
    } else {
        PathBuf::from(format!("{prefix}\\{joined}"))
    }
}

/// 路径是否在给定目录内（含相等）。
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let p = path.to_string_lossy().to_lowercase();
    let d = dir.to_string_lossy().to_lowercase();
    p == d || p.starts_with(&format!("{d}\\")) || p.starts_with(&format!("{d}/"))
}
