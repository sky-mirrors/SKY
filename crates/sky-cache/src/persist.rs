//! 缓存持久化——把进程内产物升级为跨会话资产（95 册 §9.7 第 3 步）。
//!
//! **动机**：论文阅读台样板的产物（段落翻译/摘要）是可复用资产——
//! 经典论文全世界的人读，翻译只需算一次。进程内缓存重启即清，
//! 每个会话都要重算；落盘后同一篇文档 24h 内跨会话直接回放。
//!
//! **格式**：JSON Lines（追加友好、崩溃安全——最后一行残缺不影响前面的行）。
//! 每行 `{key, response, saved_at}`；加载时按 saved_at 去重取最新。
//!
//! **为什么只持久化步骤缓存、不持久化路由缓存**：路由缓存的键是
//! 「归一化输入/规范化动作」→ 计划，计划随任务书/规则版本漂移
//! （改了任务书关键词，旧计划可能失效）；产物缓存（prompt → 产出文本）
//! 的值是内容本身，不随代码漂移。持久化资产层只存「不会过期的东西」。

use std::io::{BufRead, Write};
use std::path::PathBuf;

/// 一条持久化的缓存条目。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedEntry {
    pub key: String,
    pub response: String,
    pub saved_at: u64,
}

/// 追加一条到 JSONL 文件。目录不存在则创建。
pub fn append_entry(path: &std::path::Path, entry: &PersistedEntry) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let line = serde_json::to_string(entry)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    writeln!(f, "{line}")
}

/// 从 JSONL 加载全部条目；同键取 saved_at 最新。
///
/// 崩溃安全：残缺行（写入中断的最后一行）跳过，不影响其余。
pub fn load_entries(path: &std::path::Path) -> std::io::Result<Vec<PersistedEntry>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let f = std::fs::File::open(path)?;
    let mut latest: std::collections::HashMap<String, PersistedEntry> =
        std::collections::HashMap::new();
    for line in std::io::BufReader::new(f).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        // 残缺行直接跳过——崩溃安全的关键
        if let Ok(e) = serde_json::from_str::<PersistedEntry>(&line) {
            match latest.get(&e.key) {
                Some(old) if old.saved_at >= e.saved_at => {}
                _ => {
                    latest.insert(e.key.clone(), e);
                }
            }
        }
    }
    let mut v: Vec<PersistedEntry> = latest.into_values().collect();
    v.sort_by_key(|e| e.saved_at);
    Ok(v)
}

/// 默认产物缓存文件路径：`<config_dir>/sky/llm_response_cache.jsonl`。
///
/// 复用 sky-llm 的目录约定（`config.rs:94`）；config_dir 不可用时退回
/// 当前目录（测试与无家目录环境）。
pub fn default_store_path() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("sky").join("llm_response_cache.jsonl"))
        .unwrap_or_else(|| PathBuf::from(".sky-response-cache.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sky-cache-persist-test-{tag}.jsonl"))
    }

    #[test]
    fn append_then_load_roundtrip() {
        let p = tmp_path("roundtrip");
        let _ = std::fs::remove_file(&p);
        append_entry(
            &p,
            &PersistedEntry {
                key: "workmode:translate?paragraph=17".into(),
                response: "第 17 段的翻译……".into(),
                saved_at: 1000,
            },
        )
        .unwrap();
        append_entry(
            &p,
            &PersistedEntry {
                key: "workmode:translate?paragraph=18".into(),
                response: "第 18 段的翻译……".into(),
                saved_at: 1001,
            },
        )
        .unwrap();
        let loaded = load_entries(&p).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].key, "workmode:translate?paragraph=17");
        assert_eq!(loaded[1].response, "第 18 段的翻译……");
        let _ = std::fs::remove_file(&p);
    }

    /// 崩溃安全：残缺的最后一行被跳过，其余条目完好。
    #[test]
    fn torn_last_line_is_skipped() {
        let p = tmp_path("torn");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            concat!(
                r#"{"key":"a","response":"完整条目","saved_at":1}"#,
                "\n",
                r#"{"key":"b","response":"被截断的行"#, // 崩溃时刻：没有闭合
            ),
        )
        .unwrap();
        let loaded = load_entries(&p).unwrap();
        assert_eq!(loaded.len(), 1, "残缺行应被跳过");
        assert_eq!(loaded[0].key, "a");
        let _ = std::fs::remove_file(&p);
    }

    /// 同键多次写入取 saved_at 最新（重新生成覆盖旧产物的场景）。
    #[test]
    fn same_key_takes_latest() {
        let p = tmp_path("latest");
        let _ = std::fs::remove_file(&p);
        append_entry(&p, &PersistedEntry { key: "k".into(), response: "旧".into(), saved_at: 1 }).unwrap();
        append_entry(&p, &PersistedEntry { key: "k".into(), response: "新".into(), saved_at: 2 }).unwrap();
        let loaded = load_entries(&p).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].response, "新");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_loads_empty() {
        let p = tmp_path("nonexistent-should-not-exist");
        let _ = std::fs::remove_file(&p);
        assert!(load_entries(&p).unwrap().is_empty());
    }
}
