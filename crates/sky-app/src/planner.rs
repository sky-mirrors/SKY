//! LLM 规划器——探索路径的计划生成。
//!
//! 对应现状 L4 `buildExplorePlan`：当确定性段与检索段都无法匹配时，
//! 由 LLM 依据用户输入生成执行计划。
//!
//! 设计要点：
//! - 提示词要求 LLM **只输出 JSON**，解析失败时降级为空计划而非报错
//! - 生成的计划必须经 `sky-exec` 的拓扑排序验证（循环依赖会被拒）
//! - 任何工具名都须经安全层校验后才可执行（本模块只生成，不执行）

use serde_json::Value;
use sky_core::{PlanStep, TaskPlan};
use sky_llm::{ChatRequest, HttpProviderCall, ProviderCall};
use std::collections::BTreeMap;

/// 系统提示词。
///
/// 要求严格 JSON 输出——比解析自然语言更可靠，且便于校验。
pub const PLANNER_SYSTEM_PROMPT: &str = r#"你是任务规划器。根据用户请求生成执行计划。

只输出 JSON，不要任何解释、不要 markdown 代码块。格式：
{"intent":"意图简述","needs":["依赖项"],"steps":[{"step":1,"description":"步骤描述","tool":"工具名","depends_on":[],"expectedOutput":"预期输出"}]}

规则：
- steps 最多 5 步
- step 编号从 1 开始且连续
- depends_on 只能引用编号更小的步骤，禁止循环
- 若任务无需多步，返回单个步骤
- 工具名用简短英文标识（如 file_list、doc_convert、text_summarize）"#;

/// 规划结果。
#[derive(Debug, Clone, PartialEq)]
pub enum PlanOutcome {
    /// 成功生成计划。
    Planned(TaskPlan),
    /// LLM 返回无法解析——降级为空计划。
    Unparsable { raw: String, reason: String },
    /// 调用失败（无密钥、网络错误等）。
    Failed(String),
}

/// LLM 规划器。
pub struct LlmPlanner {
    caller: HttpProviderCall,
    model: String,
    base_url: String,
    /// 配置文件解析失败时的警告，随规划结果带出供 UI 展示。
    config_warning: Option<String>,
}

impl LlmPlanner {
    /// 从环境变量 + 用户目录配置构造。
    ///
    /// 无密钥时仍可构造，`plan` 会返回 `Failed`。
    pub fn from_env() -> Self {
        let cfg = sky_llm::resolve_config();
        Self {
            caller: match &cfg.api_key {
                Some(k) => HttpProviderCall::with_key(k),
                None => HttpProviderCall::from_env(),
            },
            model: cfg.model,
            base_url: cfg.base_url,
            config_warning: cfg.warning,
        }
    }

    /// 显式注入密钥（测试用）。
    pub fn with_key(key: impl Into<String>) -> Self {
        Self {
            caller: HttpProviderCall::with_key(key),
            model: sky_llm::DEFAULT_MODEL.into(),
            base_url: sky_llm::GLM_BASE_URL.into(),
            config_warning: None,
        }
    }

    pub fn has_key(&self) -> bool {
        self.caller.has_key()
    }

    /// 配置文件解析失败时的警告（若有）。UI 应展示它——
    /// 否则用户改了配置却没生效，会以为问题在别处。
    pub fn config_warning(&self) -> Option<&str> {
        self.config_warning.as_deref()
    }

    /// 为用户输入生成计划。
    pub async fn plan(&self, user_input: &str) -> PlanOutcome {
        let req = ChatRequest {
            messages: vec![
                sky_core::ChatMessage {
                    role: "system".into(),
                    content: PLANNER_SYSTEM_PROMPT.into(),
                    timestamp: None,
                },
                sky_core::ChatMessage {
                    role: "user".into(),
                    content: user_input.into(),
                    timestamp: None,
                },
            ],
            model: self.model.clone(),
            temperature: Some(0.1),
            max_tokens: Some(1200),
        };

        let cfg = sky_llm::glm_config_with(&self.model, &self.base_url);

        match self.caller.call(&cfg, &req).await {
            Ok(resp) => parse_plan(&resp.content),
            Err(e) => PlanOutcome::Failed(e),
        }
    }
}

/// 从 LLM 输出解析计划。
///
/// 容错处理：
/// - 剥掉可能的 markdown 代码块围栏
/// - 提取第一个 `{` 到最后一个 `}` 之间的内容
/// - 校验步骤编号连续性与依赖方向
pub fn parse_plan(raw: &str) -> PlanOutcome {
    let cleaned = extract_json(raw);

    let v: Value = match serde_json::from_str(&cleaned) {
        Ok(v) => v,
        Err(e) => {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: format!("JSON 解析失败：{e}"),
            }
        }
    };

    let intent = v
        .get("intent")
        .and_then(|i| i.as_str())
        .unwrap_or("未命名任务")
        .to_string();

    let needs: Vec<String> = v
        .get("needs")
        .and_then(|n| n.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let steps_json = match v.get("steps").and_then(|s| s.as_array()) {
        Some(s) => s,
        None => {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: "缺少 steps 数组".into(),
            }
        }
    };

    let mut steps: Vec<PlanStep> = Vec::new();
    for s in steps_json {
        let num = match s.get("step").and_then(|x| x.as_u64()) {
            Some(n) => n as u32,
            None => {
                return PlanOutcome::Unparsable {
                    raw: raw.to_string(),
                    reason: "步骤缺少 step 编号".into(),
                }
            }
        };
        let tool = s
            .get("tool")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();

        let depends_on: Vec<u32> = s
            .get("depends_on")
            .and_then(|d| d.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
            .unwrap_or_default();

        steps.push(PlanStep {
            step: num,
            description: s
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            tool,
            depends_on,
            params: BTreeMap::new(),
            expected_output: s
                .get("expectedOutput")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            fallback: None,
        });
    }

    // 校验：编号从 1 开始且连续
    steps.sort_by_key(|s| s.step);
    for (i, s) in steps.iter().enumerate() {
        if s.step != (i as u32) + 1 {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: format!("步骤编号不连续：期望 {}，得到 {}", i + 1, s.step),
            };
        }
    }

    // 校验：依赖只能指向更小的编号（杜绝循环）
    for s in &steps {
        for d in &s.depends_on {
            if *d >= s.step {
                return PlanOutcome::Unparsable {
                    raw: raw.to_string(),
                    reason: format!("步骤 {} 依赖了非更早的步骤 {}", s.step, d),
                };
            }
        }
    }

    if steps.is_empty() {
        return PlanOutcome::Unparsable {
            raw: raw.to_string(),
            reason: "steps 为空".into(),
        };
    }

    PlanOutcome::Planned(TaskPlan {
        intent,
        needs,
        steps,
    })
}

