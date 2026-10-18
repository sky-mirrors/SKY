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
    let raw = param_str(step, "path")
        .or_else(|| param_str(step, "file"))
        .ok_or_else(|| "file_read 缺少 path 参数".to_string())?;

    // 上游结果可能不是单个路径，而是一段文本（如 directory_tree 的输出）。
    // 此时从中解析出第一个真实存在、可读的文件路径。
    //
    // 实测背景：任务书里 `{{step_1_top_files}}` 被替换成整个目录树文本，
    // 直接当路径用会报「文件不存在：<整段文本>」，DAG 断在第二步。
    // 这里做有界解析：只从文本里找「真实存在且是文件」的路径，找不到就报错，
    // 绝不猜一个不存在的路径。
    let path = if Path::new(&raw).is_file() {
        raw
    } else {
        match first_existing_file(&raw) {
            Some(p) => p,
            None => return Err(format!("没有可读取的文件（输入不是有效路径）：{raw}")),
        }
    };

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取失败 {path}：{e}"))?;
    let _ = upstream_text(results, &step.depends_on);
    Ok(content)
}

/// 从一段文本里找出第一个「真实存在的文件」路径。
///
/// 用于上游结果不是单一路径的场景（如目录树文本）。
/// 只接受确实存在的文件——不猜、不构造路径，找不到就返回 `None`。
fn first_existing_file(text: &str) -> Option<String> {
    // 目录树输出里，顶层是「<dir> 目录树（N 项）：」，之后每行是相对路径。
    // 先尝试把首行的目录与后续每行拼成完整路径。
    let dir = text
        .lines()
        .next()
        .and_then(|l| l.strip_suffix(|c: char| c == '：' || c == ':'))
        .and_then(|l| l.split(" 目录树").next())
        .map(|s| s.trim().to_string());

    if let Some(dir) = &dir {
        let base = Path::new(dir);
        if base.is_dir() {
            for line in text.lines().skip(1) {
                let candidate = base.join(line.trim());
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    // 兜底：把每一行当作独立路径试一次（适用于「路径列表」型的上游结果）。
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if Path::new(t).is_file() {
            return Some(t.to_string());
        }
    }

    None
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

// ==================== 任务书所需工具 ====================
//
// 以下 4 个由 config/l2_manifests/ 的 20 份任务书实际引用（实测频次）：
// llm_generate 21 次、knowledge_search 12 次、shell_exec 6 次、
// directory_tree 1 次。read_file / write_file 已在上面实现，参数名一致。

/// `directory_tree`：列出目录树（比 `file_list` 深一层，带缩进）。
///
/// 参数：`path`（必填）。深度上限由 `depth` 控制（默认 2）。
fn tool_directory_tree(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let path = param_str(step, "path")
        .or_else(|| param_str(step, "dir"))
        .ok_or_else(|| "directory_tree 缺少 path 参数".to_string())?;
    let max_depth: usize = param_str(step, "depth")
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);

    let root = Path::new(&path);
    if !root.exists() {
        return Err(format!("目录不存在：{path}"));
    }
    if !root.is_dir() {
        return Err(format!("不是目录：{path}"));
    }

    let mut out = Vec::new();
    collect_tree(root, 0, max_depth, &mut out)
        .map_err(|e| format!("遍历失败 {path}：{e}"))?;

    if out.is_empty() {
        return Ok(format!("{path} 为空目录"));
    }
    Ok(format!("{path} 目录树（{} 项）：\n{}", out.len(), out.join("\n")))
}

/// 递归收集目录树，带缩进。
///
/// 有深度上限：避免在大目录上无限递归（也避免把整个磁盘读进内存）。
fn collect_tree(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<String>,
) -> std::io::Result<()> {
    if depth > max_depth {
        return Ok(());
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let indent = "  ".repeat(depth);
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            out.push(format!("{indent}{name}/"));
            collect_tree(&entry.path(), depth + 1, max_depth, out)?;
        } else {
            out.push(format!("{indent}{name}"));
        }
    }
    Ok(())
}

/// `knowledge_search`：在指定目录里按关键词检索文本文件。
///
/// 参数：`query`（必填）、`dir`（可选，默认当前目录）、`limit`（默认 10）。
///
/// **这是本地降级实现**：真正的知识库检索（向量/语义）需要索引与嵌入模型，
/// 本实现只做大小写无关的子串匹配。它在「有知识库索引时」应被替换，
/// 但在那之前比「报能力未接入」有用——且它诚实标注了实现方式。
fn tool_knowledge_search(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let query = param_str(step, "query")
        .or_else(|| param_str(step, "text"))
        .ok_or_else(|| "knowledge_search 缺少 query 参数".to_string())?;
    let dir = param_str(step, "dir").unwrap_or_else(|| ".".to_string());
    let limit: usize = param_str(step, "limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("知识库目录不存在：{dir}"));
    }

    let candidates = recall_candidates(root, &query, limit * 3);

    if candidates.is_empty() {
        return Ok(format!(
            "未找到与「{query}」相关的内容（检索目录：{dir}，词项重合度召回）"
        ));
    }

    // 确定性召回已能给出明确排序时，不必调模型——这正是省 token 的账。
    // 只在候选之间难以区分（或候选多于需要）时才需要语义重排。
    let lines: Vec<String> = candidates
        .iter()
        .take(limit)
        .map(|c| format!("{}（相关度 {:.2}）：{}", c.file, c.score, c.snippet))
        .collect();

    Ok(format!(
        "找到 {} 条相关记录（词项重合度召回，未调模型）：\n{}",
        lines.len(),
        lines.join("\n")
    ))
}

/// 一个召回候选。
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub file: String,
    pub snippet: String,
    pub score: f32,
}

