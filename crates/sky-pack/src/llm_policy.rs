//! 领域级 LLM 行为约束（LlmPolicy）——「harness 驯化 LLM」的声明层。
//!
//! **用户裁定**（2026-10-18）：限于训练与蒸馏，LLM 直连缺陷多，领域必须能
//! 约束它。本结构把「约束」变成数据：领域包/任务书声明 policy，
//! `llm_generate` 执行时应用——参数收紧（maxTokens/temperature）+ 产出校验
//! （禁词命中拒、必含要素缺失拒）。
//!
//! **为什么校验在 harness 侧而非提示词里**：提示词是「请求」，模型可以不听；
//! harness 侧的产出校验是「闸门」，不听就打回。驯化 = 闸门，不是恳求。

use serde::{Deserialize, Serialize};

/// 领域级 LLM 约束。全部字段可选——未声明即用系统默认（不收紧）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LlmPolicy {
    /// 产出上限（token）。领域收得比系统默认（1200）更紧。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// 采样温度。领域要求更确定时收紧（如法务 0.1）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// 禁词表：产出含任一即拒绝（fail-closed）。如化学领域禁「大概」「可能有毒」类含糊表述。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbidden_terms: Vec<String>,
    /// 必含要素：产出缺任一即拒绝。如「必须含『参考文献』」。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_terms: Vec<String>,
}

impl LlmPolicy {
    /// 有效的 maxTokens：policy 优先，否则系统默认。
    pub fn effective_max_tokens(&self, system_default: u32) -> u32 {
        self.max_tokens.unwrap_or(system_default)
    }

    /// 有效的温度：policy 优先，否则系统默认；并夹到 [0.0, 2.0] 合法区间。
    pub fn effective_temperature(&self, system_default: f32) -> f32 {
        let t = self.temperature.unwrap_or(system_default);
        t.clamp(0.0, 2.0)
    }

    /// 产出校验。返回 Err 即拒绝（含人话理由）。
    ///
    /// 顺序：禁词（命中即拒）→ 必含（缺失即拒）。
    pub fn check_output(&self, output: &str) -> Result<String, String> {
        for term in &self.forbidden_terms {
            if !term.is_empty() && output.contains(term.as_str()) {
                return Err(format!(
                    "LlmPolicy 拒绝：产出含领域禁词「{term}」。请重新生成或调整措辞。"
                ));
            }
        }
        let missing: Vec<&String> = self
            .required_terms
            .iter()
            .filter(|t| !t.is_empty() && !output.contains(t.as_str()))
            .collect();
        if !missing.is_empty() {
            let names: Vec<String> = missing.iter().map(|s| s.to_string()).collect();
            return Err(format!(
                "LlmPolicy 拒绝：产出缺少领域必含要素（{}）。",
                names.join("、")
            ));
        }
        Ok(output.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_policy_uses_system_defaults() {
        let p = LlmPolicy::default();
        assert_eq!(p.effective_max_tokens(1200), 1200);
        assert_eq!(p.effective_temperature(0.2), 0.2);
        let out = p.check_output("任何产出").unwrap();
        assert_eq!(out, "任何产出");
    }

    #[test]
    fn policy_overrides_parameters() {
        let p = LlmPolicy {
            max_tokens: Some(500),
            temperature: Some(0.1),
            ..Default::default()
        };
        assert_eq!(p.effective_max_tokens(1200), 500);
        assert_eq!(p.effective_temperature(0.2), 0.1);
    }

    /// 温度非法值夹到合法区间——领域声明错不炸请求。
    #[test]
    fn temperature_clamped_to_valid_range() {
        let p = LlmPolicy {
            temperature: Some(99.0),
            ..Default::default()
        };
        assert_eq!(p.effective_temperature(0.2), 2.0);
        let p2 = LlmPolicy {
            temperature: Some(-1.0),
            ..Default::default()
        };
        assert_eq!(p2.effective_temperature(0.2), 0.0);
    }

    #[test]
    fn forbidden_term_rejects_output() {
        let p = LlmPolicy {
            forbidden_terms: vec!["大概".into(), "可能有毒".into()],
            ..Default::default()
        };
        let err = p.check_output("这个化合物大概是无害的").unwrap_err();
        assert!(err.contains("大概"), "{err}");
        assert!(err.contains("禁词"), "{err}");
        // 洁净产出放行
        assert!(p.check_output("该化合物经检测无害").is_ok());
    }

    #[test]
    fn missing_required_term_rejects_output() {
        let p = LlmPolicy {
            required_terms: vec!["参考文献".into()],
            ..Default::default()
        };
        let err = p.check_output("答案是无色晶体").unwrap_err();
        assert!(err.contains("参考文献"), "{err}");
        assert!(err.contains("必含"), "{err}");
        assert!(p.check_output("答案是无色晶体（参考文献[1]）").is_ok());
    }

    /// 空串禁词/必含不生效——防领域声明失误把一切产出拒掉。
    #[test]
    fn empty_terms_are_ignored() {
        let p = LlmPolicy {
            forbidden_terms: vec!["".into()],
            required_terms: vec!["".into()],
            ..Default::default()
        };
        assert!(p.check_output("任何产出").is_ok());
    }

    /// JSON 反序列化：任务书/pack 声明形态。
    #[test]
    fn deserializes_from_manifest_json() {
        let p: LlmPolicy = serde_json::from_str(
            r#"{"max_tokens": 500, "forbidden_terms": ["大概"], "required_terms": ["参考文献"]}"#,
        )
        .unwrap();
        assert_eq!(p.max_tokens, Some(500));
        assert_eq!(p.forbidden_terms, vec!["大概".to_string()]);
        assert!(p.temperature.is_none());
    }
}