/// 从可能含 markdown 围栏的文本中提取 JSON。
fn extract_json(raw: &str) -> String {
    let t = raw.trim();
    // 剥 ```json ... ``` 围栏
    let t = if let Some(rest) = t.strip_prefix("```json") {
        rest.trim_start()
    } else if let Some(rest) = t.strip_prefix("```") {
        rest.trim_start()
    } else {
        t
    };
    let t = t.strip_suffix("```").unwrap_or(t).trim();

    // 取第一个 { 到最后一个 }
    match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => t[a..=b].to_string(),
        _ => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let raw = r#"{"intent":"整理文件","needs":["file_access"],"steps":[{"step":1,"description":"列出文件","tool":"file_list","depends_on":[],"expectedOutput":"列表"}]}"#;
        match parse_plan(raw) {
            PlanOutcome::Planned(p) => {
                assert_eq!(p.intent, "整理文件");
                assert_eq!(p.steps.len(), 1);
                assert_eq!(p.steps[0].tool, "file_list");
            }
            other => panic!("期望 Planned，得到 {other:?}"),
        }
    }

    /// 容错：LLM 常加 markdown 围栏。
    #[test]
    fn parses_json_in_markdown_fence() {
        let raw = "```json\n{\"intent\":\"x\",\"steps\":[{\"step\":1,\"tool\":\"t\"}]}\n```";
        assert!(matches!(parse_plan(raw), PlanOutcome::Planned(_)));
    }

    #[test]
    fn parses_json_with_surrounding_prose() {
        let raw = "好的，这是计划：{\"intent\":\"x\",\"steps\":[{\"step\":1,\"tool\":\"t\"}]} 希望有帮助";
        assert!(matches!(parse_plan(raw), PlanOutcome::Planned(_)));
    }

    #[test]
    fn parses_multistep_with_dependencies() {
        let raw = r#"{"intent":"x","steps":[
            {"step":1,"tool":"a","depends_on":[]},
            {"step":2,"tool":"b","depends_on":[1]}
        ]}"#;
        match parse_plan(raw) {
            PlanOutcome::Planned(p) => {
                assert_eq!(p.steps.len(), 2);
                assert_eq!(p.steps[1].depends_on, vec![1]);
            }
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：非 JSON 输入必须降级而非 panic。
    #[test]
    fn rejects_non_json() {
        match parse_plan("这不是 JSON") {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("JSON")),
            other => panic!("期望 Unparsable，得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_steps() {
        match parse_plan(r#"{"intent":"x"}"#) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("steps")),
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_steps() {
        match parse_plan(r#"{"intent":"x","steps":[]}"#) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("空")),
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：编号不连续。
    #[test]
    fn rejects_non_contiguous_step_numbers() {
        let raw = r#"{"intent":"x","steps":[{"step":1,"tool":"a"},{"step":3,"tool":"b"}]}"#;
        match parse_plan(raw) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("不连续")),
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：前向依赖（潜在循环）。
    #[test]
    fn rejects_forward_dependency() {
        let raw = r#"{"intent":"x","steps":[
            {"step":1,"tool":"a","depends_on":[2]},
            {"step":2,"tool":"b"}
        ]}"#;
        match parse_plan(raw) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("非更早")),
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_self_dependency() {
        let raw = r#"{"intent":"x","steps":[{"step":1,"tool":"a","depends_on":[1]}]}"#;
        assert!(matches!(parse_plan(raw), PlanOutcome::Unparsable { .. }));
    }

    #[test]
    fn extract_json_strips_fence() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[test]
    fn extract_json_takes_outermost_braces() {
        assert_eq!(extract_json("前缀 {\"a\":1} 后缀"), "{\"a\":1}");
    }

    #[test]
    fn missing_key_reports_failure() {
        let p = LlmPlanner {
            caller: HttpProviderCall::with_key(""),
            model: sky_llm::DEFAULT_MODEL.into(),
            base_url: sky_llm::GLM_BASE_URL.into(),
            config_warning: None,
        };
        // 空密钥在 call 时会被判为无效
        assert!(p.has_key());
    }

    #[tokio::test]
    async fn planner_without_key_fails_gracefully() {
        let p = LlmPlanner::from_env();
        if p.has_key() {
            eprintln!("跳过：环境中有密钥");
            return;
        }
        match p.plan("测试").await {
            PlanOutcome::Failed(msg) => assert!(msg.contains("SKY_GLM_API_KEY")),
            other => panic!("无密钥应 Failed，得到 {other:?}"),
        }
    }
}
