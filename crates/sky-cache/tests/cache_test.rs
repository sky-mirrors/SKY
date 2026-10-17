//! sky-cache 测试。
//!
//! 重点覆盖：跨域/pack 隔离（现状修过的漏洞，最易退化）、阈值边界、LRU 淘汰、TTL 过期。

use sky_cache::*;
use sky_core::ModelTier;

fn entry(hash: &str, domain: Option<&str>, pack: Option<&str>, vec: Vec<f32>) -> CacheEntry {
    CacheEntry {
        id: format!("id-{hash}"),
        query_hash: hash.to_string(),
        query_embedding: vec,
        embedding_is_pseudo: false,
        query_text: format!("q-{hash}"),
        response_text: format!("r-{hash}"),
        tier: ModelTier::Standard,
        prompt_tokens: 10,
        completion_tokens: 20,
        saved_at: 0,
        last_accessed_at: 0,
        hit_count: 0,
        domain: domain.map(String::from),
        pack_id: pack.map(String::from),
        constraint_ids: vec![],
        ttl: DEFAULT_TTL_MS,
    }
}

const NOW: u64 = 1_000_000;

// ---------- 复合键与隔离 ----------

#[test]
fn exact_key_joins_three_parts() {
    assert_eq!(
        SemanticCache::exact_key("h", Some("legal"), Some("p1")),
        "h|legal|p1"
    );
    assert_eq!(SemanticCache::exact_key("h", None, None), "h||");
}

#[test]
fn domain_match_is_exact_not_loose() {
    let e = entry("h", Some("legal"), None, vec![1.0]);
    assert!(SemanticCache::domain_match(&e, Some("legal")));
    // 关键：不同域必须不匹配
    assert!(!SemanticCache::domain_match(&e, Some("finance")));
    assert!(!SemanticCache::domain_match(&e, None));
}

#[test]
fn pack_match_is_exact() {
    let e = entry("h", None, Some("p1"), vec![1.0]);
    assert!(SemanticCache::pack_match(&e, Some("p1")));
    assert!(!SemanticCache::pack_match(&e, Some("p2")));
    assert!(!SemanticCache::pack_match(&e, None));
}

/// 核心不变量：同 query_hash 但不同 domain 不得互相命中。
#[test]
fn same_hash_different_domain_do_not_collide() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", Some("legal"), None, vec![1.0, 0.0]), NOW);

    // 精确查询：不同域必须 miss
    let hit = c.lookup("h1", &[1.0, 0.0], Some("finance"), None, NOW);
    assert!(!hit.is_hit(), "不同 domain 不得精确命中");
}

/// 核心不变量：语义检索必须过滤掉 domain 不匹配的条目。
#[test]
fn semantic_lookup_respects_domain_isolation() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", Some("legal"), None, vec![1.0, 0.0]), NOW);

    // 向量完全相同，但域不同 → 必须 miss（否则即跨域污染）
    let hit = c.lookup("h-other", &[1.0, 0.0], Some("finance"), None, NOW);
    assert!(!hit.is_hit(), "语义检索不得跨域命中");

    // 同域则应命中
    let hit2 = c.lookup("h-other", &[1.0, 0.0], Some("legal"), None, NOW);
    assert!(hit2.is_hit(), "同域同向量应语义命中");
}

/// pack 隔离同理。
#[test]
fn semantic_lookup_respects_pack_isolation() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, Some("p1"), vec![1.0, 0.0]), NOW);

    let hit = c.lookup("h-other", &[1.0, 0.0], None, Some("p2"), NOW);
    assert!(!hit.is_hit(), "不得跨 pack 命中");

    let hit2 = c.lookup("h-other", &[1.0, 0.0], None, Some("p1"), NOW);
    assert!(hit2.is_hit());
}

// ---------- 精确命中 ----------

#[test]
fn exact_lookup_hits_same_key() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, None, vec![1.0, 0.0]), NOW);
    let hit = c.lookup("h1", &[0.0, 1.0], None, None, NOW); // 向量不同也无妨
    assert!(matches!(hit, Lookup::Exact(_)), "同键应精确命中");
}

/// 已存在且未过期的同键条目：不更新（对齐 semanticCache.ts:305-310）。
#[test]
fn store_does_not_overwrite_live_entry() {
    let mut c = SemanticCache::default();
    let mut first = entry("h1", None, None, vec![1.0]);
    first.response_text = "旧".into();
    c.store(first, NOW);

    let mut second = entry("h1", None, None, vec![1.0]);
    second.response_text = "新".into();
    let returned = c.store(second, NOW);

    assert_eq!(returned.response_text, "旧", "未过期条目不得被覆盖");
    assert_eq!(c.len(), 1);
}

