//! SKY 核心领域模型。
//!
//! 逐字对齐现状 TypeScript 定义（`src/models/index.ts`），字段名保持一致，
//! 以便重建期对照阅读。
//!
//! 锚点对照：
//! - `TaskPlan`            ← `src/models/index.ts:375`
//! - `ModelTier`           ← `src/models/index.ts:1166`
//! - `DetectedDomain`      ← `src/models/index.ts:891`
//! - `ChatMessage`         ← `src/models/index.ts:183`
//! - `L2DagStep`           ← `src/models/index.ts:708`

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 模型档位。对应 `src/models/index.ts:1166`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Nano,
    Mini,
    Standard,
    Pro,
}

/// 检测到的领域。对应 `src/models/index.ts:891`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedDomain {
    Legal,
    Finance,
    Geotech,
    General,
}

/// 任务复杂度。对应 `src/kernel/types.ts:61`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskComplexity {
    Trivial,
    Simple,
    Moderate,
    Complex,
}

/// 预算模式。对应 `src/models/index.ts:1170`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetMode {
    Zero,
    Economy,
    Standard,
}

/// 计划步骤。对应 `src/models/index.ts:378-386` 的匿名内联类型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanStep {
    pub step: u32,
    pub description: String,
    pub tool: String,
    #[serde(default)]
    pub depends_on: Vec<u32>,
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
    #[serde(rename = "expectedOutput", default)]
    pub expected_output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

/// 任务计划。对应 `src/models/index.ts:375-387`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskPlan {
    pub intent: String,
    #[serde(default)]
    pub needs: Vec<String>,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
}

impl TaskPlan {
    /// 计划中是否含 shell 执行步骤。
    /// 对应 `src/kernel/funnel.ts:104-106` 的 `planContainsShellExec`。
    pub fn contains_shell_exec(&self) -> bool {
        self.steps.iter().any(|s| s.tool == "shell_exec")
    }
}

/// 会话消息。对应 `src/models/index.ts:183`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}

/// 路由输入。对应 `src/kernel/types.ts:65-73`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RouteInput {
    pub text: String,
    #[serde(rename = "taskType", default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(rename = "callerId", default, skip_serializing_if = "Option::is_none")]
    pub caller_id: Option<String>,
    #[serde(
        rename = "historicalTokenAvg",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub historical_token_avg: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(
        rename = "manifestMaxTier",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub manifest_max_tier: Option<ModelTier>,
}

/// 路由结果。对应 `src/kernel/types.ts:75-86`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteResult {
    pub tier: ModelTier,
    pub complexity: TaskComplexity,
    pub reason: String,
    pub confidence: f32,
    #[serde(rename = "estimatedTokens")]
    pub estimated_tokens: u64,
    #[serde(rename = "estimatedCost")]
    pub estimated_cost: f64,
    #[serde(rename = "budgetCapped")]
    pub budget_capped: bool,
    #[serde(rename = "budgetAllowed")]
    pub budget_allowed: bool,
    #[serde(rename = "budgetRecommendedTier")]
    pub budget_recommended_tier: ModelTier,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_plan_roundtrip_preserves_all_fields() {
        let plan = TaskPlan {
            intent: "整理桌面图片".into(),
            needs: vec!["file_listing".into()],
            steps: vec![PlanStep {
                step: 1,
                description: "列出桌面图片".into(),
                tool: "file_listing".into(),
                depends_on: vec![],
                params: BTreeMap::new(),
                expected_output: "图片列表".into(),
                fallback: Some("改用 shell".into()),
            }],
        };

        let json = serde_json::to_string(&plan).expect("serialize");
        // 字段名必须与 TS 侧一致：expectedOutput 为驼峰
        assert!(json.contains("\"expectedOutput\""), "json = {json}");
        assert!(!json.contains("expected_output"), "json = {json}");

        let back: TaskPlan = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(plan, back);
    }

    #[test]
    fn contains_shell_exec_detects_shell_tool() {
        let mut plan = TaskPlan {
            intent: "x".into(),
            needs: vec![],
            steps: vec![],
        };
        assert!(!plan.contains_shell_exec());

        plan.steps.push(PlanStep {
            step: 1,
            description: "跑命令".into(),
            tool: "shell_exec".into(),
            depends_on: vec![],
            params: BTreeMap::new(),
            expected_output: String::new(),
            fallback: None,
        });
        assert!(plan.contains_shell_exec());
    }

    #[test]
    fn model_tier_serializes_lowercase() {
        let json = serde_json::to_string(&ModelTier::Standard).expect("serialize");
        assert_eq!(json, "\"standard\"");
    }

    #[test]
    fn detected_domain_serializes_lowercase() {
        let json = serde_json::to_string(&DetectedDomain::Geotech).expect("serialize");
        assert_eq!(json, "\"geotech\"");
    }

    #[test]
    fn task_plan_tolerates_missing_optional_fields() {
        // 旧数据可能缺 needs/steps/fallback——必须能反序列化
        let json = r#"{"intent":"仅意图"}"#;
        let plan: TaskPlan = serde_json::from_str(json).expect("deserialize");
        assert_eq!(plan.intent, "仅意图");
        assert!(plan.needs.is_empty());
        assert!(plan.steps.is_empty());
    }
}