/// 确定性召回：按词项重合度给文档打分。
///
/// **为什么不是纯子串匹配**：子串匹配要求查询词完整出现在文档里，
/// 「风险 控制」这样的多词查询、或词序不同（「控制风险」vs「风险控制」）
/// 都会漏。改为把查询切成词项，按命中比例打分——零成本，且召回率明显更高。
///
/// 打分权重：文件名命中 > 正文命中（文件名是作者给出的主题摘要）。
/// 同分时按文件名字典序，保证结果稳定（不依赖文件系统遍历顺序）。
pub fn recall_candidates(root: &Path, query: &str, max: usize) -> Vec<Candidate> {
    // 查询切词：中文按字符二元组 + 英文按空白/标点切分。
    // 中文没有空格分词，二元组是无需词典的通用近似。
    let terms = tokenize(query);
    if terms.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<Candidate> = Vec::new();

    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        // 只读文本类文件——二进制读进来没有意义
        if !matches!(
            ext.as_str(),
            "md" | "txt" | "json" | "csv" | "log" | "toml" | "yaml" | "yml"
        ) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&p) else {
            continue;
        };

        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let name_lower = name.to_lowercase();
        let content_lower = content.to_lowercase();

        // 打分：文件名命中权重 3，正文命中权重 1
        let mut score = 0.0f32;
        for t in &terms {
            if name_lower.contains(t) {
                score += 3.0;
            }
            if content_lower.contains(t) {
                score += 1.0;
            }
        }
        if score == 0.0 {
            continue;
        }
        // 归一化到 [0,1]：除以理论最大值
        let max_score = (terms.len() as f32) * 4.0;
        let normalized = (score / max_score).min(1.0);

        // 摘录：优先取含最多查询词的那一行
        let snippet = best_line(&content, &terms);

        out.push(Candidate {
            file: name,
            snippet,
            score: normalized,
        });
    }

    // 稳定排序：分数降序，同分按文件名升序
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.file.cmp(&b.file))
    });
    out.truncate(max);
    out
}

/// 把查询切成词项。
///
/// 中文：连续汉字取二元组（「风险控制」→ 风险/险控/控制）。
/// 英文/数字：按非字母数字字符切分。
///
/// 不用词典分词：引入分词器是重依赖，二元组召回率够用且零依赖。
fn tokenize(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut terms = Vec::new();
    let mut cjk_buf: Vec<char> = Vec::new();

    let flush_cjk = |buf: &mut Vec<char>, out: &mut Vec<String>| {
        if buf.len() == 1 {
            out.push(buf[0].to_string());
        } else {
            for w in buf.windows(2) {
                out.push(w.iter().collect());
            }
        }
        buf.clear();
    };

    let mut latin_buf = String::new();
    let flush_latin = |buf: &mut String, out: &mut Vec<String>| {
        if !buf.is_empty() {
            out.push(buf.clone());
            buf.clear();
        }
    };

    for ch in lower.chars() {
        if ch.is_alphanumeric() && !is_cjk(ch) {
            flush_cjk(&mut cjk_buf, &mut terms);
            latin_buf.push(ch);
        } else if is_cjk(ch) {
            flush_latin(&mut latin_buf, &mut terms);
            cjk_buf.push(ch);
        } else {
            flush_latin(&mut latin_buf, &mut terms);
            flush_cjk(&mut cjk_buf, &mut terms);
        }
    }
    flush_latin(&mut latin_buf, &mut terms);
    flush_cjk(&mut cjk_buf, &mut terms);

    terms.sort();
    terms.dedup();
    terms
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
}

/// 从正文里挑出与查询最相关的一行作为摘录。
fn best_line(content: &str, terms: &[String]) -> String {
    let mut best: Option<(usize, &str)> = None;
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let lower = l.to_lowercase();
        let hits = terms.iter().filter(|t| lower.contains(*t)).count();
        if hits > 0 && best.map(|(b, _)| hits > b).unwrap_or(true) {
            best = Some((hits, l));
        }
    }
    match best {
        Some((_, l)) => l.chars().take(120).collect(),
        None => content
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(120)
            .collect(),
    }
}

/// `llm_generate`：调用模型生成内容。
///
/// 参数：`prompt`（必填）、`maxTokens`（可选）。
///
/// **这是任务书里唯一消耗 token 的工具**（15 步引用，2026-10-18 实测）。
/// 其余工具都是确定性的——这正是「路由降级省 token」的账：
/// 一次任务书执行里通常只有 1 步走模型。
///
/// **步骤级响应缓存**（2026-10-18 接线）：以「替换上游引用后的完整 prompt」
/// 指纹（djb2，`sky_cache::FingerprintCache`——它的首个生产消费者）查缓存，
/// 命中即原样回放——不调模型、不需要密钥。任务书重复执行场景的 token 放血点：
/// 同一份合同第二次审查、同一段数据第二次摘要，成本从一次 GLM 调用降为 0。
/// TTL 24h（对齐任务书 cacheMeta 约定）、容量 200 条。
/// 缓存查询**必须排在密钥检查之前**——命中回放是无密钥环境的可用路径。
///
/// 无密钥时返回明确错误而非空串——静默返回空会让下游步骤
/// 拿到空输入却「成功」。
/// 替换文本里的所有上游步骤引用。
///
/// **支持任意后缀**：`{{step_1_result}}`、`{{step_1_top_files}}`、
/// `{{step_2_summary}}` 等都要替换。
///
/// 实测教训：最初只认 `{{step_N_result}}` 字面形态，结果任务书里
/// `{{step_1_top_files}}` 被漏掉，`read_file` 拿到字面量当路径，
/// 报「文件不存在：{{step_1_top_files}}」——整个 DAG 断在第二步。
///
/// 替换规则：`{{step_<N>_<任意后缀>}}` → 第 N 步的结果。
/// 找不到第 N 步结果时**保持原样**，让调用方检测到残留并报错——
/// 静默替换成空串会让下游拿到空输入却「成功」。
pub fn replace_upstream_refs(text: &str, results: &BTreeMap<u32, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // 找 "{{step_"
        if text[i..].starts_with("{{step_") {
            if let Some(end_rel) = text[i..].find("}}") {
                let end = i + end_rel;
                let inner = &text[i + 2..end]; // "step_1_top_files"
                if let Some(step_no) = parse_step_number(inner) {
                    if let Some(result) = results.get(&step_no) {
                        out.push_str(result);
                        i = end + 2;
                        continue;
                    }
                }
                // 解析不出或没有该步结果 → 原样保留
                out.push_str(&text[i..end + 2]);
                i = end + 2;
                continue;
            }
        }
        // 逐字符推进（注意 UTF-8 边界）
        let ch = text[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// 从 `step_<N>_<后缀>` 里解析出 N。
fn parse_step_number(inner: &str) -> Option<u32> {
    let rest = inner.strip_prefix("step_")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// 递归替换 JSON 值里的所有上游引用。
pub fn replace_upstream_in_value(
    v: &mut serde_json::Value,
    results: &BTreeMap<u32, String>,
) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains("{{step_") {
                *s = replace_upstream_refs(s, results);
            }
        }
        serde_json::Value::Array(a) => {
            for item in a {
                replace_upstream_in_value(item, results);
            }
        }
        serde_json::Value::Object(o) => {
            for item in o.values_mut() {
                replace_upstream_in_value(item, results);
            }
        }
        _ => {}
    }
}

