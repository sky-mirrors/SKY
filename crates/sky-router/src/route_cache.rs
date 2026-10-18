//! 路由级精确缓存。
//!
//! **为什么不用 `sky-cache::SemanticCache`**：2026-10-18 实测（`docs/95` §9.1）
//! 否决了三维键（hash × domain × pack_id）设计——14 次自然措辞查询精确命中 0、
//! 整体命中率 21.4%，且 domain 抖动使同一句话 miss。路由缓存要的是
//! 「同一意图的重复输入直接复用计划」，归一化后的**精确匹配**就够。
//!
//! 设计（对齐 95 册 §9.1 策略）：
//! 1. 键 = `normalize()` 后的文本——全角/半角、大小写差异不分裂缓存
//! 2. 无 domain / pack_id 维度——20 份任务书目前是单一命名空间
//! 3. TTL + 条目上限，惰性过期
//!
//! 语义缓存（跨措辞相似命中）留待真实 embedding 可用时再议。

use crate::normalize::normalize;
use sky_core::TaskPlan;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 默认 TTL：1 小时。任务书/规则在会话内极少变更，过期只为兜底陈旧计划。
pub const ROUTE_CACHE_TTL: Duration = Duration::from_millis(3_600_000);

/// 默认条目上限。超出驱逐最早写入的条目。
pub const ROUTE_CACHE_MAX_ENTRIES: usize = 512;

#[derive(Clone)]
struct CachedRoute {
    plan: TaskPlan,
    stored_at: Instant,
    seq: u64,
}

#[derive(Default)]
struct Inner {
    map: HashMap<String, CachedRoute>,
    seq: u64,
}

/// 路由结果缓存。线程安全；`Pipeline` 持有 `Arc<RouteCache>` 共享给 `CacheStage`。
pub struct RouteCache {
    inner: Mutex<Inner>,
    ttl: Duration,
    max_entries: usize,
}

impl Default for RouteCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            ttl: ROUTE_CACHE_TTL,
            max_entries: ROUTE_CACHE_MAX_ENTRIES,
        }
    }
}

impl RouteCache {
    /// 自定义 TTL 与上限（测试用）。
    pub fn with_limits(ttl: Duration, max_entries: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            ttl,
            max_entries,
        }
    }

    /// 查缓存。命中返回（计划，1.0）——精确重复即是完全置信，
    /// 且必须 ≥ `CacheStage` 的 0.92 阈值（manifest 原始置信度 0.85–1.0
    /// 会有一部分低于阈值，若回传原值会导致缓存永不命中）。
    pub fn lookup(&self, text: &str) -> Option<(TaskPlan, f32)> {
        let key = normalize(text);
        if key.trim().is_empty() {
            return None;
        }
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.map.get(&key)?;
        // TTL 是生存上限：存活时长到达上限即过期（TTL=0 ⇒ 立即过期）。
        if entry.stored_at.elapsed() >= self.ttl {
            inner.map.remove(&key);
            return None;
        }
        Some((entry.plan.clone(), 1.0))
    }

    /// 存入。空键不存；已存在的键不刷新（首见为准，避免置信度抖动）。
    pub fn store(&self, text: &str, plan: &TaskPlan) {
        let key = normalize(text);
        if key.trim().is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.map.contains_key(&key) {
            return;
        }
        // 容量已满：驱逐最早写入的条目（seq 最小）。
        if inner.map.len() >= self.max_entries {
            let oldest = inner
                .map
                .iter()
                .min_by_key(|(_, e)| e.seq)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                inner.map.remove(&k);
            }
        }
        inner.seq += 1;
        let seq = inner.seq;
        inner.map.insert(
            key,
            CachedRoute {
                plan: plan.clone(),
                stored_at: Instant::now(),
                seq,
            },
        );
    }

    /// 当前条目数。
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sky_core::PlanStep;
    use std::collections::BTreeMap;

    fn plan_with(intent: &str, steps: usize) -> TaskPlan {
        TaskPlan {
            intent: intent.to_string(),
            needs: vec![],
            steps: (1u32..=steps as u32)
                .map(|i| PlanStep {
                    step: i,
                    description: format!("step {i}"),
                    tool: "echo".to_string(),
                    depends_on: vec![],
                    params: BTreeMap::new(),
                    expected_output: String::new(),
                    fallback: None,
                })
                .collect(),
        }
    }

    #[test]
    fn store_then_exact_lookup_hits() {
        let c = RouteCache::default();
        let p = plan_with("财务报表摘要", 3);
        c.store("帮我摘要这份财务报告", &p);
        assert_eq!(c.len(), 1);
        let hit = c.lookup("帮我摘要这份财务报告");
        assert!(hit.is_some(), "同文本第二次查询必须命中");
        let (plan, conf) = hit.unwrap();
        assert_eq!(plan.intent, "财务报表摘要");
        assert!(
            conf >= 0.92,
            "缓存返回的置信度必须过 CacheStage 阈值（0.92），得到 {conf}"
        );
    }

    #[test]
    fn fullwidth_and_case_variants_share_one_entry() {
        let c = RouteCache::default();
        c.store("把文档转 pdf", &plan_with("文档转 PDF", 1));
        // 全角空格 + 全角大写变体必须命中同一条目（中文输入法真实场景）
        let hit = c.lookup("把文档转　ＰＤＦ");
        assert!(hit.is_some(), "归一化等价输入必须命中缓存");
        assert_eq!(c.len(), 1, "变体不得产生新条目");
    }

    #[test]
    fn different_text_misses() {
        let c = RouteCache::default();
        c.store("帮我摘要这份财务报告", &plan_with("a", 1));
        assert!(c.lookup("帮我做个财务报告的摘要").is_none());
    }

    #[test]
    fn empty_key_is_not_stored() {
        let c = RouteCache::default();
        c.store("　", &plan_with("x", 1)); // 全角空格 → 归一化后为空
        assert!(c.is_empty(), "空键不得入缓存");
        assert!(c.lookup("　").is_none());
    }

    #[test]
    fn ttl_expiry_drops_entry() {
        let c = RouteCache::with_limits(Duration::from_millis(0), 8);
        c.store("把文档转 pdf", &plan_with("a", 1));
        assert!(c.lookup("把文档转 pdf").is_none(), "TTL=0 应立即过期");
    }

    #[test]
    fn cap_evicts_oldest() {
        let c = RouteCache::with_limits(Duration::from_secs(3600), 2);
        c.store("第一句", &plan_with("a", 1));
        c.store("第二句", &plan_with("b", 1));
        c.store("第三句", &plan_with("c", 1));
        assert_eq!(c.len(), 2, "超过上限应驱逐");
        assert!(c.lookup("第一句").is_none(), "最早写入的应被驱逐");
        assert!(c.lookup("第三句").is_some());
    }

    #[test]
    fn restore_does_not_refresh() {
        let c = RouteCache::default();
        c.store("同一句", &plan_with("first", 1));
        c.store("同一句", &plan_with("second", 2));
        let (plan, _) = c.lookup("同一句").unwrap();
        assert_eq!(plan.intent, "first", "已存在的键不应被覆盖");
        assert_eq!(c.len(), 1);
    }
}
