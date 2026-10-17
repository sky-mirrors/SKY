//! 指纹缓存（精确缓存）。
//!
//! 与语义缓存的分工：指纹缓存按执行指纹精确命中，零计算成本；
//! 语义缓存需向量相似度计算。指纹缓存在语义缓存之前。

use crate::semantic::djb2_hash;
use std::collections::HashMap;

/// 指纹缓存条目。
#[derive(Debug, Clone, PartialEq)]
pub struct FingerprintEntry {
    pub key: String,
    pub response_text: String,
    pub saved_at: u64,
}

/// 指纹缓存。
///
/// 对应现状 `toolRetrieval.ts:36-37` 的路由缓存常量
/// （`ROUTE_CACHE_MAX = 100`、`ROUTE_CACHE_TTL = 30min`）。
pub struct FingerprintCache {
    entries: HashMap<String, FingerprintEntry>,
    order: Vec<String>,
    pub max_entries: usize,
    pub ttl_ms: u64,
}

/// 默认容量。对齐 `toolRetrieval.ts:36`。
pub const DEFAULT_FP_MAX: usize = 100;
/// 默认 TTL（30 分钟）。对齐 `toolRetrieval.ts:37`。
pub const DEFAULT_FP_TTL_MS: u64 = 30 * 60 * 1000;

impl Default for FingerprintCache {
    fn default() -> Self {
        Self::new(DEFAULT_FP_MAX, DEFAULT_FP_TTL_MS)
    }
}

impl FingerprintCache {
    pub fn new(max_entries: usize, ttl_ms: u64) -> Self {
        Self {
            entries: HashMap::new(),
            order: Vec::new(),
            max_entries,
            ttl_ms,
        }
    }

    /// 由输入文本生成指纹键。
    pub fn fingerprint(text: &str) -> String {
        djb2_hash(text)
    }

    pub fn get(&self, key: &str, now: u64) -> Option<&FingerprintEntry> {
        let e = self.entries.get(key)?;
        if now.saturating_sub(e.saved_at) > self.ttl_ms {
            return None;
        }
        Some(e)
    }

    pub fn put(&mut self, key: &str, response_text: &str, now: u64) {
        if self.entries.contains_key(key) {
            // 刷新时间，不重复入 order
            if let Some(e) = self.entries.get_mut(key) {
                e.response_text = response_text.to_string();
                e.saved_at = now;
            }
            return;
        }

        self.entries.insert(
            key.to_string(),
            FingerprintEntry {
                key: key.to_string(),
                response_text: response_text.to_string(),
                saved_at: now,
            },
        );
        self.order.push(key.to_string());
        self.evict_if_needed();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 清理过期条目。
    pub fn purge_expired(&mut self, now: u64) -> usize {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| now.saturating_sub(e.saved_at) > self.ttl_ms)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &expired {
            self.entries.remove(k);
        }
        self.order.retain(|k| !expired.contains(k));
        expired.len()
    }

    fn evict_if_needed(&mut self) {
        while self.entries.len() > self.max_entries {
            if self.order.is_empty() {
                break;
            }
            let oldest = self.order.remove(0);
            self.entries.remove(&oldest);
        }
    }
}
