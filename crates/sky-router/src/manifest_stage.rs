//! 任务书匹配与计划展开（第五段路由的第一段业务匹配）。
//!
//! **它在路由链中的位置**：`Cache → Manifest → Deterministic → Retrieval → Explore`。
//!
//! 为什么在 `Deterministic` 之前：任务书比单条关键词规则更具体（多步、带参数槽位）。
//! 例：「把文档转成 PDF」既命中 `doc-to-pdf` 硬编码规则（单步、params 恒空、必然失败），
//! 也命中带源文件槽位的任务书（能真正执行）。后者优先才符合用户预期。
//!
//! 为什么在 `Cache` 之后：缓存命中是最省的（0 计算），优先级最高。
//!
//! **本段是「路由降级」的实际执行者**：命中即产出完整 `TaskPlan`，
//! 完全不调 LLM 规划器。任务书内多数叶节点是确定性工具，只有 `llm_generate`
//! 这类语义节点消耗 token。

use crate::normalize::normalize;
use crate::stage::{Route, RouteCtx, Stage};
use async_trait::async_trait;
use sky_core::{L2Manifest, PlanStep, RouteInput, Slot, TaskPlan};
use std::collections::BTreeMap;

/// 任务书路由段。
pub struct ManifestStage {
    manifests: Vec<L2Manifest>,
    min_confidence: f32,
}

/// 关键词命中率的最低门槛。
///
/// 为什么是 1/3 而不是更高：任务书的关键词是**同义说法集合**
/// （「周报」「工作总结」「汇报」「本周」都是同一意图的不同说法），
/// 用户通常只会说出其中一两个。阈值过高会让任务书形同虚设；
/// 过低会误命中。1/3 是保守起点，Wave 4 用真实输入校准。
const MIN_KEYWORD_RATIO: f32 = 0.34;

impl ManifestStage {
    /// 用给定任务书构造。
    pub fn new(manifests: Vec<L2Manifest>) -> Self {
        Self {
            manifests,
            min_confidence: 0.85,
        }
    }

    /// 用内置 20 份任务书构造。
    ///
    /// 加载失败的任务书不会进入匹配集——但调用方应检查
    /// `sky_core::load_builtin().warning()` 并展示给用户。
    pub fn with_builtin() -> Self {
        let load = sky_core::load_builtin();
        Self::new(load.manifests().to_vec())
    }

    /// 调整最低置信度。
    pub fn with_min_confidence(mut self, c: f32) -> Self {
        self.min_confidence = c;
        self
    }

    /// 找出命中的任务书。
    ///
    /// **匹配策略：命中率而非全命中**（实测修正）。
    ///
    /// 最初按「所有 keywords 都命中」实现，实测发现对多关键词任务书不可用：
    /// 周报任务书的 keywords 是 `['周报','工作总结','汇报','本周','草稿']`，
    /// 用户说「写份本周周报」只命中 2/5，永远匹配不上——任务书形同虚设。
    ///
    /// 改为「命中率 ≥ 阈值」：`hits / keywords.len() >= min_ratio`。
    /// 关键词越多越难达标，这与 `DeterministicStage` 的规则匹配（要求全命中）
    /// 不同——任务书的关键词是**同义说法集合**，不是必须同时出现的约束。
    ///
    /// 排序：命中率优先，同率时关键词多者优先（更具体）。
    fn best_match(&self, text: &str) -> Option<(&L2Manifest, f32)> {
        let norm = normalize(text);
        if norm.trim().is_empty() {
            return None;
        }

        let mut scored: Vec<(&L2Manifest, usize, usize)> = self
            .manifests
            .iter()
            .filter_map(|m| {
                let total = m.routing.keywords.len();
                if total == 0 {
                    return None;
                }
                let hits = m
                    .routing
                    .keywords
                    .iter()
                    .filter(|k| norm.contains(&normalize(k)))
                    .count();
                if hits == 0 {
                    return None;
                }
                Some((m, hits, total))
            })
            .collect();

        // 命中率降序；同率时关键词总数降序（更具体的优先）
        scored.sort_by(|a, b| {
            let ra = a.1 as f32 / a.2 as f32;
            let rb = b.1 as f32 / b.2 as f32;
            rb.partial_cmp(&ra)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.2.cmp(&a.2))
        });

        let (m, hits, total) = *scored.first()?;
        let ratio = hits as f32 / total as f32;

        // 过门：至少命中 1/3 的关键词。低于此视为噪声。
        if ratio < MIN_KEYWORD_RATIO {
            return None;
        }

        // 置信度映射到 [0.85, 1.0]：过门即 0.85，全命中 1.0。
        let confidence = 0.85 + 0.15 * ratio;
        Some((m, confidence))
    }
}

