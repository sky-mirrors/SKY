//! 四段的具体实现。
//!
//! 每段都必须遵守 `Stage` 契约：**不匹配返回 `Defer`，不得用低置信度 `Hit` 冒充命中**。

use crate::stage::{Candidate, Route, RouteCtx, Stage};
use async_trait::async_trait;
use sky_core::{PlanStep, RouteInput, TaskPlan};
use std::collections::BTreeMap;

/// 缓存查询函数签名：给定查询文本，返回（计划，相似度）。
pub type CacheLookup = dyn Fn(&str) -> Option<(TaskPlan, f32)> + Send + Sync;

/// 第 0 段：缓存。
///
/// 现状 semanticCache 位于漏斗之前（`src/services/semanticCache.ts`），
/// 提为独立段后，「能多便宜答完」成为一条统一轴。
/// 阈值对齐现状 `similarityThreshold: 0.92`（`src/services/semanticCache.ts:51`）。
pub struct CacheStage {
    pub threshold: f32,
    /// 缓存查询注入点。None 表示无缓存后端（测试或冷启动）。
    pub lookup: Option<Box<CacheLookup>>,
}

impl Default for CacheStage {
    fn default() -> Self {
        Self {
            threshold: 0.92,
            lookup: None,
        }
    }
}

impl CacheStage {
    pub fn with_threshold(threshold: f32) -> Self {
        Self {
            threshold,
            lookup: None,
        }
    }
}

#[async_trait]
impl Stage for CacheStage {
    fn name(&self) -> &'static str {
        "cache"
    }

    async fn try_resolve(&self, input: &RouteInput, _ctx: &mut RouteCtx) -> Route {
        let Some(lookup) = &self.lookup else {
            return Route::Defer;
        };
        match lookup(&input.text) {
            // 低于阈值不算命中——防止弱相似结果劫持路由
            Some((plan, sim)) if sim >= self.threshold => Route::hit(plan, sim),
            _ => Route::Defer,
        }
    }
}

/// 一条确定性规则：关键词全命中即产出计划。
#[derive(Clone)]
pub struct Rule {
    pub name: &'static str,
    pub keywords: Vec<&'static str>,
    pub tool: &'static str,
    pub description: &'static str,
    pub confidence: f32,
}

/// 第 1 段：确定性。
///
/// 合并现状 L0（规则表）/ L0.5（关键词快配）/ L1（能力直调）——
/// 三者都是 0 token 的确定性匹配，区别只是数据源。
/// **三个门值（l05Pass 0.6 / l05Auto 0.9 / l1Pass 0.6，见 `src/kernel/funnel.ts:36`）
/// 在此塌缩为单一 `min_confidence`。**
pub struct DeterministicStage {
    pub rules: Vec<Rule>,
    pub min_confidence: f32,
}

impl DeterministicStage {
    /// 用默认规则集构造。规则来自现状 L0 的确定性能力（doc→PDF / image-ops / media-ops）。
    pub fn with_default_rules() -> Self {
        Self {
            rules: vec![
                Rule {
                    name: "doc-to-pdf",
                    keywords: vec!["转", "pdf"],
                    tool: "doc_convert",
                    description: "文档转 PDF",
                    confidence: 0.9,
                },
                Rule {
                    name: "image-ops",
                    keywords: vec!["图片", "压缩"],
                    tool: "image_ops",
                    description: "图片压缩处理",
                    confidence: 0.9,
                },
                Rule {
                    name: "media-ops",
                    keywords: vec!["视频", "转码"],
                    tool: "media_ops",
                    description: "视频转码",
                    confidence: 0.9,
                },
            ],
            min_confidence: 0.6,
        }
    }

    fn match_rule(&self, text: &str) -> Option<&Rule> {
        let lower = text.to_lowercase();
        self.rules.iter().find(|r| {
            r.keywords
                .iter()
                .all(|k| lower.contains(&k.to_lowercase()))
        })
    }
}

#[async_trait]
impl Stage for DeterministicStage {
    fn name(&self) -> &'static str {
        "deterministic"
    }

    async fn try_resolve(&self, input: &RouteInput, _ctx: &mut RouteCtx) -> Route {
        let Some(rule) = self.match_rule(&input.text) else {
            return Route::Defer;
        };
        if rule.confidence < self.min_confidence {
            return Route::Defer;
        }

        let plan = TaskPlan {
            intent: rule.description.to_string(),
            needs: vec![],
            steps: vec![PlanStep {
                step: 1,
                description: rule.description.to_string(),
                tool: rule.tool.to_string(),
                depends_on: vec![],
                params: BTreeMap::new(),
                expected_output: String::new(),
                fallback: None,
            }],
        };
        Route::hit(plan, rule.confidence)
    }
}

