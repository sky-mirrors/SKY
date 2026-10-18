//! 领域包四阶段事务式挂载。
//!
//! 对应现状 `src/host/pack/loader.ts`（487 行）。
//!
//! 四阶段顺序固定（`pack/types.ts:134` 的 `PackMountPhase`）：
//! `manifest → knowledge → boundary → execution`
//!
//! **事务语义**：任一阶段失败即回滚已完成的阶段，包不进入挂载态。
//! 这保证不会出现「挂了一半」的包污染内核。

use crate::dsl::{validate_all, PackConstraint};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 挂载阶段。顺序即依赖顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MountPhase {
    Manifest,
    Knowledge,
    Boundary,
    Execution,
}

impl MountPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            MountPhase::Manifest => "manifest",
            MountPhase::Knowledge => "knowledge",
            MountPhase::Boundary => "boundary",
            MountPhase::Execution => "execution",
        }
    }

    /// 全部阶段，按执行顺序。
    pub fn all() -> [MountPhase; 4] {
        [
            MountPhase::Manifest,
            MountPhase::Knowledge,
            MountPhase::Boundary,
            MountPhase::Execution,
        ]
    }
}

/// 挂载失败原因。对应 `pack/types.ts:137` 的 `PackMountError.reason`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MountFailReason {
    JsonParse,
    Schema,
    Conflict,
    AlreadyMounted,
    Incompatible,
    NotFound,
    Internal,
}

/// 挂载错误。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MountError {
    pub pack_id: String,
    pub phase: MountPhase,
    pub reason: MountFailReason,
    pub detail: String,
}

/// 包清单。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackManifest {
    pub id: String,
    pub version: String,
    pub domain: String,
    /// 要求的最低宿主版本。
    #[serde(default)]
    pub min_host_version: Option<String>,
}

/// 知识条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub title: String,
    pub body: String,
}

/// 执行定义。
///
/// **2026-10-18 结构改造**：`steps` 从 `Vec<String>`（只装得下描述文本，
/// 装不下 tool/params/depends_on——「接线了也装不下任务」）改为 `Vec<PackStep>`。
/// 任务书 DAG 的真实形状：每步有工具名、参数表、依赖。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackExecution {
    pub mode: String,
    #[serde(default)]
    pub steps: Vec<PackStep>,
}

/// 一条真实可执行的步骤。对应任务书 DAG 的节点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackStep {
    /// 该步调用的工具名（与 sky-app tools.rs 注册表对齐）。
    pub tool: String,
    /// 步骤参数（如 `{"path": "{{input}}"}`；上游引用沿用 `{{step_N_*}}` 形态）。
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, serde_json::Value>,
    /// 依赖的步骤（0 起始索引的 Vec 下标）。
    #[serde(default)]
    pub depends_on: Vec<usize>,
    /// 人话描述（供 UI / 产物说明）。
    #[serde(default)]
    pub description: String,
}

/// 已挂载的包。
#[derive(Debug, Clone, PartialEq)]
pub struct MountedPack {
    pub manifest: PackManifest,
    pub knowledge: Vec<KnowledgeEntry>,
    pub constraints: Vec<PackConstraint>,
    pub execution: Option<PackExecution>,
}

/// 挂载结果。对应 `pack/types.ts:143` 的 `PackMountResult`。
#[derive(Debug, Clone, PartialEq)]
pub enum MountResult {
    Ok {
        pack_id: String,
        constraints_total: usize,
        constraints_disabled: usize,
        warnings: Vec<String>,
    },
    Failed {
        error: MountError,
        warnings: Vec<String>,
    },
}

impl MountResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, MountResult::Ok { .. })
    }
}

/// 包源。实现方负责从磁盘/内存读取各阶段数据。
///
/// 对齐 `pack/types.ts:120-131` 的 `PackSource` trait 形态。
pub trait PackSource {
    fn read_manifest(&self, pack_id: &str) -> Result<PackManifest, MountError>;
    fn read_knowledge(&self, pack_id: &str) -> Result<Vec<KnowledgeEntry>, MountError>;
    fn read_constraints(&self, pack_id: &str) -> Result<Vec<PackConstraint>, MountError>;
    fn read_execution(&self, pack_id: &str) -> Result<Option<PackExecution>, MountError>;
}

/// 包宿主。
pub struct PackHost {
    mounted: BTreeMap<String, MountedPack>,
    /// 宿主版本，用于兼容性检查。
    host_version: String,
}

