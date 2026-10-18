//! 工作台模式（WorkMode）——领域包 UI 的规范化动作层。
//!
//! **为什么需要**（95 册 §9.7 裁定）：chat 模式下用户每次换措辞
//! （「翻一下这段」「这段什么意思」）→ 缓存键全不同，是缓存地狱；
//! 工作台模式下点按钮发出的是**规范化动作 + 槽位参数**，键完全可预测——
//! UI 化让命中率升高而不是降低。本模块把这件事变成代码契约。
//!
//! 动作键形态：`workmode:<action>?<slot>=<value>&...`（slot 按名字字典序，
//! 同一动作同一文档状态永远生成同一键 → RouteCache / FingerprintCache 直接命中）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 工作台动作：UI 按钮 → 引擎的一次规范化调用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkAction {
    /// 动作名（如 `translate_paragraph` / `ask_paper` / `check_risk`）。
    pub action: String,
    /// 槽位参数（如 `paragraph=17`、`lang_target=en`、`doc=f1.pdf`）。
    #[serde(default)]
    pub slots: BTreeMap<String, String>,
}

impl WorkAction {
    pub fn new(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            slots: BTreeMap::new(),
        }
    }

    pub fn slot(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.slots.insert(name.into(), value.into());
        self
    }

    /// 规范化动作键。
    ///
    /// **契约**：同一动作 + 同一槽位值 ⇒ 同一键，与构造顺序无关
    /// （BTreeMap 字典序保证）。这是「UI 化提高缓存命中率」的兑现点：
    /// 键可预测 ⇒ RouteCache / FingerprintCache 必命中。
    pub fn canonical_key(&self) -> String {
        if self.slots.is_empty() {
            return format!("workmode:{}", self.action);
        }
        let query: Vec<String> = self
            .slots
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        format!("workmode:{}?{}", self.action, query.join("&"))
    }
}

/// 一个领域包的工作台声明：这个领域在 UI 里有哪些规范化动作。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkMode {
    pub pack_id: String,
    pub actions: Vec<WorkAction>,
}

impl WorkMode {
    pub fn new(pack_id: impl Into<String>) -> Self {
        Self {
            pack_id: pack_id.into(),
            actions: vec![],
        }
    }

    pub fn action(mut self, action: WorkAction) -> Self {
        self.actions.push(action);
        self
    }

    /// 按名字查动作模板（供 UI 渲染按钮 / 校验调用合法性）。
    pub fn get(&self, action: &str) -> Option<&WorkAction> {
        self.actions.iter().find(|a| a.action == action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 核心契约：同一动作同一槽位值 → 同一键，与构造顺序无关。
    #[test]
    fn canonical_key_is_order_independent() {
        let a = WorkAction::new("translate_paragraph").slot("paragraph", "17");
        let b = WorkAction::new("translate_paragraph").slot("paragraph", "17");
        assert_eq!(a.canonical_key(), b.canonical_key());
        assert_eq!(a.canonical_key(), "workmode:translate_paragraph?paragraph=17");
    }

    #[test]
    fn multi_slot_sorted_deterministically() {
        let a = WorkAction::new("ask")
            .slot("b", "2")
            .slot("a", "1")
            .slot("c", "3");
        let b = WorkAction::new("ask")
            .slot("c", "3")
            .slot("a", "1")
            .slot("b", "2");
        assert_eq!(a.canonical_key(), b.canonical_key());
        assert_eq!(a.canonical_key(), "workmode:ask?a=1&b=2&c=3");
    }

    #[test]
    fn different_slot_values_produce_different_keys() {
        let a = WorkAction::new("translate_paragraph").slot("paragraph", "17");
        let b = WorkAction::new("translate_paragraph").slot("paragraph", "18");
        assert_ne!(a.canonical_key(), b.canonical_key());
    }

    #[test]
    fn no_slots_produces_bare_key() {
        assert_eq!(
            WorkAction::new("start_tour").canonical_key(),
            "workmode:start_tour"
        );
    }

    #[test]
    fn workmode_registers_and_looks_up_actions() {
        let wm = WorkMode::new("paper-reader")
            .action(WorkAction::new("translate_paragraph"))
            .action(WorkAction::new("ask_paper"));
        assert_eq!(wm.actions.len(), 2);
        assert!(wm.get("translate_paragraph").is_some());
        assert!(wm.get("nonexistent").is_none());
    }
}