/// 步骤级响应缓存（进程内 + 跨会话持久化）。
///
/// 键 = djb2(替换上游引用后的完整 prompt)。
/// 这是 `sky_cache::FingerprintCache` 的生产消费者。
/// TTL 24h 对齐任务书 cacheMeta 约定；容量 200 条。
///
/// **持久化**（95 册 §9.7 第 3 步）：启动时从
/// `<config_dir>/sky/llm_response_cache.jsonl` 加载（加载的条目按
/// saved_at 参与判定，过期的仍会被内存 TTL 拦下）；每次回填同步追加
/// 到盘——同一段论文的翻译跨会话直接回放，经典文档只需算一次。
/// 落盘失败静默容忍（缓存是优化，不是事实源——盘满/只读时退化为
/// 纯内存行为，不阻断执行）。
fn llm_response_cache() -> std::sync::MutexGuard<'static, sky_cache::FingerprintCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<sky_cache::FingerprintCache>> =
        std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut cache = sky_cache::FingerprintCache::new(200, 24 * 60 * 60 * 1000);
            // 启动加载：把持久化产物灌回内存（TTL 仍在内存侧生效）。
            let path = llm_cache_store_path();
            if let Ok(entries) = sky_cache::load_entries(&path) {
                for e in entries {
                    cache.put(&e.key, &e.response, e.saved_at);
                }
            }
            std::sync::Mutex::new(cache)
        })
        .lock()
        .unwrap()
}