impl PackHost {
    pub fn new(host_version: impl Into<String>) -> Self {
        Self {
            mounted: BTreeMap::new(),
            host_version: host_version.into(),
        }
    }

    pub fn is_mounted(&self, pack_id: &str) -> bool {
        self.mounted.contains_key(pack_id)
    }

    pub fn mounted_count(&self) -> usize {
        self.mounted.len()
    }

    pub fn get(&self, pack_id: &str) -> Option<&MountedPack> {
        self.mounted.get(pack_id)
    }

    /// 四阶段事务式挂载。
    ///
    /// 任一阶段失败 → 不写入 `mounted`（无部分挂载状态）。
    pub fn mount(&mut self, pack_id: &str, src: &dyn PackSource) -> MountResult {
        let mut warnings: Vec<String> = Vec::new();

        // 前置：已挂载检查
        if self.is_mounted(pack_id) {
            return MountResult::Failed {
                error: MountError {
                    pack_id: pack_id.to_string(),
                    phase: MountPhase::Manifest,
                    reason: MountFailReason::AlreadyMounted,
                    detail: format!("包 {pack_id} 已挂载"),
                },
                warnings,
            };
        }

        // 阶段 1：manifest
        let manifest = match src.read_manifest(pack_id) {
            Ok(m) => m,
            Err(e) => {
                return MountResult::Failed {
                    error: e,
                    warnings,
                }
            }
        };

        // 兼容性检查
        if let Some(min) = &manifest.min_host_version {
            if !version_ok(&self.host_version, min) {
                return MountResult::Failed {
                    error: MountError {
                        pack_id: pack_id.to_string(),
                        phase: MountPhase::Manifest,
                        reason: MountFailReason::Incompatible,
                        detail: format!(
                            "包要求宿主版本 >= {min}，当前 {}",
                            self.host_version
                        ),
                    },
                    warnings,
                };
            }
        }

        // 阶段 2：knowledge
        let knowledge = match src.read_knowledge(pack_id) {
            Ok(k) => k,
            Err(e) => {
                return MountResult::Failed {
                    error: e,
                    warnings,
                }
            }
        };

        // 阶段 3：boundary（constraints）
        let constraints = match src.read_constraints(pack_id) {
            Ok(c) => c,
            Err(e) => {
                return MountResult::Failed {
                    error: e,
                    warnings,
                }
            }
        };

        // 约束 schema 校验——不合法即整包拒绝（事务性）
        let schema_errs = validate_all(&constraints);
        if !schema_errs.is_empty() {
            let detail = schema_errs
                .iter()
                .map(|e| format!("[{}] {}: {}", e.index, e.field, e.message))
                .collect::<Vec<_>>()
                .join("; ");
            return MountResult::Failed {
                error: MountError {
                    pack_id: pack_id.to_string(),
                    phase: MountPhase::Boundary,
                    reason: MountFailReason::Schema,
                    detail,
                },
                warnings,
            };
        }

        // 阶段 4：execution（可选）
        let execution = match src.read_execution(pack_id) {
            Ok(e) => e,
            Err(e) => {
                return MountResult::Failed {
                    error: e,
                    warnings,
                }
            }
        };

        if execution.is_none() {
            warnings.push("包未提供 execution 定义，仅提供知识/约束".into());
        }

        let disabled = constraints.iter().filter(|c| !c.enabled).count();
        let total = constraints.len();

        self.mounted.insert(
            pack_id.to_string(),
            MountedPack {
                manifest,
                knowledge,
                constraints,
                execution,
            },
        );

        MountResult::Ok {
            pack_id: pack_id.to_string(),
            constraints_total: total,
            constraints_disabled: disabled,
            warnings,
        }
    }

    /// 卸载。
    pub fn unmount(&mut self, pack_id: &str) -> bool {
        self.mounted.remove(pack_id).is_some()
    }

    /// 列出已挂载的包 id。
    pub fn list(&self) -> Vec<String> {
        self.mounted.keys().cloned().collect()
    }
}

/// 版本比较（主.次.补 语义）。
fn version_ok(current: &str, min: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.')
            .map(|p| p.trim().parse::<u32>().unwrap_or(0))
            .collect()
    };
    let c = parse(current);
    let m = parse(min);
    for i in 0..m.len().max(c.len()) {
        let cv = c.get(i).copied().unwrap_or(0);
        let mv = m.get(i).copied().unwrap_or(0);
        if cv > mv {
            return true;
        }
        if cv < mv {
            return false;
        }
    }
    true
}
