//! 端口契约。
//!
//! 对应现状 `src/kernel/types.ts` 的三个 Port：
//! - `PersistencePort` ← `src/kernel/types.ts:214`（4 方法）
//! - `IOPort`          ← `src/kernel/types.ts:221`（30 方法）
//! - `LLMPort`         ← `src/kernel/types.ts:180`（3 方法）
//!
//! 外加 `UiBridge`——承接现状 core 反向调用 UI 的需求
//! （`bus.request('dialog:confirm-risk')`，见 `src/domains/dialog/handlers.ts:12`）。

use crate::model::ModelTier;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// shell 执行结果。对应 `IOPort.shellExec` 返回形状。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShellOut {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// 持久化端口。对应 `src/kernel/types.ts:214-219`。
pub trait Persistence: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str);
    fn delete(&self, key: &str);
    fn keys(&self) -> Vec<String>;
}

/// 写操作授权裁决。对应 `src/services/writeGate.ts:22`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteDecision {
    Deny,
    Once,
    Always,
}

/// 写操作请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteRequest {
    pub tool_name: String,
    pub operation: String,
    pub target: String,
}

/// IO 端口。对应 `src/kernel/types.ts:221`（30 个方法）。
///
/// 首版只声明执行与路由必需的核心方法；其余按 Wave 4/5 逐步补齐。
/// 未声明的方法不是遗漏——它们属于 `sky-store` 与 `sky-exec` 的实现细节，
/// 不应污染核心契约。
#[async_trait]
pub trait Io: Send + Sync {
    async fn store_read(&self, key: &str) -> Option<String>;
    async fn store_write(&self, key: &str, value: &str);
    async fn store_delete(&self, key: &str);
    async fn shell_exec(&self, command: &str, cwd: Option<&Path>) -> Result<ShellOut, String>;
    async fn file_read(&self, path: &Path) -> Option<String>;
    async fn file_write(&self, path: &Path, content: &str) -> bool;
    async fn create_directory(&self, path: &Path) -> bool;
    fn platform(&self) -> String;
    fn version(&self) -> String;
    fn user_data_path(&self) -> String;
}

/// LLM 端口。对应 `src/kernel/types.ts:180-188`。
#[async_trait]
pub trait Llm: Send + Sync {
    async fn chat_completion(&self, messages: &[crate::model::ChatMessage], tier: ModelTier)
        -> Result<String, String>;
    async fn list_models(&self) -> Result<Vec<String>, String>;
}

/// UI 桥接端口——core 反向请求 UI 裁决。
///
/// 对应现状：
/// - `dialog:confirm-risk`      → `confirm_risk`
/// - `dialog:confirm-write`     → `confirm_write`
/// - `dialog:request-takeover`  → `request_takeover`
///
/// 所有实现失败路径必须 fail-closed（超时/异常 → 拒绝）。
#[async_trait]
pub trait UiBridge: Send + Sync {
    /// 风险确认。超时必须返回 false。
    async fn confirm_risk(&self, manifest: &str) -> bool;

    /// 写操作授权。超时必须返回 `WriteDecision::Deny`。
    async fn confirm_write(&self, req: &WriteRequest) -> WriteDecision;

    /// 人工接管。超时返回空串。
    async fn request_takeover(&self, step: u32) -> String;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemPersistence(std::sync::Mutex<std::collections::HashMap<String, String>>);

    impl Persistence for MemPersistence {
        fn get(&self, key: &str) -> Option<String> {
            self.0.lock().unwrap().get(key).cloned()
        }
        fn set(&self, key: &str, value: &str) {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
        }
        fn delete(&self, key: &str) {
            self.0.lock().unwrap().remove(key);
        }
        fn keys(&self) -> Vec<String> {
            self.0.lock().unwrap().keys().cloned().collect()
        }
    }

    #[test]
    fn persistence_roundtrip() {
        let p = MemPersistence(Default::default());
        assert_eq!(p.get("k"), None);
        p.set("k", "v");
        assert_eq!(p.get("k"), Some("v".into()));
        assert_eq!(p.keys(), vec!["k".to_string()]);
        p.delete("k");
        assert_eq!(p.get("k"), None);
    }

    #[test]
    fn write_decision_serializes_lowercase() {
        let json = serde_json::to_string(&WriteDecision::Always).expect("serialize");
        assert_eq!(json, "\"always\"");
    }

    #[test]
    fn write_decision_deserializes_all_variants() {
        for (s, want) in [
            ("\"deny\"", WriteDecision::Deny),
            ("\"once\"", WriteDecision::Once),
            ("\"always\"", WriteDecision::Always),
        ] {
            let got: WriteDecision = serde_json::from_str(s).expect("deserialize");
            assert_eq!(got, want);
        }
    }
}