// ---------- 阈值 ----------

#[test]
fn semantic_miss_below_threshold() {
    let mut c = SemanticCache::default();
    // 正交向量 → 相似度 0
    c.store(entry("h1", None, None, vec![1.0, 0.0]), NOW);
    let hit = c.lookup("h2", &[0.0, 1.0], None, None, NOW);
    assert!(!hit.is_hit(), "相似度 0 < 0.92 必须 miss");
}

#[test]
fn default_threshold_matches_current_impl() {
    let c = SemanticCache::default();
    assert!((c.threshold.current - 0.92).abs() < 1e-6);
    assert_eq!(c.max_entries, 500);
}

#[test]
fn adaptive_lowers_threshold_when_hit_rate_low() {
    let mut t = AdaptiveThreshold::default();
    // 20 次全 miss → 触发调整，命中率 0 < 0.2
    for _ in 0..20 {
        t.record(false);
    }
    assert!(t.current < 0.92, "低命中率应下调阈值，当前 {}", t.current);
    assert!(t.current >= t.min);
}

#[test]
fn adaptive_raises_threshold_when_hit_rate_high() {
    let mut t = AdaptiveThreshold::default();
    // 20 次全 hit → 命中率 1.0 > 0.5
    for _ in 0..20 {
        t.record(true);
    }
    assert!(t.current > 0.92, "高命中率应上调阈值，当前 {}", t.current);
    assert!(t.current <= t.max);
}

// ---------- TTL ----------

#[test]
fn expired_entry_is_not_returned() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, None, vec![1.0]), NOW);
    let later = NOW + DEFAULT_TTL_MS + 1;
    let hit = c.lookup("h1", &[1.0], None, None, later);
    assert!(!hit.is_hit(), "过期条目不得命中");
}

#[test]
fn invalidate_expired_removes_only_expired() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, None, vec![1.0]), NOW);
    c.store(entry("h2", None, None, vec![1.0]), NOW + DEFAULT_TTL_MS);

    // h1 已过期，h2 未过期
    let now = NOW + DEFAULT_TTL_MS + 1;
    let removed = c.invalidate_expired(now);
    assert_eq!(removed, 1);
    assert_eq!(c.len(), 1);
}

// ---------- LRU 淘汰 ----------

#[test]
fn evicts_oldest_when_over_capacity() {
    let mut c = SemanticCache::new(3);
    for i in 0..5 {
        c.store(entry(&format!("h{i}"), None, None, vec![1.0]), NOW + i);
    }
    assert_eq!(c.len(), 3, "容量上限 3");

    // 精确键 h0/h1 应被淘汰。
    // 注意：不能用 lookup 断言——语义检索会用剩余条目命中（向量相同），
    // 那是语义缓存的正确行为，不是淘汰失败。这里直接查精确命中。
    let h0 = c.lookup("h0", &[0.0], None, None, NOW + 10);
    assert!(
        !matches!(h0, Lookup::Exact(_)),
        "h0 的精确条目已被淘汰，不得精确命中"
    );

    // 精确命中仍在的条目
    let h4 = c.lookup("h4", &[0.0], None, None, NOW + 10);
    assert!(matches!(h4, Lookup::Exact(_)), "h4 应仍在缓存中");
}

/// 同 hash 同 domain 但不同 pack 的两条记录，删除其中一条时
/// 不得连带删除另一条（remove_key 必须按三元组全等匹配）。
#[test]
fn remove_key_matches_full_triple_not_partial() {
    let mut c = SemanticCache::default();
    // p1 与 p2 向量正交，便于判定谁被误删
    c.store(entry("h1", Some("legal"), Some("p1"), vec![1.0, 0.0]), NOW);
    c.store(entry("h1", Some("legal"), Some("p2"), vec![0.0, 1.0]), NOW);
    assert_eq!(c.len(), 2);

    // 失效 p1 —— 若 remove_key 按 (hash,domain) 部分匹配，会把 p2 的
    // semantic 条目一并删除
    let n = c.invalidate_by_pack("p1");
    assert_eq!(n, 1);

    // p2 必须仍可被语义检索命中
    let hit = c.lookup("h-other", &[0.0, 1.0], Some("legal"), Some("p2"), NOW);
    assert!(
        hit.is_hit(),
        "p2 的语义条目被误删——remove_key 未按三元组全等匹配"
    );
}

