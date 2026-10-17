//! 语义缓存。
//!
//! 对应现状 `src/services/semanticCache.ts`（656 行）。
//!
//! 保留的关键语义（均有现状依据）：
//! - **复合键隔离**：键 = `hash | domain | packId`，domain/packId 必须精确相等
//!   （`semanticCache.ts:170-196`，规格 M10）。这是防跨域缓存污染的修复，不得退化。
//! - **阈值 0.92 / 容量 500 / TTL 24h**（`semanticCache.ts:50-55`）
//! - **LRU 淘汰**（`semanticCache.ts:339-345`）
//! - **同名未过期条目直接复用，不更新**（`semanticCache.ts:305-310`）

use serde::{Deserialize, Serialize};
use sky_core::ModelTier;
use std::collections::HashMap;

/// 默认相似度阈值。对齐 `semanticCache.ts:51`。
pub const DEFAULT_SIMILARITY_THRESHOLD: f32 = 0.92;
/// 默认容量上限。对齐 `semanticCache.ts:52`。
pub const DEFAULT_MAX_ENTRIES: usize = 500;
/// 默认 TTL（毫秒，24 小时）。对齐 `semanticCache.ts:53`。
pub const DEFAULT_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// 缓存条目。字段对齐 `semanticCache.ts:7-24` 的 `SemanticCacheEntry`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub id: String,
    pub query_hash: String,
    pub query_embedding: Vec<f32>,
    /// 伪向量标记。现状 `embeddingIsPseudo?`（`semanticCache.ts:12`）。
    /// 维度相同不能区分真伪——必须同时看此字段。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub embedding_is_pseudo: bool,
    pub query_text: String,
    pub response_text: String,
    pub tier: ModelTier,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub saved_at: u64,
    pub last_accessed_at: u64,
    pub hit_count: u64,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub pack_id: Option<String>,
    #[serde(default)]
    pub constraint_ids: Vec<String>,
    pub ttl: u64,
}

impl CacheEntry {
    pub fn is_expired(&self, now: u64) -> bool {
        now.saturating_sub(self.saved_at) > self.ttl
    }
}

/// 缓存命中结果。对齐 `semanticCache.ts` 的 `SemanticCacheHit`。
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    /// 精确命中（相似度视为 1.0）。
    Exact(CacheEntry),
    /// 语义命中。
    Semantic { entry: CacheEntry, similarity: f32 },
    Miss,
}

impl Lookup {
    pub fn entry(&self) -> Option<&CacheEntry> {
        match self {
            Lookup::Exact(e) | Lookup::Semantic { entry: e, .. } => Some(e),
            Lookup::Miss => None,
        }
    }

    pub fn is_hit(&self) -> bool {
        !matches!(self, Lookup::Miss)
    }
}

/// 自适应阈值状态。对齐 `semanticCache.ts:68-77`。
#[derive(Debug, Clone)]
pub struct AdaptiveThreshold {
    pub current: f32,
    pub min: f32,
    pub max: f32,
    pub target_hit_rate: f32,
    pub window_size: usize,
    pub adjust_interval: usize,
    lookups_since_adjust: usize,
    recent_results: Vec<bool>,
}

impl Default for AdaptiveThreshold {
    fn default() -> Self {
        Self {
            current: DEFAULT_SIMILARITY_THRESHOLD,
            min: 0.80,
            max: 0.95,
            target_hit_rate: 0.3,
            window_size: 50,
            adjust_interval: 20,
            lookups_since_adjust: 0,
            recent_results: Vec::new(),
        }
    }
}

