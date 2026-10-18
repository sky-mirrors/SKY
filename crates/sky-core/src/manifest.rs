//! L2 任务书（manifest）数据模型与加载。
//!
//! **什么是任务书**：一份领域任务的声明式定义——「什么输入触发它」（`routing`）、
//! 「按什么步骤做」（`execution.dagPlan`）、「参数从哪来」（`execution.paramMapping`）。
//!
//! 对应现状 `config/l2_manifests/*.json`（20 份）与 `src/services/compositeIntent.ts`
//! 的组合意图表。两者是同一族设计的两种粒度：任务书面向垂直领域任务（合同审查、
//! 周报草稿），组合意图面向文件操作组合（建目录+归类）。
//!
//! **为什么这是「路由降级」的载体**：命中任务书 = 不必调 LLM 规划器（省一次模型调用），
//! 且任务书内的叶节点多数是确定性工具（再省多次调用）。只有 `llm_generate` 这类
//! 语义节点消耗 token。这正是用户要的「减少 token 消耗」。
//!
//! **两种占位符，语义不同，绝不可混用**：
//! - `{{slot_name}}` —— 外部输入槽位，**路由期**填充（此时已知用户输入）
//! - `{{step_N_result}}` —— 上游步骤结果，**执行期**填充（此时还没有结果）
//!
//! 展开器只填前者，后者原样保留。若把后者也当槽位渲染成空串，第二步会拿到
//! 空输入却「成功」——这是本项目最容易做错的地方。
//!
//! **为什么编译期嵌入而非运行时读盘**：任务书是代码资产（随版本发布），
//! `include_str!` 避免打包后路径失效；代价是改任务书要重新编译。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 一份完整的 L2 任务书。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct L2Manifest {
    /// 身份信息。
    pub identity: Identity,
    /// 路由判据——决定哪些输入命中本任务书。
    pub routing: Routing,
    /// 执行定义——步骤与参数映射。
    pub execution: Execution,
    /// 缓存元数据。缺省时视为不可缓存。
    #[serde(default)]
    pub cache_meta: Option<CacheMeta>,
    /// 视觉信息（UI 星图用）。Rust 侧不需要，但保留以便往返序列化不丢数据。
    #[serde(default)]
    pub visual: Option<serde_json::Value>,
}

/// 任务书身份。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    /// 模板 id，供 UI 关联图标/配色。
    #[serde(default, rename = "templateId")]
    pub template_id: Option<String>,
}

/// 路由判据。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Routing {
    /// 触发关键词。要求**全部命中**才视为候选（与 `DeterministicStage` 一致）。
    ///
    /// **刻意不加 `#[serde(default)]`**：实测发现加 default 后，把 `keywords`
    /// 拼错成 `keywordz` 会静默解析成空数组——任务书「加载成功」但永远无法被命中，
    /// 比解析失败更难排查。宁可拒绝加载，也不要收下一份死掉的任务书。
    pub keywords: Vec<String>,
    /// 目标角色（general / finance / legal / hr / sales）。属于筛选提示，不参与 Rust 侧匹配。
    #[serde(default, rename = "targetRoles")]
    pub target_roles: Vec<String>,
    /// 输入类型提示：text / file / file_or_text。
    #[serde(default, rename = "inputType")]
    pub input_type: Option<String>,
    /// 检索摘要，供 UI 展示。
    #[serde(default, rename = "retrievalSummary")]
    pub retrieval_summary: Option<String>,
}

/// 执行定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Execution {
    /// 执行模式：`direct`（单次调用）/ `macro`（多步 DAG）/ `chain`。
    #[serde(default)]
    pub mode: String,
    /// 多步计划。`direct` 模式可能没有。
    #[serde(default, rename = "dagPlan")]
    pub dag_plan: Option<DagPlan>,
    /// 直调模式的定义。`macro` 模式可能没有。
    #[serde(default, rename = "directCall")]
    pub direct_call: Option<DirectCall>,
    /// 参数映射：槽位声明 + 槽位到步骤参数的绑定。
    #[serde(default, rename = "paramMapping")]
    pub param_mapping: Option<ParamMapping>,
}

/// 多步计划。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DagPlan {
    #[serde(default)]
    pub steps: Vec<DagStep>,
    #[serde(default, rename = "fallbackStrategy")]
    pub fallback_strategy: Option<String>,
    #[serde(default, rename = "maxRetries")]
    pub max_retries: Option<u32>,
}

/// DAG 中的一步。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DagStep {
    pub step: u32,
    #[serde(default)]
    pub description: String,
    pub tool: String,
    #[serde(default, rename = "depends_on")]
    pub depends_on: Vec<u32>,
    /// 参数。值可能是字符串，也可能含 `{{slot}}` / `{{step_N_result}}` 占位符。
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
    #[serde(default, rename = "expectedOutput")]
    pub expected_output: Option<String>,
    /// 失败时的替代工具名。
    #[serde(default)]
    pub fallback: Option<String>,
}

/// 直调模式定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectCall {
    #[serde(default, rename = "l1Target")]
    pub l1_target: Option<String>,
    #[serde(default, rename = "promptTemplate")]
    pub prompt_template: String,
    #[serde(default, rename = "maxTokens")]
    pub max_tokens: Option<u32>,
}

