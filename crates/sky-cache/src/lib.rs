//! SKY 缓存层。
//!
//! 对应现状 `src/services/semanticCache.ts`（656 行）与
//! `src/services/toolRetrieval.ts` 的路由缓存部分。
//!
//! 两级：指纹缓存（精确，零计算）→ 语义缓存（向量相似度）。
//! 语义缓存接进路由后即 `CacheStage` 的数据源。

pub mod fingerprint;
pub mod persist;
pub mod semantic;

pub use fingerprint::{FingerprintCache, FingerprintEntry, DEFAULT_FP_MAX, DEFAULT_FP_TTL_MS};
pub use persist::{append_entry, default_store_path, load_entries, PersistedEntry};
pub use semantic::{
    cosine_similarity, djb2_hash, AdaptiveThreshold, CacheEntry, CacheError, Lookup, SemanticCache,
    DEFAULT_MAX_ENTRIES, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_TTL_MS,
};