/// 展开结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ExpandOutcome {
    /// 成功展开为可执行计划。
    Plan { plan: TaskPlan, confidence: f32 },
    /// 必填槽位缺失——返回缺口计划，明确告知用户缺什么。
    ///
    /// **不降级为空值执行**：静默用空参数会做错事还报成功。
    /// 这与 `file_list` 缺 `dir` 的历史教训一致。
    MissingSlots {
        manifest_name: String,
        missing: Vec<String>,
    },
}

/// 该槽位是否由宿主（执行期）提供，而非用户输入。
///
/// `source = context` 表示「运行环境提供」——如 `{{workspace_dir}}` 由宿主
/// 注入当前工作区路径。路由期不该要求用户给出，否则任务书永远返回缺口。
pub fn slot_is_host_supplied(slot: &Slot) -> bool {
    matches!(slot.source.as_str(), "context" | "host" | "runtime")
}

/// 判断一个占位符是否是「宿主槽位」（待执行期注入）。
///
/// 形如 `{{workspace_dir}}` 且不是上游引用。这类占位符在展开后仍留在
/// 参数里，由执行器在运行前替换成真实值（如当前工作区路径）。
pub fn is_host_slot(placeholder: &str) -> bool {
    let inner = placeholder
        .trim_start_matches("{{")
        .trim_end_matches("}}")
        .trim();
    !inner.is_empty() && !is_upstream_ref(placeholder)
}

/// 从用户输入里抽出的槽位值。
type SlotValues = BTreeMap<String, String>;

/// 输出槽位值：按 `paramMapping.slots[].source` 决定来源。
fn extract_slots(manifest: &L2Manifest, input: &str) -> SlotValues {
    let mut values = SlotValues::new();

    let slots: &[Slot] = manifest
        .execution
        .param_mapping
        .as_ref()
        .map(|pm| pm.slots.as_slice())
        .unwrap_or(&[]);

    for slot in slots {
        let key = slot.name.trim_matches(|c| c == '{' || c == '}').to_string();
        let value = match slot.source.as_str() {
            // 从输入里抽路径
            "file_path" | "path" | "file" => extract_first_path(input),
            // 整段输入当值
            "input_text" | "input" | "text" => Some(input.to_string()),
            // 未知来源：不猜，留空
            _ => None,
        };
        if let Some(v) = value {
            if !v.trim().is_empty() {
                values.insert(key, v);
            }
        }
    }

    values
}

/// 从文本里抽出第一个看起来像路径的片段。
///
/// 与 `crates/sky-app/src/planner.rs` 的 `extract_paths` 同思路，但更保守：
/// 只取第一个，且必须先剔除 URL 再按标点切分（中文标点不是空白字符，
/// 否则「/tmp/pics，然后统计」会成为一个片段）。
fn extract_first_path(text: &str) -> Option<String> {
    let without_urls: String = text
        .split_whitespace()
        .filter(|w| !w.contains("://"))
        .collect::<Vec<_>>()
        .join(" ");

    let normalized: String = without_urls
        .chars()
        .map(|c| {
            if matches!(
                c,
                '，' | '。' | '、' | '；' | '：' | '！' | '？' | ',' | ';' | ':' | '!' | '?'
                    | '"' | '\'' | '“' | '”' | '‘' | '’' | '（' | '）' | '(' | ')' | '【' | '】'
                    | '[' | ']' | '《' | '》' | '「' | '」'
            ) {
                ' '
            } else {
                c
            }
        })
        .collect();

    normalized
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| matches!(c, '.' | '。')))
        .find(|w| (w.contains('/') || w.contains('\\')) && w.chars().count() > 1)
        .map(|w| w.to_string())
}

/// 把槽位值渲染进一段字符串。
///
/// **只替换 `{{slot_name}}`，绝不碰 `{{step_N_result}}`**。
/// 后者是执行期占位符——路由期还没有结果，渲染成空串会让下游步骤
/// 拿到空输入却「成功」，这是本项目最容易做错的地方。
fn render_slots(text: &str, values: &SlotValues) -> String {
    let mut out = text.to_string();
    for (name, val) in values {
        out = out.replace(&format!("{{{{{name}}}}}"), val);
    }
    out
}

/// 判断一个占位符是否是「上游步骤结果」引用。
///
/// 形如 `{{step_2_result}}`。这类占位符必须原样保留到执行期。
pub fn is_upstream_ref(placeholder: &str) -> bool {
    let inner = placeholder
        .trim_start_matches("{{")
        .trim_end_matches("}}")
        .trim();
    inner.starts_with("step_") && inner.ends_with("_result")
}