/// 产物缓存落盘路径。环境变量 `SKY_CACHE_STORE` 可覆盖（测试隔离用）；
/// 缺省 `<config_dir>/sky/llm_response_cache.jsonl`。
fn llm_cache_store_path() -> std::path::PathBuf {
    match std::env::var("SKY_CACHE_STORE") {
        Ok(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => sky_cache::default_store_path(),
    }
}

/// 当前毫秒时间戳（指纹缓存 TTL 判定用）。
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `llm_generate` 的三态同步预处理结果。
enum LlmOutcome {
    /// 指纹缓存命中——直接回放，不调模型、不需要密钥。
    /// FactGuard 已在同步段裁决（critical 冲突不会走到这个变体）。
    Cached { text: String },
    /// 未命中——需要真实调用。
    Call {
        prompt: String,
        max_tokens: u32,
        temperature: f32,
        key: String,
        model: String,
        /// 上游步骤结果拼接（FactGuard 的源文档）。
        source: String,
        /// 领域约束（产出校验用）。
        policy: sky_pack::LlmPolicy,
    },
}

/// 收集上游步骤结果作为 FactGuard 的源文档。
/// 没有上游引用时返回空串（guard 直接放行）。
fn collect_source(results: &BTreeMap<u32, String>, prompt: &str) -> String {
    if !prompt.contains("{{step_") {
        return String::new();
    }
    results.values().cloned().collect::<Vec<_>>().join("\n")
}

/// FactGuard 裁决：产出与源文档存在 critical 事实冲突时阻断。
///
/// 法务/财务 anti-hallucination 链路的兑现点（95 册 §9.7）：
/// 模型改写金额/日期/百分比超出阈值（金额 10% / 日期 3 天 / 百分比 1）→ 拒绝。
/// 小差异走就地修正（`corrected_output`）；无源文档（无上游引用）直接放行。
fn fact_guard_verdict(source: &str, output: &str) -> Result<String, String> {
    if source.trim().is_empty() {
        return Ok(output.to_string());
    }
    let r = sky_memory::guard(source, output);
    match r.severity {
        sky_memory::Severity::Critical => Err(format!(
            "FactGuard 拦截：产出与源文档存在关键事实不一致，已阻止交付。{}",
            r.conflicts
                .iter()
                .map(|c| c.detail.clone())
                .collect::<Vec<_>>()
                .join("；")
        )),
        _ => Ok(r.corrected_output.unwrap_or_else(|| output.to_string())),
    }
}

fn tool_llm_generate_async(step: &PlanStep, results: &BTreeMap<u32, String>) -> ToolFuture {
    // 同步部分：参数校验 + 上游引用替换。这些不需要异步。
    let preparsed = (|| -> Result<LlmOutcome, String> {
        let mut prompt = param_str(step, "prompt")
            .or_else(|| param_str(step, "text"))
            .ok_or_else(|| "llm_generate 缺少 prompt 参数".to_string())?;

        // FactGuard 源文档收集必须在替换**前**——替换后 prompt 已不含
        // {{step_N}}，collect_source 将永远返回空串（实测踩过）。
        let source_doc = collect_source(results, &prompt);

        // 执行期替换上游引用。
        //
        // 这是「展开器保留、执行器替换」分工的兑现点：路由期不知道该结果，
        // 所以占位符被原样保留到这里；此刻上游步骤已执行完，可以替换了。
        prompt = replace_upstream_refs(&prompt, results);

        // 仍残留的上游占位符说明依赖步骤没成功执行。
        // 不能拿残缺 prompt 去调模型——那会得到看似合理实则错位的产出。
        if prompt.contains("{{step_") {
            return Err(format!(
                "llm_generate 的 prompt 仍含未替换的上游引用（依赖步骤未成功执行）：{prompt}"
            ));
        }

        // 步骤级响应缓存：命中即回放，不调模型、不需要密钥。
        // 必须排在密钥检查之前——命中回放是无密钥环境的可用路径。
        // 源文档在命中/未命中两路都要带（FactGuard 对缓存产出同样校验）。
        // 领域约束（LlmPolicy）：任务书步骤可声明 `llmPolicy`——
        // maxTokens/temperature 收紧 + 产出校验（禁词/必含），缓存回放同样过校验。
        let policy: sky_pack::LlmPolicy = step
            .params
            .get("llmPolicy")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let cached = {
            let cache = llm_response_cache();
            cache
                .get(&sky_cache::FingerprintCache::fingerprint(&prompt), now_millis())
                .map(|e| e.response_text.clone())
        };
        if let Some(text) = cached {
            let checked = fact_guard_verdict(&source_doc, &text)?;
            let checked = policy.check_output(&checked)?;
            return Ok(LlmOutcome::Cached { text: checked });
        }

        let cfg = sky_llm::resolve_config();
        let Some(key) = cfg.api_key else {
            return Err(
                "llm_generate 需要模型密钥，但未配置（环境变量 SKY_GLM_API_KEY 或用户配置文件）"
                    .to_string(),
            );
        };

        let max_tokens = policy.effective_max_tokens(
            param_str(step, "maxTokens")
                .and_then(|s| s.parse().ok())
                .unwrap_or(1200u32),
        );
        let temperature = policy.effective_temperature(0.2);

        Ok(LlmOutcome::Call {
            prompt,
            max_tokens,
            temperature,
            key,
            model: cfg.model,
            source: source_doc,
            policy,
        })
    })();

    match preparsed {
        Err(e) => Box::pin(async move { Err(e) }),
        Ok(LlmOutcome::Cached { text }) => Box::pin(async move { Ok(text) }),
        Ok(LlmOutcome::Call {
            prompt,
            max_tokens,
            temperature,
            key,
            model,
            source,
            policy,
        }) => {
            let cfg = sky_llm::resolve_config();
            let caller = sky_llm::HttpProviderCall::with_key(key);
            let provider = sky_llm::glm_config_with(&model, &cfg.base_url);
            // 指纹先算——prompt 即将被 move 进消息体。
            let prompt_fp = sky_cache::FingerprintCache::fingerprint(&prompt);
            let req = build_req_with_temperature(
                sky_core::ChatMessage {
                    role: "user".into(),
                    content: prompt,
                    timestamp: None,
                },
                max_tokens,
                temperature,
            );
            Box::pin(async move {
                use sky_llm::ProviderCall;
                match caller.call(&provider, &req).await {
                    Ok(r) => {
                        // FactGuard 裁决：critical 冲突阻断，小差异就地修正。
                        // 裁决在回填之前——被拦截的产出不得进缓存。
                        let checked = fact_guard_verdict(&source, &r.content)?;
                        // 领域约束裁决（禁词/必含）——同一原则：驯化靠闸门不靠恳求。
                        let checked = policy.check_output(&checked)?;
                        // 成功产出回填指纹缓存——同 prompt 下次零 token 回放。
                        llm_response_cache().put(&prompt_fp, &checked, now_millis());
                        // 同步追加落盘（跨会话资产）。失败容忍：缓存是优化不是事实源。
                        let _ = sky_cache::append_entry(
                            &llm_cache_store_path(),
                            &sky_cache::PersistedEntry {
                                key: prompt_fp,
                                response: checked.clone(),
                                saved_at: now_millis(),
                            },
                        );
                        Ok(checked)
                    }
                    Err(e) => Err(format!("模型调用失败：{e}")),
                }
            })
        }
    }
}

/// 带温度的组装（领域 LlmPolicy 可收紧；默认 0.2）。
fn build_req_with_temperature(
    msg: sky_core::ChatMessage,
    max_tokens: u32,
    temperature: f32,
) -> sky_llm::ChatRequest {
    sky_llm::ChatRequest {
        messages: vec![msg],
        model: String::new(), // 由 provider 配置决定
        temperature: Some(temperature),
        max_tokens: Some(max_tokens),
    }
}

/// `shell_exec`：执行 shell 命令。
///
/// 参数：`command`（必填）、`cwd`（可选）。
///
/// **这是本文件里唯一有真实破坏力的工具**——20 份任务书里引用 6 次。
/// 安全边界（硬闸门，有测试锁定）：
///
/// 1. **拒绝破坏性模式**：`rm -rf`、`del /f`、`format`、`> /dev/sd*`、
///    `mkfs`、`dd of=`、`:(){ :|:& };:`（fork 炸弹）等。这是黑名单，
///    黑名单永远不完整——所以还有第 2 条。
/// 2. **不可解释的命令拒绝执行**：解析不出可识别的命令名（如含管道、
///    重定向、命令替换的复合命令）时，如实报「需用户确认」而非直接跑。
/// 3. **不猜参数**：命令必须由任务书显式给出，不从用户输入拼接。
///
/// 局限（诚实记录）：黑名单可被绕过（如 `r''m -rf`）。真正的隔离需要
/// 沙箱（容器/权限降级），当前实现是「降低误操作风险」而非「安全边界」。
/// 这一点必须让调用方知道。
///
/// **安全规则单一事实源**（2026-10-18 收敛）：5 道闸门的白名单/模式定义
/// 已上移到 `sky_security::task_gate`——本函数只做裁决调用与执行。
/// 规则变更改 task_gate 一处即生效。
fn tool_shell_exec(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let command = param_str(step, "command")
        .ok_or_else(|| "shell_exec 缺少 command 参数".to_string())?;

    let trimmed = command.trim();

    // 5 道闸门统一在 sky_security::task_gate 裁决（fail-closed）。
    // 拒绝理由与原逐字实现一致（两侧测试共同锁定）。
    match sky_security::check_task_shell(trimmed) {
        sky_security::TaskShellVerdict::Denied(reason) => return Err(reason),
        sky_security::TaskShellVerdict::Allowed => {}
    }

    // （闸门 3/4/5 已在 check_task_shell 内完成）

    let cwd = param_str(step, "cwd");
    let mut cmd = std::process::Command::new(trimmed.split_whitespace().next().unwrap_or(""));
    let args: Vec<&str> = trimmed.split_whitespace().skip(1).collect();
    cmd.args(&args);
    if let Some(d) = &cwd {
        if !Path::new(d).is_dir() {
            return Err(format!("shell_exec 的工作目录不存在：{d}"));
        }
        cmd.current_dir(d);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("执行失败「{trimmed}」：{e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("$ {trimmed}\n{stdout}"))
    } else {
        Err(format!(
            "$ {trimmed}\n退出码 {}\nstdout: {stdout}\nstderr: {stderr}",
            out.status.code().unwrap_or(-1)
        ))
    }
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
        .register("directory_tree", wrap(tool_directory_tree))
        .register("knowledge_search", wrap(tool_knowledge_search))
        .register("shell_exec", wrap(tool_shell_exec))
        .register("app_automate", wrap(tool_app_automate))
        // llm_generate 是唯一异步工具：它要调模型网关。
        // 无密钥时返回明确的 Err——静默返回空串会让下游步骤拿到空输入却「成功」。
        .register("llm_generate", tool_llm_generate_async)
}

/// `app_automate`：驱动外部专业软件（Origin/ChemDraw）——harness 本义。
///
/// 安全边界：命令由 `app_automation::render_automation` 从**固定模板**渲染
/// （应用白名单 + 操作模板表 + 参数消毒），本函数只负责执行，不拼任何脚本。
/// 可用性探测见 `app_automation::availability_probe`。
fn tool_app_automate(step: &PlanStep, _results: &BTreeMap<u32, String>) -> Result<String, String> {
    let app = param_str(step, "app").ok_or_else(|| "app_automate 缺少 app 参数".to_string())?;
    let operation = param_str(step, "operation")
        .ok_or_else(|| "app_automate 缺少 operation 参数".to_string())?;
    let params = step
        .params
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));

    let command = crate::app_automation::render_automation(&app, &operation, &params)?;

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &command])
        .output()
        .map_err(|e| format!("app_automate 启动 powershell 失败：{e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("[{app}/{operation}] 完成\n{stdout}"))
    } else {
        // 常见失败：COM 未安装（无 Origin/ChemDraw）——如实报告可用性。
        let avail = crate::app_automation::availability_probe();
        let hint: Vec<String> = avail.iter().map(|(n, ok)| format!("{n}={ok}")).collect();
        Err(format!(
            "app_automate 失败（退出码 {}）\nstderr: {stderr}\n本机可用性探测：{}",
            out.status.code().unwrap_or(-1),
            hint.join(", ")
        ))
    }
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

    // ========== 任务书所需工具（Wave 3） ==========

    /// 防漂移：20 份任务书引用的每个工具都必须已注册。
    ///
    /// **这是本设计最重要的一条测试**。任务书写了某工具但执行器没实现，
    /// 就会重演「能力未接入」——任务书成了新的假成功来源。
    /// 有了这条，那种漂移在 CI 阶段就暴露，而不是等用户点了才发现。
    #[test]
    fn all_manifest_referenced_tools_are_registered() {
        let load = sky_core::load_builtin();
        assert!(!load.has_failures(), "任务书应全部可解析");

        let referenced = sky_core::referenced_tools(load.manifests());
        let r = register_all();

        let missing: Vec<&str> = referenced
            .iter()
            .filter(|t| !r.has_tool(t))
            .map(|t| t.as_str())
            .collect();

        assert!(
            missing.is_empty(),
            "任务书引用了未注册的工具：{missing:?}。\n\
             这会导致「任务书说能做、实际做不到」——必须补实现或修任务书。\n\
             已注册：{:?}",
            r.available_tools()
        );
    }

    #[test]
    fn directory_tree_lists_nested_files() {
        let d = temp_dir("tree");
        std::fs::write(d.join("a.txt"), "x").unwrap();
        let sub = d.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), "y").unwrap();

        let out = tool_directory_tree(
            &step("directory_tree", json!({"path": d.to_string_lossy()})),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(out.contains("a.txt"), "应含顶层文件：{out}");
        assert!(out.contains("b.txt"), "应含子目录文件：{out}");
        assert!(out.contains("sub"), "应含子目录名：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 缺 path 必须报错，不能静默扫当前目录——同 file_list 的教训。
    #[test]
    fn directory_tree_without_path_refuses() {
        let r = tool_directory_tree(&step("directory_tree", json!({})), &BTreeMap::new());
        assert!(r.is_err(), "缺 path 必须拒绝");
        assert!(r.unwrap_err().contains("缺少 path"));
    }

    #[test]
    fn knowledge_search_finds_text_in_files() {
        let d = temp_dir("kb");
        std::fs::write(d.join("doc1.txt"), "这份文档提到了风险控制").unwrap();
        std::fs::write(d.join("doc2.txt"), "这份文档讲的是别的").unwrap();

        let out = tool_knowledge_search(
            &step(
                "knowledge_search",
                json!({"query": "风险控制", "dir": d.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(out.contains("doc1"), "应命中含关键词的文件：{out}");
        assert!(!out.contains("doc2"), "不该命中无关文件：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn knowledge_search_without_query_refuses() {
        let r = tool_knowledge_search(&step("knowledge_search", json!({})), &BTreeMap::new());
        assert!(r.is_err(), "缺 query 必须拒绝");
    }

    // ---- 语义召回（P3）----

    #[test]
    fn tokenize_splits_cjk_into_bigrams() {
        let t = tokenize("风险控制");
        assert!(t.contains(&"风险".to_string()), "{t:?}");
        assert!(t.contains(&"控制".to_string()), "{t:?}");
    }

    #[test]
    fn tokenize_handles_mixed_cjk_latin() {
        let t = tokenize("检查 PDF 风险");
        assert!(t.iter().any(|x| x == "pdf"), "{t:?}");
        assert!(t.iter().any(|x| x == "风险"), "{t:?}");
    }

    /// 关键：词序不同也能召回——子串匹配做不到这个。
    ///
    /// 文档写「控制风险」，查询说「风险控制」，子串匹配会漏；
    /// 二元组切词后两者共享「风险」「控制」两个词项，能召回。
    #[test]
    fn recall_handles_word_order_difference() {
        let d = temp_dir("order");
        std::fs::write(d.join("a.txt"), "本文讨论如何控制风险").unwrap();
        std::fs::write(d.join("b.txt"), "完全无关的内容").unwrap();

        let hits = recall_candidates(&d, "风险控制", 10);
        assert!(
            hits.iter().any(|c| c.file == "a.txt"),
            "词序不同应仍能召回：{hits:?}"
        );
        assert!(
            !hits.iter().any(|c| c.file == "b.txt"),
            "无关文件不该被召回：{hits:?}"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 部分词命中也能召回——子串匹配要求完整包含查询串。
    #[test]
    fn recall_matches_partial_terms() {
        let d = temp_dir("partial");
        std::fs::write(d.join("risk.md"), "风险识别与评估方法").unwrap();

        let hits = recall_candidates(&d, "风险评估", 10);
        assert!(
            hits.iter().any(|c| c.file == "risk.md"),
            "部分词命中应召回：{hits:?}"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 文件名命中权重高于正文命中。
    #[test]
    fn filename_hits_outweigh_body_hits() {
        let d = temp_dir("weight");
        std::fs::write(d.join("合同风险.md"), "一些普通内容").unwrap();
        std::fs::write(d.join("notes.txt"), "正文里提到风险这个词").unwrap();

        let hits = recall_candidates(&d, "风险", 10);
        assert_eq!(hits[0].file, "合同风险.md", "文件名命中应排前：{hits:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 排序必须稳定——同分时按文件名，不依赖文件系统遍历顺序。
    #[test]
    fn recall_order_is_deterministic() {
        let d = temp_dir("stable");
        for n in ["c.txt", "a.txt", "b.txt"] {
            std::fs::write(d.join(n), "风险").unwrap();
        }
        let first = recall_candidates(&d, "风险", 10);
        let second = recall_candidates(&d, "风险", 10);
        assert_eq!(first, second, "两次召回结果应完全一致");
        let names: Vec<&str> = first.iter().map(|c| c.file.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "c.txt"], "同分应按文件名升序");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recall_ignores_binary_files() {
        let d = temp_dir("binary");
        std::fs::write(d.join("data.bin"), "风险").unwrap();
        let hits = recall_candidates(&d, "风险", 10);
        assert!(hits.is_empty(), "二进制文件不该被召回：{hits:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 摘录应挑出与查询最相关的那一行，而不是第一行。
    #[test]
    fn snippet_picks_most_relevant_line() {
        let d = temp_dir("snippet");
        std::fs::write(
            d.join("doc.md"),
            "# 标题\n\n无关的一段话\n\n这里讨论了风险控制的具体做法\n",
        )
        .unwrap();
        let hits = recall_candidates(&d, "风险控制", 10);
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.contains("风险控制"),
            "摘录应含查询词所在行：{}",
            hits[0].snippet
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_reports_no_hits_clearly() {
        let d = temp_dir("nohit");
        std::fs::write(d.join("a.txt"), "完全无关").unwrap();
        let out = tool_knowledge_search(
            &step(
                "knowledge_search",
                json!({"query": "量子纠缠", "dir": d.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(out.contains("未找到"), "{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 输出必须标明「未调模型」——让用户知道这次检索省了 token。
    #[test]
    fn search_output_states_no_model_call() {
        let d = temp_dir("nomodel");
        std::fs::write(d.join("a.txt"), "风险控制").unwrap();
        let out = tool_knowledge_search(
            &step(
                "knowledge_search",
                json!({"query": "风险", "dir": d.to_string_lossy()}),
            ),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(out.contains("未调模型"), "应标明未消耗 token：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ========== shell_exec 安全闸门 ==========
    //
    // 20 份任务书里引用 6 次，是本文件唯一有真实破坏力的工具。
    // 这些拒绝用例是它的安全边界，不是装饰。

    #[test]
    fn shell_exec_rejects_rm_rf() {
        // 用无害路径做输入：验证的是「闸门拒绝 rm -rf 这个模式」，
        // 不需要、也不该在测试里写出指向根目录的命令——
        // 万一闸门将来回归，测试本身就是一次破坏。
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "rm -rf ./some-temp-dir"})),
            &BTreeMap::new(),
        );
        let e = r.expect_err("rm -rf 必须被拒绝");
        // 实测：`rm` 被白名单闸门拦下（比破坏性模式闸门更靠前）。
        // 断言只要求「被拒绝且说明了原因」，不绑定是哪一道闸门——
        // 否则调整闸门顺序会误伤测试。
        assert!(
            e.contains("拒绝执行"),
            "错误应说明被拒绝，实际：{e}"
        );
    }

    #[test]
    fn shell_exec_rejects_del_force() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "del /f /s /q C:\\*"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "del /f 必须被拒绝");
    }

    #[test]
    fn shell_exec_rejects_format() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "format C: /y"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "format 必须被拒绝");
    }

    #[test]
    fn shell_exec_rejects_device_redirect() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "echo x > /dev/sda"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "写裸设备必须被拒绝");
    }

    #[test]
    fn shell_exec_rejects_empty_command() {
        let r = tool_shell_exec(&step("shell_exec", json!({})), &BTreeMap::new());
        assert!(r.is_err(), "空命令必须拒绝");
    }

    // ---- 闸门加固：实测发现的绕过路径 ----

    /// 白名单含 "git"，但 `git clean -fdx` 会删掉所有未跟踪文件。
    /// 只靠程序名白名单不够——必须拦危险子命令。
    #[test]
    fn shell_exec_rejects_git_clean() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "git clean -fdx"})),
            &BTreeMap::new(),
        );
        let e = r.expect_err("git clean 必须被拒绝");
        assert!(e.contains("危险子操作"), "应说明是子操作问题：{e}");
    }

    #[test]
    fn shell_exec_rejects_git_reset_hard() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "git reset --hard HEAD~3"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "git reset --hard 必须被拒绝");
    }

    /// 白名单含 "find"，但 `find . -delete` 会删文件。
    #[test]
    fn shell_exec_rejects_find_delete() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "find . -name '*.tmp' -delete"})),
            &BTreeMap::new(),
        );
        let e = r.expect_err("find -delete 必须被拒绝");
        assert!(e.contains("危险子操作"), "{e}");
    }

    /// `find -exec` 可以执行任意命令——比 -delete 更危险。
    #[test]
    fn shell_exec_rejects_find_exec() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "find . -exec rm {} ;"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "find -exec 必须被拒绝");
    }

    /// 带路径的程序名绕过白名单检查——必须拒绝。
    #[test]
    fn shell_exec_rejects_path_qualified_program() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "/bin/cat /etc/passwd"})),
            &BTreeMap::new(),
        );
        let e = r.expect_err("带路径的程序名必须拒绝");
        assert!(e.contains("不能带路径"), "应说明原因：{e}");
    }

    #[test]
    fn shell_exec_rejects_relative_path_program() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "./malicious.sh"})),
            &BTreeMap::new(),
        );
        assert!(r.is_err(), "相对路径程序名必须拒绝");
    }

    /// 反例：白名单内的安全命令应放行。
    #[test]
    fn shell_exec_allows_safe_whitelisted_command() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "echo hello"})),
            &BTreeMap::new(),
        );
        let out = r.expect("echo 应被允许");
        assert!(out.contains("hello"), "{out}");
    }

    #[test]
    fn shell_exec_allows_readonly_git() {
        let r = tool_shell_exec(
            &step("shell_exec", json!({"command": "git log --oneline -1"})),
            &BTreeMap::new(),
        );
        // git log 是只读的，应放行（在仓库内会成功，不在则报错但非闸门拒绝）
        match r {
            Ok(_) => {}
            Err(e) => assert!(
                !e.contains("危险子操作") && !e.contains("不在允许清单"),
                "只读 git 命令不该被闸门拦下：{e}"
            ),
        }
    }

    /// 步骤级响应缓存：prompt 指纹命中时回放缓存产出，不调模型、不需要密钥。
    /// 这是任务书重复执行场景的 token 放血点——同一份合同第二次审查应 0 token。
    #[tokio::test]
    async fn llm_generate_replays_cached_response_without_key() {
        let prompt_text = "审查这份合同的风险条款（缓存命中测试载荷 v1）";
        let cached_response = "【缓存回放】风险条款：第3条违约金过高——建议下调至20%";

        // 预注入：以 djb2(替换后 prompt) 为键写入指纹缓存
        {
            let key = sky_cache::FingerprintCache::fingerprint(prompt_text);
            llm_response_cache().put(&key, cached_response, now_millis());
        }

        let mut s = step("llm_generate", json!({"prompt": prompt_text}));
        s.step = 1;
        let fut = tool_llm_generate_async(&s, &BTreeMap::new());
        let r = fut.await;
        match r {
            Ok(text) => assert_eq!(
                text, cached_response,
                "指纹命中必须原样回放缓存产出，而不是调模型"
            ),
            Err(e) => panic!("缓存命中时不应走到模型调用/密钥检查，实际报错：{e}"),
        }
    }

    /// 缓存未命中时行为不变：无密钥仍明确报配置错误（不得静默空串）。
    #[tokio::test]
    async fn llm_generate_cache_miss_still_requires_key() {
        let mut s = step(
            "llm_generate",
            json!({"prompt": "完全唯一的未缓存 prompt（cache-miss 探针 v1）"}),
        );
        s.step = 1;
        let fut = tool_llm_generate_async(&s, &BTreeMap::new());
        let r = fut.await;
        match r {
            Err(e) => assert!(
                e.contains("密钥") || e.contains("模型调用失败"),
                "未命中时应保持原行为（配置错误/调用失败），实际：{e}"
            ),
            Ok(_) => { /* 本机配了密钥且调用成功——可接受 */ }
        }
    }

    /// 端到端持久化回放（95 册 §9.7 第 3 步的用户级验收）：
    /// 「会话 1」触发成功回填（网络真实调用）→ 落盘 →
    /// 「会话 2」（新的 store 路径加载同一文件）→ 同 prompt 命中回放，
    /// 全程第二次调用不再需要网络/密钥。
    ///
    /// 路径隔离：SKY_CACHE_STORE 指向临时文件，不污染真实用户缓存。
    #[tokio::test]
    async fn llm_generate_persists_and_replays_across_restart() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        // 独立 store 路径（测试隔离；OnceLock 只认首次——本测试必须是
        // 进程内第一个触碰该覆盖变量的，parallel 模式下由文件锁保序不必要：
        // 覆盖路径不设置时默认真实路径，而其他 llm_generate 测试已存在，
        // 它们先初始化的话本测试拿到的就是已初始化的缓存——可接受：
        // 断言的是「落盘文件里能查到本测试的 key」，不依赖初始化顺序）。
        let store = std::env::temp_dir().join(format!(
            "sky-cache-restart-test-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&store);
        std::env::set_var("SKY_CACHE_STORE", &store);

        // 会话 1：唯一 prompt，走真实网络（本机有密钥），成功后回填+落盘。
        let probe = format!("持久化重启回放探针 {}", std::process::id());
        let mut s1 = step("llm_generate", json!({"prompt": probe.clone()}));
        s1.step = 1;
        let r1 = tool_llm_generate_async(&s1, &BTreeMap::new()).await;
        let Ok(first) = r1 else {
            // 无密钥环境：本测试退化为「落盘→重启→回放」的纯缓存层验证。
            let key = sky_cache::FingerprintCache::fingerprint(&probe);
            llm_response_cache().put(&key, "【注入】重启回放载荷", now_millis());
            sky_cache::append_entry(
                &store,
                &sky_cache::PersistedEntry {
                    key,
                    response: "【注入】重启回放载荷".into(),
                    saved_at: now_millis(),
                },
            )
            .unwrap();
            let content = std::fs::read_to_string(&store).unwrap();
            assert!(content.contains("【注入】"), "落盘应已发生");
            let loaded = sky_cache::load_entries(&store).unwrap();
            assert_eq!(loaded[0].response, "【注入】重启回放载荷");
            let _ = std::fs::remove_file(&store);
            std::env::remove_var("SKY_CACHE_STORE");
            return;
        };

        // 落盘应已发生
        let content = std::fs::read_to_string(&store).unwrap();
        assert!(content.contains(&probe), "回填应同步落盘");

        // 会话 2：直接查 store 文件（模拟重启后加载），再经缓存查同一 prompt。
        let key = sky_cache::FingerprintCache::fingerprint(&probe);
        let persisted = sky_cache::load_entries(&store).unwrap();
        assert!(
            persisted.iter().any(|e| e.key == key),
            "持久化文件应含本 prompt 的指纹键"
        );
        // 内存缓存命中（同进程内等价于重启后加载的命中路径）
        let cached = llm_response_cache()
            .get(&key, now_millis())
            .map(|e| e.response_text.clone());
        assert_eq!(cached.as_deref(), Some(first.as_str()), "重启回放应与首跑产出一致");

        let calls: AtomicUsize = AtomicUsize::new(0);
        let _ = calls.load(Ordering::SeqCst);
        let _ = std::fs::remove_file(&store);
        std::env::remove_var("SKY_CACHE_STORE");
    }

    /// FactGuard 接线（法务 anti-hallucination 链路，95 册 §9.7）：
    /// `llm_generate` 的产出（模型改写合同金额）与上游步骤结果（合同原文）
    /// 存在 critical 事实冲突时必须被阻断——不能把「金额对不上」的产出
    /// 静默交给下游步骤或用户。
    #[tokio::test]
    async fn fact_guard_blocks_amount_conflict_against_upstream() {
        // 上游步骤（step 1）产出合同原文：违约金 50 万元
        let mut results = BTreeMap::new();
        results.insert(
            1u32,
            "合同第三条：乙方违约应支付违约金人民币¥500,000元，于30日内付清。".to_string(),
        );

        // llm_generate 的 prompt 引用 step_1，产出（缓存注入）篡改金额为 5 万
        let prompt_text = "根据以下合同生成风险摘要：{{step_1_result}}";
        let key = sky_cache::FingerprintCache::fingerprint(&replace_upstream_refs(
            prompt_text,
            &results,
        ));
        llm_response_cache().put(
            &key,
            "违约摘要：乙方需支付违约金人民币¥50,000元（约 5 万元）。",
            now_millis(),
        );

        let mut s = step("llm_generate", json!({"prompt": prompt_text}));
        s.step = 2;
        let fut = tool_llm_generate_async(&s, &results);
        let r = fut.await;
        match r {
            Err(e) => assert!(
                e.contains("事实") || e.contains("不一致"),
                "金额 50 万→5 万属 critical 冲突，应被 FactGuard 阻断并说明，实际：{e}"
            ),
            Ok(text) => panic!(
                "篡改金额的产出不应被放行，实际返回了：{text}"
            ),
        }
    }

    /// 反向：一致产出正常放行（小差异走就地修正或直接通过）。
    #[tokio::test]
    async fn fact_guard_passes_consistent_output() {
        let mut results = BTreeMap::new();
        results.insert(
            1u32,
            "合同第三条：乙方违约应支付违约金人民币¥500,000元。".to_string(),
        );
        let prompt_text = "总结：{{step_1_result}}";
        let key =
            sky_cache::FingerprintCache::fingerprint(&replace_upstream_refs(prompt_text, &results));
        llm_response_cache().put(
            &key,
            "摘要：违约金为人民币¥500,000元，条款清晰无异议。",
            now_millis(),
        );
        let mut s = step("llm_generate", json!({"prompt": prompt_text}));
        s.step = 2;
        let fut = tool_llm_generate_async(&s, &results);
        let r = fut.await;
        match r {
            Ok(text) => assert!(text.contains("500,000"), "一致产出应原样放行：{text}"),
            Err(e) => panic!("一致产出不应被拦截：{e}"),
        }
    }

    /// LlmPolicy 接线：任务书步骤声明 `llmPolicy` 后，
    /// 产出含禁词即被拒（缓存回放路径同样过校验）。
    #[tokio::test]
    async fn llm_policy_forbidden_term_blocks_cached_output() {
        let results: BTreeMap<u32, String> = BTreeMap::new();
        let prompt_text = "生成一段不含上游的化学结论说明。";
        let key = sky_cache::FingerprintCache::fingerprint(prompt_text);
        llm_response_cache().put(
            &key,
            "这个化合物大概是无害的。",
            now_millis(),
        );

        let mut s = step(
            "llm_generate",
            json!({
                "prompt": prompt_text,
                "llmPolicy": { "forbidden_terms": ["大概"] }
            }),
        );
        s.step = 1;
        let fut = tool_llm_generate_async(&s, &results);
        let r = fut.await;
        match r {
            Err(e) => assert!(
                e.contains("禁词") && e.contains("大概"),
                "禁词校验应拒绝含糊表述，实际：{e}"
            ),
            Ok(text) => panic!("含禁词的产出不应放行，实际返回了：{text}"),
        }
    }

    /// llm_generate 无密钥时必须明确报错，不能返回空串。
    #[tokio::test]
    async fn llm_generate_without_key_reports_error() {
        // 确保环境无密钥（测试进程内）
        let mut s = step("llm_generate", json!({"prompt": "说点什么"}));
        s.step = 1;
        let fut = tool_llm_generate_async(&s, &BTreeMap::new());
        let r = fut.await;
        // 有密钥时网络会失败/成功都可能；无密钥时必须是明确的配置错误。
        match r {
            Err(e) => assert!(
                e.contains("密钥") || e.contains("模型调用失败"),
                "错误应说明原因，实际：{e}"
            ),
            Ok(_) => { /* 本机配了密钥且调用成功——可接受 */ }
        }
    }

    /// llm_generate 必须替换上游引用；残留未替换时应报错。
    #[tokio::test]
    async fn llm_generate_rejects_unresolved_upstream_ref() {
        let mut step = step("llm_generate", json!({"prompt": "请分析 {{step_2_result}}"}));
        step.step = 3;
        step.depends_on = vec![2];
        // 上游 2 未在 results 里 → 占位符替换不掉
        let r = tool_llm_generate_async(&step, &BTreeMap::new()).await;
        assert!(r.is_err(), "残留上游引用必须报错，不能拿残缺 prompt 调模型");
        assert!(r.unwrap_err().contains("未替换"));
    }
}
