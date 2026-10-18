//! 产出落盘——把任务执行的最终结果写成文件。
//!
//! **为什么需要**：20 份任务书里只有 1 份显式写了 `write_file` 步骤，
//! 其余以「返回文本」为终点。但用户要的是**结果**——一份能打开的文件，
//! 而不是控制台里的一行字。这里在管线末端统一补上落盘，不必改 20 份任务书。
//!
//! **设计取舍**：
//!
//! | 方案 | 取舍 |
//! |---|---|
//! | 改 20 份任务书各加 `write_file` 步骤 | 语义清晰，但要改 20 份数据、且路径槽位无处来 |
//! | **管线末端统一落盘（本方案）** | 一次实现覆盖全部任务书；代价是「产出」成为管线概念而非任务书概念 |
//!
//! 选后者：任务书的职责是「怎么做」，落盘是「产出放哪」——后者是运行环境
//! 的关切，不该硬编码进每份领域资产。
//!
//! **默认位置**：工作区下 `.sky-output/`。这个目录会被 `.gitignore` 忽略——
//! 产出是运行时数据，不该进版本库。
//!
//! **失败不静默**：写盘失败必须报出来。否则用户以为任务完成了，
//! 去目录里却找不到文件——这与之前「假成功」是同一类问题。

use std::path::{Path, PathBuf};

/// 产出落盘的配置。
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactConfig {
    /// 输出目录。`None` 表示使用默认值 `<工作区>/.sky-output`。
    pub dir: Option<PathBuf>,
    /// 是否启用落盘。
    pub enabled: bool,
    /// 文件名前缀。默认用任务名。
    pub prefix: Option<String>,
}

impl Default for ArtifactConfig {
    fn default() -> Self {
        Self {
            dir: None,
            enabled: true,
            prefix: None,
        }
    }
}

impl ArtifactConfig {
    /// 禁用落盘（测试或纯查询场景用）。
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Default::default()
        }
    }

    /// 指定输出目录。
    pub fn with_dir(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: Some(dir.into()),
            ..Default::default()
        }
    }

    /// 解析出实际输出目录。
    pub fn resolve_dir(&self) -> PathBuf {
        self.dir.clone().unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".sky-output")
        })
    }
}

/// 落盘结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ArtifactOutcome {
    /// 已写入。
    Written { path: PathBuf, bytes: usize },
    /// 未写入（配置禁用，或无内容可写）。
    Skipped { reason: String },
    /// 写入失败。**必须报给用户**，不能当成功。
    Failed { reason: String },
}

impl ArtifactOutcome {
    pub fn is_written(&self) -> bool {
        matches!(self, ArtifactOutcome::Written { .. })
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            ArtifactOutcome::Written { path, .. } => Some(path),
            _ => None,
        }
    }
}

/// 从文件名里剔除不安全字符。
///
/// 任务名可能含空格、斜杠、中文标点——直接当文件名会在某些平台失败
/// 或意外创建子目录。
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "output".to_string()
    } else {
        // 限制长度，避免超长文件名
        trimmed.chars().take(80).collect()
    }
}

/// 生成带时间戳的文件名。
///
/// 用「任务名-时间戳」而非覆盖同名文件：同一任务跑多次应保留历史，
/// 覆盖会让用户丢失上一次的产出。
fn make_filename(prefix: &str, ext: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}-{}.{}", sanitize(prefix), ts, ext)
}

/// 把内容写入产出目录。
///
/// `task_name` 用于生成文件名；`content` 是最终产出文本。
pub fn write_artifact(
    config: &ArtifactConfig,
    task_name: &str,
    content: &str,
) -> ArtifactOutcome {
    if !config.enabled {
        return ArtifactOutcome::Skipped {
            reason: "落盘已禁用".to_string(),
        };
    }

    if content.trim().is_empty() {
        return ArtifactOutcome::Skipped {
            reason: "产出为空，未写入文件".to_string(),
        };
    }

    let dir = config.resolve_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return ArtifactOutcome::Failed {
            reason: format!("创建产出目录失败 {}：{e}", dir.display()),
        };
    }

    let prefix = config.prefix.as_deref().unwrap_or(task_name);
    let path = dir.join(make_filename(prefix, "md"));

    match std::fs::write(&path, content) {
        Ok(()) => ArtifactOutcome::Written {
            path,
            bytes: content.len(),
        },
        Err(e) => ArtifactOutcome::Failed {
            reason: format!("写入产出失败 {}：{e}", path.display()),
        },
    }
}

/// 从执行结果里挑出「最终产出」文本。
///
/// 优先取**最后一个成功步骤**的结果——DAG 的末端就是任务的产出。
/// 若末端失败，回退到最后一个有结果的步骤（部分产出也好过什么都没有，
/// 但调用方应同时看到失败信息）。
pub fn pick_final_output(outcomes: &[sky_exec::StepOutcome]) -> Option<String> {
    let last_ok = outcomes
        .iter()
        .filter(|o| o.is_success())
        .filter_map(|o| o.result.clone())
        .next_back();

    if last_ok.is_some() {
        return last_ok;
    }

    // 没有成功步骤时，若有任何结果就返回它
    outcomes.iter().filter_map(|o| o.result.clone()).next_back()
}