/// 参数映射。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParamMapping {
    /// 槽位声明。
    #[serde(default)]
    pub slots: Vec<Slot>,
    /// 槽位到「某步骤的某参数」的绑定。
    #[serde(default)]
    pub bindings: Vec<Binding>,
}

/// 一个输入槽位。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slot {
    /// 槽位名，形如 `{{user_file}}`。
    pub name: String,
    /// 来源：file_path / input_text / context。
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub description: String,
    /// 必填。缺省视为可选。
    #[serde(default)]
    pub required: bool,
}

/// 槽位绑定：把槽位值送进某步骤的某参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    #[serde(rename = "slotName")]
    pub slot_name: String,
    /// 目标步骤编号。`direct` 模式约定为 0。
    #[serde(rename = "targetStep")]
    pub target_step: u32,
    #[serde(rename = "targetParam")]
    pub target_param: String,
}

/// 缓存元数据。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CacheMeta {
    /// 预计节省的 token 数——这是「路由降级」的经济账。
    #[serde(default, rename = "estimatedTokenSaving")]
    pub estimated_token_saving: Option<u64>,
    #[serde(default, rename = "avgExecutionTime")]
    pub avg_execution_time: Option<u64>,
    #[serde(default)]
    pub cacheable: bool,
    #[serde(default, rename = "cacheKeyTemplate")]
    pub cache_key_template: Option<String>,
    #[serde(default, rename = "cacheTTL")]
    pub cache_ttl: Option<u64>,
}

// ==================== 加载 ====================

/// 任务书加载结果��
///
/// 参照 `sky-llm/src/config.rs` 的三态设计：
/// 「没有」与「坏了」必须区分——坏了却静默当空处理，用户会以为任务书生效了。
#[derive(Debug, Clone, PartialEq)]
pub enum ManifestLoad {
    /// 全部加载成功。
    Loaded(Vec<L2Manifest>),
    /// 部分失败。成功的那部分可用，失败项必须报给用户。
    Partial {
        loaded: Vec<L2Manifest>,
        failures: Vec<ManifestFailure>,
    },
}

/// 单个任务书的加载失败。
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestFailure {
    /// 来源标识（文件名或嵌入标识）。
    pub source: String,
    /// 失败原因。
    pub reason: String,
}

impl ManifestLoad {
    /// 取已成功加载的任务书。
    pub fn manifests(&self) -> &[L2Manifest] {
        match self {
            ManifestLoad::Loaded(v) => v,
            ManifestLoad::Partial { loaded, .. } => loaded,
        }
    }

    /// 是否有失败项。
    pub fn has_failures(&self) -> bool {
        match self {
            ManifestLoad::Loaded(_) => false,
            ManifestLoad::Partial { failures, .. } => !failures.is_empty(),
        }
    }

    /// 供 UI 展示的警告文本。全部成功时返回 `None`。
    ///
    /// 不静默吞掉失败——任务书解析不了意味着那份领域能力悄悄消失了。
    pub fn warning(&self) -> Option<String> {
        match self {
            ManifestLoad::Loaded(_) => None,
            ManifestLoad::Partial { failures, .. } if failures.is_empty() => None,
            ManifestLoad::Partial { failures, .. } => Some(format!(
                "{} 份任务书加载失败：{}",
                failures.len(),
                failures
                    .iter()
                    .map(|f| format!("{}（{}）", f.source, f.reason))
                    .collect::<Vec<_>>()
                    .join("；")
            )),
        }
    }
}

/// 从一组 `(来源标识, JSON 文本)` 解析任务书。
///
/// 单项失败不影响其余项——但失败项会被记录下来，不静默丢弃。
pub fn parse_all(sources: &[(&str, &str)]) -> ManifestLoad {
    let mut loaded = Vec::new();
    let mut failures = Vec::new();

    for (source, text) in sources {
        match serde_json::from_str::<L2Manifest>(text) {
            Ok(m) => loaded.push(m),
            Err(e) => failures.push(ManifestFailure {
                source: (*source).to_string(),
                reason: e.to_string(),
            }),
        }
    }

    if failures.is_empty() {
        ManifestLoad::Loaded(loaded)
    } else {
        ManifestLoad::Partial { loaded, failures }
    }
}

/// 从已加载的任务书里，找出所有被引用的工具名（去重、有序）。
///
/// **用途**：防漂移检查。任务书写了 `llm_generate` 但执行器没实现，
/// 就会重演「能力未接入」——这条函数让那种情况能在测试阶段暴露。
pub fn referenced_tools(manifests: &[L2Manifest]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for m in manifests {
        if let Some(plan) = &m.execution.dag_plan {
            for step in &plan.steps {
                set.insert(step.tool.clone());
                if let Some(fb) = &step.fallback {
                    set.insert(fb.clone());
                }
            }
        }
        // direct 模式隐含使用 llm_generate（走模型网关）
        if m.execution.direct_call.is_some() {
            set.insert("llm_generate".to_string());
        }
    }
    set.into_iter().collect()
}