/// 淘汰必须同时清理 semantic 数组，否则内存泄漏且被淘汰条目会
/// 通过语义检索重新命中（vector 相同的情况下尤其明显）。
#[test]
fn eviction_removes_from_semantic_index() {
    let mut c = SemanticCache::new(2);
    // h0 与 h1 向量正交，便于区分
    c.store(entry("h0", None, None, vec![1.0, 0.0]), NOW);
    c.store(entry("h1", None, None, vec![0.0, 1.0]), NOW);
    // 再写入一条，触发淘汰最旧的 h0
    c.store(entry("h2", None, None, vec![0.0, 1.0]), NOW);

    assert_eq!(c.len(), 2);
    // 用 h0 的向量查询：h1/h2 正交（相似度 0），若 h0 仍在 semantic 中会命中
    let hit = c.lookup("h-new", &[1.0, 0.0], None, None, NOW);
    assert!(
        !hit.is_hit(),
        "h0 被淘汰后其语义条目也必须移除，否则会幽灵命中"
    );
}

// ---------- 失效 ----------

#[test]
fn invalidate_by_domain_removes_only_that_domain() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", Some("legal"), None, vec![1.0]), NOW);
    c.store(entry("h2", Some("finance"), None, vec![1.0]), NOW);

    let n = c.invalidate_by_domain("legal");
    assert_eq!(n, 1);
    assert_eq!(c.len(), 1);
    assert!(c.lookup("h2", &[1.0], Some("finance"), None, NOW).is_hit());
}

#[test]
fn invalidate_by_pack_removes_only_that_pack() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, Some("p1"), vec![1.0]), NOW);
    c.store(entry("h2", None, Some("p2"), vec![1.0]), NOW);

    let n = c.invalidate_by_pack("p1");
    assert_eq!(n, 1);
    assert!(c.lookup("h2", &[1.0], None, Some("p2"), NOW).is_hit());
}

// ---------- 命中率 ----------

#[test]
fn hit_rate_computed_over_lookups() {
    let mut c = SemanticCache::default();
    c.store(entry("h1", None, None, vec![1.0]), NOW);
    c.lookup("h1", &[1.0], None, None, NOW); // hit
    c.lookup("nope", &[0.0], None, None, NOW); // miss
    assert!((c.hit_rate() - 0.5).abs() < 1e-6, "命中率 {}", c.hit_rate());
}

// ---------- 余弦相似度 ----------

#[test]
fn cosine_identical_vectors_is_one() {
    let s = cosine_similarity(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]);
    assert!((s - 1.0).abs() < 1e-6);
}

#[test]
fn cosine_orthogonal_vectors_is_zero() {
    let s = cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]);
    assert!(s.abs() < 1e-6);
}

/// 拒绝用例：长度不等或空向量不得 panic，返回 0。
#[test]
fn cosine_mismatched_length_returns_zero() {
    assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
    assert_eq!(cosine_similarity(&[], &[]), 0.0);
}

#[test]
fn cosine_zero_vector_returns_zero() {
    assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
}

// ---------- 指纹缓存 ----------

#[test]
fn fingerprint_cache_roundtrip() {
    let mut fc = FingerprintCache::default();
    let k = FingerprintCache::fingerprint("把桌面图片按类型整理");
    assert!(fc.get(&k, NOW).is_none());
    fc.put(&k, "结果", NOW);
    assert_eq!(fc.get(&k, NOW).unwrap().response_text, "结果");
}

#[test]
fn fingerprint_cache_ttl_expires() {
    let mut fc = FingerprintCache::default();
    let k = FingerprintCache::fingerprint("x");
    fc.put(&k, "r", NOW);
    assert!(fc.get(&k, NOW + DEFAULT_FP_TTL_MS + 1).is_none());
}

/// 拒绝用例：同文本必须产生同指纹，不同文本必须不同。
#[test]
fn fingerprint_is_deterministic_and_distinct() {
    assert_eq!(
        FingerprintCache::fingerprint("abc"),
        FingerprintCache::fingerprint("abc")
    );
    assert_ne!(
        FingerprintCache::fingerprint("abc"),
        FingerprintCache::fingerprint("abd")
    );
}

#[test]
fn fingerprint_cache_evicts_over_capacity() {
    let mut fc = FingerprintCache::new(2, DEFAULT_FP_TTL_MS);
    fc.put("a", "1", NOW);
    fc.put("b", "2", NOW);
    fc.put("c", "3", NOW);
    assert_eq!(fc.len(), 2);
    assert!(fc.get("a", NOW).is_none(), "最旧的 a 应被淘汰");
}

#[test]
fn fingerprint_purge_expired_removes_stale() {
    let mut fc = FingerprintCache::default();
    fc.put("a", "1", NOW);
    fc.put("b", "2", NOW + DEFAULT_FP_TTL_MS);
    let removed = fc.purge_expired(NOW + DEFAULT_FP_TTL_MS + 1);
    assert_eq!(removed, 1);
    assert_eq!(fc.len(), 1);
}