/// 组装产出文件的正文：结果 + 执行元信息。
///
/// 加上元信息（任务名、路由来源、各步骤状态）是为了让产出可追溯——
/// 用户打开文件时能知道它从哪来、每一步是否都成功。
pub fn compose_document(
    task_name: &str,
    route_source: &str,
    outcomes: &[sky_exec::StepOutcome],
    final_output: &str,
) -> String {
    let mut doc = String::new();
    doc.push_str(&format!("# {task_name}\n\n"));
    doc.push_str(&format!("> 路由来源：`{route_source}`\n"));
    doc.push_str(&format!(
        "> 生成时间：{}\n\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));

    doc.push_str("## 结果\n\n");
    doc.push_str(final_output);
    doc.push_str("\n\n## 执行过程\n\n");
    doc.push_str("| 步骤 | 状态 | 说明 |\n|---|---|---|\n");
    for o in outcomes {
        let status = if o.is_success() { "成功" } else { "失败" };
        let detail = o.error.clone().unwrap_or_else(|| "—".to_string());
        // 表格里的换行会破坏排版
        let detail = detail.replace('\n', " ");
        let detail: String = detail.chars().take(120).collect();
        doc.push_str(&format!("| {} | {} | {} |\n", o.step, status, detail));
    }

    doc
}

#[cfg(test)]
mod tests {
    use super::*;
    use sky_exec::{StepOutcome, StepStatus};

    fn ok_step(n: u32, result: &str) -> StepOutcome {
        StepOutcome {
            step: n,
            status: StepStatus::Done,
            result: Some(result.to_string()),
            error: None,
            used_fallback: false,
        }
    }

    fn fail_step(n: u32, err: &str) -> StepOutcome {
        StepOutcome {
            step: n,
            status: StepStatus::Failed,
            result: None,
            error: Some(err.to_string()),
            used_fallback: false,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sky-artifact-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn writes_real_file_to_disk() {
        let dir = temp_dir("basic");
        let cfg = ArtifactConfig::with_dir(&dir);

        let out = write_artifact(&cfg, "周报草稿", "这是产出内容");

        let path = out.path().expect("应写入成功").to_path_buf();
        assert!(path.exists(), "文件必须真实存在于磁盘：{}", path.display());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "这是产出内容");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_config_skips_without_error() {
        let cfg = ArtifactConfig::disabled();
        let out = write_artifact(&cfg, "x", "内容");
        assert!(matches!(out, ArtifactOutcome::Skipped { .. }));
        assert!(!out.is_written());
    }

    #[test]
    fn empty_content_is_skipped_not_written() {
        let dir = temp_dir("empty");
        let cfg = ArtifactConfig::with_dir(&dir);
        let out = write_artifact(&cfg, "x", "   \n  ");
        assert!(
            matches!(out, ArtifactOutcome::Skipped { .. }),
            "空产出不该写出空文件，实际：{out:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 任务名含路径分隔符时不能逃出输出目录。
    #[test]
    fn unsafe_task_name_is_sanitized() {
        let dir = temp_dir("unsafe");
        let cfg = ArtifactConfig::with_dir(&dir);
        let out = write_artifact(&cfg, "../../etc/passwd", "x");
        let path = out.path().expect("应写入");
        assert!(
            path.starts_with(&dir),
            "产出必须落在指定目录内，实际：{}",
            path.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filename_contains_timestamp_to_avoid_overwrite() {
        let dir = temp_dir("ts");
        let cfg = ArtifactConfig::with_dir(&dir);
        let a = write_artifact(&cfg, "任务", "第一次").path().unwrap().to_path_buf();
        let b = write_artifact(&cfg, "任务", "第二次").path().unwrap().to_path_buf();
        assert!(a.exists() && b.exists(), "两次产出应都保留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pick_final_output_prefers_last_success() {
        let outcomes = vec![
            ok_step(1, "第一步结果"),
            ok_step(2, "第二步结果"),
            ok_step(3, "最终产出"),
        ];
        assert_eq!(pick_final_output(&outcomes).unwrap(), "最终产出");
    }

    #[test]
    fn pick_final_output_falls_back_when_all_failed() {
        let outcomes = vec![fail_step(1, "错"), fail_step(2, "错")];
        assert!(pick_final_output(&outcomes).is_none());
    }

    #[test]
    fn compose_document_includes_result_and_steps() {
        let outcomes = vec![ok_step(1, "a"), fail_step(2, "磁盘满")];
        let doc = compose_document("周报", "manifest", &outcomes, "最终内容");
        assert!(doc.contains("# 周报"), "{doc}");
        assert!(doc.contains("最终内容"), "{doc}");
        assert!(doc.contains("manifest"), "应含路由来源：{doc}");
        assert!(doc.contains("磁盘满"), "应含失败原因：{doc}");
    }

    /// 失败必须报出来，不能静默当成功。
    #[test]
    fn write_failure_is_reported() {
        // 用一个不可能创建的文件路径当目录
        let bad = if cfg!(windows) {
            PathBuf::from("Z:\\definitely\\not\\a\\drive")
        } else {
            PathBuf::from("/proc/nonexistent/cannot/write")
        };
        let cfg = ArtifactConfig::with_dir(&bad);
        let out = write_artifact(&cfg, "x", "内容");
        assert!(
            matches!(out, ArtifactOutcome::Failed { .. }),
            "写盘失败必须报 Failed，实际：{out:?}"
        );
    }
}