impl AdaptiveThreshold {
    /// 记录一次查询结果并可能调整阈值。
    ///
    /// 算法对齐 `semanticCache.ts:206-217`：非对称步长（降 0.01 / 升 0.005）。
    pub fn record(&mut self, hit: bool) {
        self.recent_results.push(hit);
        if self.recent_results.len() > self.window_size {
            self.recent_results.remove(0);
        }

        self.lookups_since_adjust += 1;
        if self.lookups_since_adjust < self.adjust_interval {
            return;
        }
        self.lookups_since_adjust = 0;

        // 样本不足 5 条不调整（semanticCache.ts:211）
        if self.recent_results.len() < 5 {
            return;
        }

        let hits = self.recent_results.iter().filter(|h| **h).count();
        let hit_rate = hits as f32 / self.recent_results.len() as f32;

        if hit_rate < self.target_hit_rate - 0.1 {
            self.current = (self.current - 0.01).max(self.min);
        } else if hit_rate > self.target_hit_rate + 0.2 {
            self.current = (self.current + 0.005).min(self.max);
        }
    }
}

/// 缓存错误。
#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("条目未找到：{0}")]
    NotFound(String),
}

/// 语义缓存。
pub struct SemanticCache {
    /// 复合键 → 条目
    exact: HashMap<String, CacheEntry>,
    /// 语义检索用线性数组（现状同为此结构，`semanticCache.ts:78-102`）
    semantic: Vec<CacheEntry>,
    /// LRU 顺序：队首最旧，队尾最新
    lru: Vec<String>,
    pub threshold: AdaptiveThreshold,
    pub max_entries: usize,
    pub total_hits: u64,
    pub total_misses: u64,
}

impl Default for SemanticCache {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_ENTRIES)
    }
}