/// 展开任务书为 `TaskPlan`。
pub fn expand(manifest: &L2Manifest, input: &str) -> ExpandOutcome {
    let values = extract_slots(manifest, input);

    // 必填槽位缺失 → 缺口计划。
    //
    // **`source = context` 的槽位不算缺失**：这类槽位（如 `{{workspace_dir}}`）
    // 由宿主在执行期注入（当前工作区路径），不该在路由期要求用户提供。
    // 实测发现：若把它们当必填，周报任务书永远只会返回缺口计划。
    let required: Vec<String> = manifest
        .execution
        .param_mapping
        .as_ref()
        .map(|pm| {
            pm.slots
                .iter()
                .filter(|s| s.required && !slot_is_host_supplied(s))
                .map(|s| s.name.clone())
                .collect()
        })
        .unwrap_or_default();

    let missing: Vec<String> = required
        .iter()
        .filter(|name| {
            let key = name.trim_matches(|c| c == '{' || c == '}');
            !values.contains_key(key)
        })
        .cloned()
        .collect();

    if !missing.is_empty() {
        return ExpandOutcome::MissingSlots {
            manifest_name: manifest.identity.name.clone(),
            missing,
        };
    }

    // macro 模式：把 dagPlan 转成 TaskPlan
    if let Some(dag) = &manifest.execution.dag_plan {
        let mut steps = Vec::new();
        for s in &dag.steps {
            let mut params = BTreeMap::new();
            for (k, v) in &s.params {
                params.insert(k.clone(), render_value(v, &values));
            }
            steps.push(PlanStep {
                step: s.step,
                description: s.description.clone(),
                tool: s.tool.clone(),
                depends_on: s.depends_on.clone(),
                params,
                expected_output: s.expected_output.clone().unwrap_or_default(),
                fallback: s.fallback.clone(),
            });
        }
        return ExpandOutcome::Plan {
            plan: TaskPlan {
                intent: manifest.identity.name.clone(),
                needs: manifest.routing.target_roles.clone(),
                steps,
            },
            confidence: 0.9,
        };
    }

    // direct 模式：单步 llm_generate
    if let Some(dc) = &manifest.execution.direct_call {
        let prompt = render_slots(&dc.prompt_template, &values);
        let mut params = BTreeMap::new();
        params.insert("prompt".to_string(), serde_json::Value::String(prompt));
        if let Some(mt) = dc.max_tokens {
            params.insert(
                "maxTokens".to_string(),
                serde_json::Value::Number(mt.into()),
            );
        }
        return ExpandOutcome::Plan {
            plan: TaskPlan {
                intent: manifest.identity.name.clone(),
                needs: manifest.routing.target_roles.clone(),
                steps: vec![PlanStep {
                    step: 1,
                    description: manifest.identity.name.clone(),
                    tool: "llm_generate".to_string(),
                    depends_on: vec![],
                    params,
                    expected_output: String::new(),
                    fallback: None,
                }],
            },
            confidence: 0.9,
        };
    }

    // 既无 dagPlan 也无 directCall——数据异常，返回缺口
    ExpandOutcome::MissingSlots {
        manifest_name: manifest.identity.name.clone(),
        missing: vec!["<无执行定义>".to_string()],
    }
}

/// 渲染一个 JSON 值里的槽位占位符。
///
/// 只处理字符串；数组与对象递归处理。数字/布尔原样返回。
fn render_value(v: &serde_json::Value, values: &SlotValues) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(render_slots(s, values)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().map(|x| render_value(x, values)).collect())
        }
        serde_json::Value::Object(o) => serde_json::Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), render_value(x, values)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[async_trait]
impl Stage for ManifestStage {
    fn name(&self) -> &'static str {
        "manifest"
    }

    async fn try_resolve(&self, input: &RouteInput, _ctx: &mut RouteCtx) -> Route {
        let Some((manifest, score)) = self.best_match(&input.text) else {
            return Route::Defer;
        };

        if score < self.min_confidence {
            return Route::Defer;
        }

        match expand(manifest, &input.text) {
            ExpandOutcome::Plan { plan, .. } => Route::hit(plan, score),
            ExpandOutcome::MissingSlots {
                manifest_name,
                missing,
            } => {
                // 缺口计划：明确告知缺什么，而不是假装能执行。
                // 单步 llm_generate 让模型向用户追问。
                let ask = format!(
                    "任务「{manifest_name}」缺少必要信息：{}。请补充后再试。",
                    missing.join("、")
                );
                let mut params = BTreeMap::new();
                params.insert(
                    "prompt".to_string(),
                    serde_json::Value::String(ask.clone()),
                );
                Route::hit(
                    TaskPlan {
                        intent: manifest_name,
                        needs: vec![],
                        steps: vec![PlanStep {
                            step: 1,
                            description: ask,
                            tool: "llm_generate".to_string(),
                            depends_on: vec![],
                            params,
                            expected_output: String::new(),
                            fallback: None,
                        }],
                    },
                    score,
                )
            }
        }
    }
}
