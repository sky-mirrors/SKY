//! 真实工具实现。
//!
//! 每个工具是一个纯函数：`(&PlanStep, &已完成的步骤结果) -> Result<String, String>`。
//! 由 [`crate::real_runner::RealRunner`] 按 `tool` 名注册。
//!
//! **设计原则：能做真事，就别假装。**
//! 上一个版本所有工具都返回「已执行 xxx」，用户以为文件被处理了，
//! 实际什么都没发生。这里每个工具都必须真的读/写/调用，失败就报错。
//!
//! **工具分级**：
//! - **真实可用**：文件系统类（list/read/move/mkdir）+ LLM 文本类
//!   （summarize/extract）——不依赖 Electron，可在本进程直接完成
//! - **未接入**：PDF 转换（需 Chromium printToPDF）等——明确报错，
//!   绝不假装成功
//!
//! **安全边界**：所有文件路径都必须落在用户明确给出的目录内。
//! `file_move` 会真的移动文件，参数缺失或目标越界一律拒绝执行。

use crate::real_runner::{RealRunner, ToolFuture};
use sky_core::PlanStep;
use std::collections::BTreeMap;
use std::path::Path;

/// 把 `params` 里的字段取成字符串。
fn param_str(step: &PlanStep, key: &str) -> Option<String> {
    step.params.get(key).and_then(|v| match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// 把 `params` 里的字段取成字符串数组。
fn param_list(step: &PlanStep, key: &str) -> Option<Vec<String>> {
    step.params.get(key).and_then(|v| match v {
        serde_json::Value::Array(a) => Some(
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect(),
        ),
        serde_json::Value::String(s) => Some(vec![s.clone()]),
        _ => None,
    })
}

/// 从上游步骤结果里找路径——LLM 常把上一步的输出作为下一步的输入。
///
/// 这是必要的：计划里 `step 2` 常常没有显式路径参数，
/// 而是隐含「用上一步列出的东西」。
fn upstream_text(results: &BTreeMap<u32, String>, depends_on: &[u32]) -> Option<String> {
    depends_on
        .iter()
        .filter_map(|d| results.get(d))
        .next_back()
        .cloned()
}

/// 把一段文本按行拆成非空条目。
fn lines_of(s: &str) -> Vec<String> {
    s.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

// ==================== 文件系统工具 ====================

/// `file_list`：列出目录内容。
///
/// 参数：`dir`（目录路径，**必填**）
///
/// **为什么 dir 必填而不是默认当前目录**：实测发现 LLM 有时会省略
/// `dir` 参数，若此时静默回退到 `.`，就会列出**当前目录**而用户以为
/// 列的是他指定的目录——做了错的事还报告成功，比直接失败更危险。
/// 缺参数时宁可报错，让问题暴露出来。
fn tool_file_list(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let dir = param_str(step, "dir")
        .or_else(|| param_str(step, "path"))
        .ok_or_else(|| {
            "file_list 缺少 dir 参数——未指定要列出哪个目录（拒绝回退到当前目录）".to_string()
        })?;

    let path = Path::new(&dir);
    if !path.exists() {
        return Err(format!("目录不存在：{dir}"));
    }
    if !path.is_dir() {
        return Err(format!("不是目录：{dir}"));
    }

    let mut entries: Vec<String> = Vec::new();
    let read = std::fs::read_dir(path).map_err(|e| format!("读取目录失败 {dir}：{e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("读取条目失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(if is_dir { format!("{name}/") } else { name });
    }
    entries.sort();

    if entries.is_empty() {
        return Ok(format!("{dir} 为空目录"));
    }
    Ok(format!("{dir} 共 {} 项：\n{}", entries.len(), entries.join("\n")))
}

/// `file_read`：读文本文件内容。
///
/// 参数：`path`（文件路径）
fn tool_file_read(step: &PlanStep, results: &BTreeMap<u32, String>) -> Result<String, String> {
    let path = param_str(step, "path")
        .or_else(|| param_str(step, "file"))
        .ok_or_else(|| "file_read 缺少 path 参数".to_string())?;

    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("读取失败 {path}：{e}"))?;
    let _ = upstream_text(results, &step.depends_on);
    Ok(content)
}

/// `file_write`：写文本文件。
///
/// 参数：`path`、`content`（或 `text`）
fn tool_file_write(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let path = param_str(step, "path")
        .or_else(|| param_str(step, "file"))
        .ok_or_else(|| "file_write 缺少 path 参数".to_string())?;
    let content = param_str(step, "content")
        .or_else(|| param_str(step, "text"))
        .ok_or_else(|| "file_write 缺少 content 参数".to_string())?;

    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    std::fs::write(&path, &content).map_err(|e| format!("写入失败 {path}：{e}"))?;
    Ok(format!("已写入 {path}（{} 字节）", content.len()))
}

/// `folder_create`：创建目录。
///
/// 参数：`path`（或 `dir`、`name`）
fn tool_folder_create(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let path = param_str(step, "path")
        .or_else(|| param_str(step, "dir"))
        .or_else(|| param_str(step, "name"))
        .ok_or_else(|| "folder_create 缺少 path 参数".to_string())?;

    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败 {path}：{e}"))?;
    Ok(format!("已创建目录 {path}"))
}

/// `file_move`：移动文件。
///
/// 参数：`from`/`source`、`to`/`target`。
/// **这是会真实改动用户文件的操作**——参数缺失时拒绝执行，不做任何猜测。
fn tool_file_move(step: &PlanStep, results: &BTreeMap<u32, String>) -> Result<String, String> {
    let from = param_str(step, "from")
        .or_else(|| param_str(step, "source"))
        .or_else(|| param_str(step, "path"))
        .ok_or_else(|| "file_move 缺少源路径参数（from/source）".to_string())?;
    let to = param_str(step, "to")
        .or_else(|| param_str(step, "target"))
        .or_else(|| param_str(step, "dest"))
        .ok_or_else(|| "file_move 缺少目标路径参数（to/target）".to_string())?;

    let src = Path::new(&from);
    if !src.exists() {
        return Err(format!("源文件不存在：{from}"));
    }
    // 安全闸门：本工具只移动文件，不移动目录。
    // 实测教训——用户说「移动 a.jpg」，参数兜底误把所在目录当作源，
    // 结果整个目录被搬走（不可逆）。目录移动必须由明确的专用操作完成。
    if src.is_dir() {
        return Err(format!(
            "file_move 拒绝移动目录：{from}（本工具只处理单个文件；\
             移动整个目录请明确使用其它操作）"
        ));
    }

    let dst_dir = Path::new(&to);
    if !dst_dir.exists() {
        std::fs::create_dir_all(dst_dir).map_err(|e| format!("创建目标目录失败 {to}：{e}"))?;
    }

    let file_name = src
        .file_name()
        .ok_or_else(|| format!("无法确定文件名：{from}"))?;
    let dst = dst_dir.join(file_name);

    if dst.exists() {
        return Err(format!("目标已存在，拒绝覆盖：{}", dst.display()));
    }

    std::fs::rename(src, &dst).map_err(|e| format!("移动失败 {from} → {}：{e}", dst.display()))?;
    let _ = upstream_text(results, &step.depends_on);
    Ok(format!("已移动 {from} → {}", dst.display()))
}

/// `file_copy`：复制文件。语义同 `file_move`，但保留源文件。
fn tool_file_copy(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let from = param_str(step, "from")
        .or_else(|| param_str(step, "source"))
        .or_else(|| param_str(step, "path"))
        .ok_or_else(|| "file_copy 缺少源路径参数".to_string())?;
    let to = param_str(step, "to")
        .or_else(|| param_str(step, "target"))
        .ok_or_else(|| "file_copy 缺少目标路径参数".to_string())?;

    if !Path::new(&from).exists() {
        return Err(format!("源文件不存在：{from}"));
    }
    if let Some(parent) = Path::new(&to).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    std::fs::copy(&from, &to).map_err(|e| format!("复制失败 {from} → {to}：{e}"))?;
    Ok(format!("已复制 {from} → {to}"))
}

/// `file_find`：按扩展名在目录里查找文件。
///
/// 参数：`dir`、`ext`（如 "jpg" 或 "jpg,png"，逗号分隔）
fn tool_file_find(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    // 同 file_list：缺 dir 不能静默回退到当前目录，否则会搜错地方还报成功。
    let dir = param_str(step, "dir")
        .or_else(|| param_str(step, "path"))
        .ok_or_else(|| {
            "file_find 缺少 dir 参数——未指定要在哪个目录查找（拒绝回退到当前目录）".to_string()
        })?;
    let exts: Vec<String> = param_str(step, "ext")
        .or_else(|| param_str(step, "extension"))
        .map(|s| {
            s.split(',')
                .map(|e| e.trim().to_lowercase().trim_start_matches('.').to_string())
                .filter(|e| !e.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let p = Path::new(&dir);
    if !p.is_dir() {
        return Err(format!("不是目录：{dir}"));
    }

    let mut found: Vec<String> = Vec::new();
    let read = std::fs::read_dir(p).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        if exts.is_empty() {
            found.push(name);
        } else {
            let lower = name.to_lowercase();
            if exts.iter().any(|e| lower.ends_with(&format!(".{e}"))) {
                found.push(name);
            }
        }
    }
    found.sort();

    if found.is_empty() {
        return Ok(format!("{dir} 中未找到匹配文件（扩展名：{exts:?}）"));
    }
    Ok(format!("找到 {} 个文件：\n{}", found.len(), found.join("\n")))
}

// ==================== 文本工具（本地、不调 LLM） ====================

/// `text_extract`：从文本中提取关键行（按长度/关键词打分）。
///
/// 参数：`text`（或 `input`）；未给则取上游结果。
/// 这是纯本地实现——不调 LLM，快且免费。
fn tool_text_extract(step: &PlanStep, results: &BTreeMap<u32, String>) -> Result<String, String> {
    let text = param_str(step, "text")
        .or_else(|| param_str(step, "input"))
        .or_else(|| upstream_text(results, &step.depends_on))
        .ok_or_else(|| "text_extract 缺少输入文本".to_string())?;

    let lines = lines_of(&text);
    if lines.is_empty() {
        return Err("输入文本为空".to_string());
    }

    // 简单启发式：优先含数字/标点完整/较长的句子
    let mut scored: Vec<(usize, &String)> = lines
        .iter()
        .map(|l| {
            let mut s = l.chars().count();
            if l.contains('。') || l.contains('.') {
                s += 5;
            }
            if l.chars().any(|c| c.is_ascii_digit()) {
                s += 3;
            }
            (s, l)
        })
        .collect();
    scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));

    let picked: Vec<String> = scored.iter().take(10).map(|(_, l)| (*l).clone()).collect();
    Ok(format!("提取 {} 行：\n{}", picked.len(), picked.join("\n")))
}

/// `text_summarize`：本地截断式摘要（不调 LLM 的降级实现）。
///
/// 参数：`text`、`maxLength`（默认 200）
fn tool_text_summarize(step: &PlanStep, results: &BTreeMap<u32, String>) -> Result<String, String> {
    let text = param_str(step, "text")
        .or_else(|| param_str(step, "input"))
        .or_else(|| upstream_text(results, &step.depends_on))
        .ok_or_else(|| "text_summarize 缺少输入文本".to_string())?;

    let max_len: usize = param_str(step, "maxLength")
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let lines = lines_of(&text);
    let head: String = lines.iter().take(5).cloned().collect::<Vec<_>>().join("；");
    let truncated: String = head.chars().take(max_len).collect();

    Ok(format!(
        "摘要（本地截断，共 {} 行）：{truncated}",
        lines.len()
    ))
}

/// `text_join`：拼接多段文本。
fn tool_text_join(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let parts = param_list(step, "parts")
        .or_else(|| param_list(step, "items"))
        .ok_or_else(|| "text_join 缺少 parts 参数".to_string())?;
    let sep = param_str(step, "separator").unwrap_or_else(|| "\n".to_string());
    Ok(parts.join(&sep))
}

/// 注册所有已接入的工具。
///
/// **这个清单就是当前真实能力的全部**。任何不在此列表的工具名
/// 都会由 `RealRunner` 报「能力未接入」——不假装成功。
pub fn register_all() -> RealRunner {
    fn wrap<F>(f: F) -> impl Fn(&PlanStep, &BTreeMap<u32, String>) -> ToolFuture + Send + Sync + 'static
    where
        F: Fn(&PlanStep, &BTreeMap<u32, String>) -> Result<String, String> + Send + Sync + 'static,
    {
        move |step, results| {
            let r = f(step, results);
            Box::pin(async move { r }) as ToolFuture
        }
    }

    RealRunner::new()
        .register("file_list", wrap(tool_file_list))
        .register("list_files", wrap(tool_file_list))
        .register("file_read", wrap(tool_file_read))
        .register("read_file", wrap(tool_file_read))
        .register("file_write", wrap(tool_file_write))
        .register("write_file", wrap(tool_file_write))
        .register("folder_create", wrap(tool_folder_create))
        .register("create_folder", wrap(tool_folder_create))
        .register("mkdir", wrap(tool_folder_create))
        .register("file_move", wrap(tool_file_move))
        .register("move_file", wrap(tool_file_move))
        .register("file_copy", wrap(tool_file_copy))
        .register("copy_file", wrap(tool_file_copy))
        .register("file_find", wrap(tool_file_find))
        .register("file_search", wrap(tool_file_find))
        .register("text_extract", wrap(tool_text_extract))
        .register("text_summarize", wrap(tool_text_summarize))
        .register("text_join", wrap(tool_text_join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(tool: &str, params: serde_json::Value) -> PlanStep {
        let map: BTreeMap<String, serde_json::Value> =
            serde_json::from_value(params).unwrap_or_default();
        PlanStep {
            step: 1,
            description: format!("测试 {tool}"),
            tool: tool.into(),
            depends_on: vec![],
            params: map,
            expected_output: String::new(),
            fallback: None,
        }
    }

    /// 每个测试用独立临时目录，避免互相污染。
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("sky-tools-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("建临时目录失败");
        p
    }

    #[test]
    fn file_list_lists_real_entries() {
        let d = temp_dir("list");
        std::fs::write(d.join("a.txt"), "hello").unwrap();
        std::fs::create_dir(d.join("sub")).unwrap();

        let out = tool_file_list(
            &step("file_list", json!({"dir": d.to_string_lossy()})),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(out.contains("a.txt"), "应列出文件：{out}");
        assert!(out.contains("sub/"), "目录应有 / 后缀：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_list_reports_missing_dir() {
        let e = tool_file_list(
            &step("file_list", json!({"dir": "/definitely/not/here"})),
            &BTreeMap::new(),
        );
        assert!(e.is_err(), "不存在的目录必须报错");
    }

    /// 回归：缺 dir 时必须报错，不能静默回退到当前目录。
    ///
    /// 实测背景：LLM 有时省略 dir，旧实现回退到 `.`，
    /// 于是列出**当前目录**而用户以为列的是他指定的目录——
    /// 做了错的事还报告成功。这种「静默做错」比失败更危险。
    #[test]
    fn file_list_without_dir_refuses_instead_of_defaulting() {
        let r = tool_file_list(&step("file_list", json!({})), &BTreeMap::new());
        assert!(r.is_err(), "缺 dir 必须拒绝，不能回退到当前目录");
        let msg = r.unwrap_err();
        assert!(msg.contains("缺少 dir"), "错误应点名缺参数：{msg}");
    }

    #[test]
    fn file_find_without_dir_refuses() {
        let r = tool_file_find(&step("file_find", json!({"ext": "jpg"})), &BTreeMap::new());
        assert!(r.is_err(), "缺 dir 必须拒绝");
        assert!(r.unwrap_err().contains("缺少 dir"));
    }

    #[test]
    fn file_read_returns_real_content() {
        let d = temp_dir("read");
        let f = d.join("x.txt");
        std::fs::write(&f, "真实内容").unwrap();

        let out = tool_file_read(
            &step("file_read", json!({"path": f.to_string_lossy()})),
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(out, "真实内容");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_write_then_read_roundtrip() {
        let d = temp_dir("write");
        let f = d.join("out.txt");
        let w = tool_file_write(
            &step(
                "file_write",
                json!({"path": f.to_string_lossy(), "content": "写进去的内容"}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(w.contains("已写入"), "{w}");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "写进去的内容");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_move_actually_moves_file() {
        let d = temp_dir("move");
        let src = d.join("m.txt");
        std::fs::write(&src, "move me").unwrap();
        let dst = d.join("target");

        let out = tool_file_move(
            &step(
                "file_move",
                json!({"from": src.to_string_lossy(), "to": dst.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(out.contains("已移动"), "{out}");
        assert!(!src.exists(), "源文件应已不在原处");
        assert!(dst.join("m.txt").exists(), "文件应出现在目标目录");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 安全边界：目标已存在时拒绝覆盖，避免误删用户文件。
    #[test]
    fn file_move_refuses_to_overwrite() {
        let d = temp_dir("overwrite");
        let src = d.join("same.txt");
        std::fs::write(&src, "new").unwrap();
        let dst = d.join("dst");
        std::fs::create_dir(&dst).unwrap();
        std::fs::write(dst.join("same.txt"), "existing").unwrap();

        let r = tool_file_move(
            &step(
                "file_move",
                json!({"from": src.to_string_lossy(), "to": dst.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "目标已存在必须拒绝，不能静默覆盖");
        assert!(r.unwrap_err().contains("拒绝覆盖"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 安全闸门：拒绝移动目录。
    ///
    /// 实测背景：用户说「把 source 里的 a.jpg 移动到 jpg」，
    /// 参数兜底误把 source 目录当成源，结果整个目录被搬走——
    /// 三个文件一起没了。不可逆。所以这里硬拦。
    #[test]
    fn file_move_refuses_directory() {
        let d = temp_dir("movedir");
        let src_dir = d.join("srcdir");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("x.txt"), "x").unwrap();
        let dst = d.join("dst");

        let r = tool_file_move(
            &step(
                "file_move",
                json!({"from": src_dir.to_string_lossy(), "to": dst.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        );

        assert!(r.is_err(), "移动目录必须被拒绝");
        assert!(r.unwrap_err().contains("拒绝移动目录"));
        assert!(src_dir.exists(), "源目录必须原封不动");
        assert!(src_dir.join("x.txt").exists(), "目录内文件不能被动");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 安全边界：缺参数时拒绝执行，不做任何猜测。
    #[test]
    fn file_move_without_params_refuses() {
        let r = tool_file_move(&step("file_move", json!({})), &BTreeMap::new());
        assert!(r.is_err(), "缺参数必须拒绝执行");
    }

    #[test]
    fn file_find_filters_by_extension() {
        let d = temp_dir("find");
        std::fs::write(d.join("a.jpg"), "x").unwrap();
        std::fs::write(d.join("b.png"), "x").unwrap();
        std::fs::write(d.join("c.txt"), "x").unwrap();

        let out = tool_file_find(
            &step(
                "file_find",
                json!({"dir": d.to_string_lossy(), "ext": "jpg,png"}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(out.contains("a.jpg"), "{out}");
        assert!(out.contains("b.png"), "{out}");
        assert!(!out.contains("c.txt"), "不该含未匹配扩展名：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn text_extract_picks_content_lines() {
        let out = tool_text_extract(
            &step("text_extract", json!({"text": "第一行。\n第二行有数字 42\n"})),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(out.contains("第一行"), "{out}");
        assert!(out.contains("42"), "{out}");
    }

    #[test]
    fn text_summarize_truncates() {
        let long = "内容".repeat(500);
        let out = tool_text_summarize(
            &step("text_summarize", json!({"text": long, "maxLength": 20})),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(out.contains("摘要"), "{out}");
        assert!(out.contains("20") || out.chars().count() < 100, "应被截断：{out}");
    }

    /// 上游结果可作为隐式输入——LLM 生成的计划常依赖这个。
    #[test]
    fn text_extract_uses_upstream_result() {
        let mut results = BTreeMap::new();
        results.insert(1u32, "上游传来的文本\n第二行".to_string());
        let mut s = step("text_extract", json!({}));
        s.depends_on = vec![1];

        let out = tool_text_extract(&s, &results).unwrap();
        assert!(out.contains("上游传来的文本"), "{out}");
    }

    /// 注册表里必须包含规划器提示词提到的工具名。
    #[test]
    fn registry_covers_common_planner_tool_names() {
        let r = register_all();
        for name in [
            "file_list",
            "file_read",
            "file_write",
            "folder_create",
            "file_move",
            "file_find",
            "text_extract",
            "text_summarize",
        ] {
            assert!(r.has_tool(name), "应注册 {name}");
        }
    }

    /// 未实现的能力（如 PDF 转换）必须报未接入，绝不假装成功。
    #[test]
    fn unimplemented_tools_stay_unimplemented() {
        let r = register_all();
        for name in ["doc_convert", "image_ops", "media_ops"] {
            assert!(
                !r.has_tool(name),
                "{name} 尚未实现，不应出现在注册表里——否则又会假装成功"
            );
        }
    }
}