impl SemanticCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            exact: HashMap::new(),
            semantic: Vec::new(),
            lru: Vec::new(),
            threshold: AdaptiveThreshold::default(),
            max_entries,
            total_hits: 0,
            total_misses: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.exact.len()
    }

    pub fn is_empty(&self) -> bool {
        self.exact.is_empty()
    }

    /// 复合键。对齐 `semanticCache.ts:170-172`。
    pub fn exact_key(hash: &str, domain: Option<&str>, pack_id: Option<&str>) -> String {
        format!(
            "{}|{}|{}",
            hash,
            domain.unwrap_or(""),
            pack_id.unwrap_or("")
        )
    }

    /// domain 精确匹配。空值归一化为 None 后比较。
    /// 对齐 `semanticCache.ts:179-184`——**必须精确相等，不得宽松通过**。
    pub fn domain_match(entry: &CacheEntry, domain: Option<&str>) -> bool {
        entry.domain.as_deref() == domain
    }

    /// pack 精确匹配。对齐 `semanticCache.ts:191-196`。
    pub fn pack_match(entry: &CacheEntry, pack_id: Option<&str>) -> bool {
        entry.pack_id.as_deref() == pack_id
    }

    /// 查询缓存。
    pub fn lookup(
        &mut self,
        hash: &str,
        embedding: &[f32],
        domain: Option<&str>,
        pack_id: Option<&str>,
        now: u64,
    ) -> Lookup {
        let key = Self::exact_key(hash, domain, pack_id);

        // 1) 精确命中
        if let Some(entry) = self.exact.get(&key) {
            if !entry.is_expired(now) {
                let entry = entry.clone();
                self.total_hits += 1;
                self.threshold.record(true);
                self.touch(&key, now);
                return Lookup::Exact(entry);
            }
        }

        // 2) 语义检索：线性扫描（与现状一致）
        let mut best: Option<(f32, CacheEntry)> = None;
        for entry in &self.semantic {
            if entry.is_expired(now) {
                continue;
            }
            // 跨域/pack 隔离：不匹配的条目直接跳过
            if !Self::domain_match(entry, domain) || !Self::pack_match(entry, pack_id) {
                continue;
            }
            let sim = cosine_similarity(embedding, &entry.query_embedding);
            if sim >= self.threshold.current {
                match &best {
                    Some((b, _)) if *b >= sim => {}
                    _ => best = Some((sim, entry.clone())),
                }
            }
        }

        match best {
            Some((sim, entry)) => {
                let k = Self::exact_key(&entry.query_hash, domain, pack_id);
                self.total_hits += 1;
                self.threshold.record(true);
                self.touch(&k, now);
                Lookup::Semantic {
                    entry,
                    similarity: sim,
                }
            }
            None => {
                self.total_misses += 1;
                self.threshold.record(false);
                Lookup::Miss
            }
        }
    }

    /// 写入缓存。
    ///
    /// 语义对齐 `semanticCache.ts:305-310`：同键且未过期时**直接返回既有条目**，
    /// 新内容被丢弃（不更新）。
    pub fn store(&mut self, mut entry: CacheEntry, now: u64) -> CacheEntry {
        let key = Self::exact_key(
            &entry.query_hash,
            entry.domain.as_deref(),
            entry.pack_id.as_deref(),
        );

        if let Some(existing) = self.exact.get(&key) {
            if !existing.is_expired(now) {
                // 不更新——与现状一致
                return existing.clone();
            }
        }

        // 清理同键的过期条目
        self.remove_key(&key);

        entry.saved_at = now;
        entry.last_accessed_at = now;

        self.exact.insert(key.clone(), entry.clone());
        self.semantic.push(entry.clone());
        self.lru.push(key);

        self.evict_if_needed();
        entry
    }

    /// 按 domain 失效。对应 `semanticCache.ts:355` `invalidateByDomain`。
    pub fn invalidate_by_domain(&mut self, domain: &str) -> usize {
        let keys: Vec<String> = self
            .exact
            .iter()
            .filter(|(_, e)| e.domain.as_deref() == Some(domain))
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            self.remove_key(k);
        }
        keys.len()
    }

    /// 按 pack 失效。对应 `semanticCache.ts:375` `invalidateByPack`。
    pub fn invalidate_by_pack(&mut self, pack_id: &str) -> usize {
        let keys: Vec<String> = self
            .exact
            .iter()
            .filter(|(_, e)| e.pack_id.as_deref() == Some(pack_id))
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            self.remove_key(k);
        }
        keys.len()
    }

    /// 清理过期条目。对应 `semanticCache.ts:410` `invalidateExpired`。
    pub fn invalidate_expired(&mut self, now: u64) -> usize {
        let keys: Vec<String> = self
            .exact
            .iter()
            .filter(|(_, e)| e.is_expired(now))
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            self.remove_key(k);
        }
        keys.len()
    }

    /// 命中率。仅统计有查询记录的情形。
    pub fn hit_rate(&self) -> f32 {
        let total = self.total_hits + self.total_misses;
        if total == 0 {
            return 0.0;
        }
        self.total_hits as f32 / total as f32
    }

    fn touch(&mut self, key: &str, now: u64) {
        if let Some(e) = self.exact.get_mut(key) {
            e.last_accessed_at = now;
            e.hit_count += 1;
        }
        // 移到 LRU 队尾
        if let Some(pos) = self.lru.iter().position(|k| k == key) {
            let k = self.lru.remove(pos);
            self.lru.push(k);
        }
    }

    fn remove_key(&mut self, key: &str) {
        if let Some(entry) = self.exact.remove(key) {
            // 三元组必须全等才删除——漏掉 pack_id 会让被淘汰的条目
            // 残留在 semantic 数组中，进而被语义检索重新命中。
            self.semantic.retain(|e| {
                !(e.query_hash == entry.query_hash
                    && e.domain == entry.domain
                    && e.pack_id == entry.pack_id)
            });
        }
        self.lru.retain(|k| k != key);
    }

    fn evict_if_needed(&mut self) {
        while self.exact.len() > self.max_entries {
            // 淘汰最旧
            if let Some(oldest) = self.lru.first().cloned() {
                self.remove_key(&oldest);
            } else {
                break;
            }
        }
    }
}

/// 余弦相似度。现状同为手写实现（`semanticCache.ts` cosineSimilarity）。
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// djb2 哈希——现状用于查询指纹。对齐 `semanticCache.ts` 与 `embedder.ts` 的 textKey。
pub fn djb2_hash(text: &str) -> String {
    let mut h: u64 = 5381;
    for byte in text.bytes() {
        h = h.wrapping_mul(33).wrapping_add(byte as u64);
    }
    format!("{h:x}")
}