/// 一个可检索的宏/工具条目。
#[derive(Clone)]
pub struct Matchable {
    pub id: String,
    pub name: String,
    pub keywords: Vec<String>,
    pub tool: String,
}

/// 第 2 段：检索。
///
/// 合并现状 L2（宏检索）与 L3（LLM 仲裁）——
/// L3 仅在 L2 出现 ≥2 候选时才调用（`docs/20-请求生命周期与路由.md`），
/// 是 L2 的歧义消解子策略而非独立层。
pub struct RetrievalStage {
    pub items: Vec<Matchable>,
    /// 高于此分直接命中。对齐现状 `GATE_GREEN_THRESHOLD = 0.95`
    /// （`src/services/toolRetrieval.ts:299`）。
    pub green_threshold: f32,
    /// 低于此分视为无信号。对齐 `VECTOR_AMBIGUOUS_LOW = 0.55`
    /// （`src/services/toolRetrieval.ts:298`）。
    pub ambiguous_low: f32,
    /// 前两名分差小于此值视为歧义，转仲裁。
    /// 对齐 `MARGIN_THRESHOLD = 0.10`（`src/services/toolRetrieval.ts:613`）。
    pub margin_threshold: f32,
}

impl RetrievalStage {
    pub fn new(items: Vec<Matchable>) -> Self {
        Self {
            items,
            green_threshold: 0.95,
            ambiguous_low: 0.55,
            margin_threshold: 0.10,
        }
    }

    /// 关键词命中率打分，范围 0.0–1.0。
    fn score(&self, item: &Matchable, lower: &str) -> f32 {
        if item.keywords.is_empty() {
            return 0.0;
        }
        let hits = item
            .keywords
            .iter()
            .filter(|k| lower.contains(&k.to_lowercase()))
            .count();
        hits as f32 / item.keywords.len() as f32
    }
}

#[async_trait]
impl Stage for RetrievalStage {
    fn name(&self) -> &'static str {
        "retrieval"
    }

    async fn try_resolve(&self, input: &RouteInput, _ctx: &mut RouteCtx) -> Route {
        let lower = input.text.to_lowercase();

        let mut scored: Vec<(f32, &Matchable)> = self
            .items
            .iter()
            .map(|it| (self.score(it, &lower), it))
            .filter(|(s, _)| *s >= self.ambiguous_low)
            .collect();

        if scored.is_empty() {
            return Route::Defer;
        }

        // 高分在前
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let (top_score, top_item) = scored[0];

        // 唯一候选且够绿 → 直接命中
        if scored.len() == 1 && top_score >= self.green_threshold {
            let plan = TaskPlan {
                intent: top_item.name.clone(),
                needs: vec![],
                steps: vec![PlanStep {
                    step: 1,
                    description: top_item.name.clone(),
                    tool: top_item.tool.clone(),
                    depends_on: vec![],
                    params: BTreeMap::new(),
                    expected_output: String::new(),
                    fallback: None,
                }],
            };
            return Route::hit(plan, top_score);
        }

        // 分差足够大 → 取第一名，不用仲裁
        let margin_ok = scored
            .get(1)
            .map(|(s, _)| top_score - s >= self.margin_threshold)
            .unwrap_or(true);

        if margin_ok && scored.len() > 1 {
            let plan = TaskPlan {
                intent: top_item.name.clone(),
                needs: vec![],
                steps: vec![PlanStep {
                    step: 1,
                    description: top_item.name.clone(),
                    tool: top_item.tool.clone(),
                    depends_on: vec![],
                    params: BTreeMap::new(),
                    expected_output: String::new(),
                    fallback: None,
                }],
            };
            return Route::hit(plan, top_score);
        }

        // 歧义 → 交给仲裁
        Route::Candidates(
            scored
                .iter()
                .take(3)
                .map(|(s, it)| Candidate {
                    id: it.id.clone(),
                    name: it.name.clone(),
                    score: *s,
                })
                .collect(),
        )
    }
}

/// 第 3 段：探索。
///
/// 兜底段，永不 Defer。对应现状 L4（`buildExplorePlan`）。
pub struct ExploreStage;

#[async_trait]
impl Stage for ExploreStage {
    fn name(&self) -> &'static str {
        "explore"
    }

    async fn try_resolve(&self, input: &RouteInput, _ctx: &mut RouteCtx) -> Route {
        let plan = TaskPlan {
            intent: input.text.clone(),
            needs: vec!["exploration".to_string()],
            steps: vec![],
        };
        Route::hit(plan, 0.0)
    }
}
