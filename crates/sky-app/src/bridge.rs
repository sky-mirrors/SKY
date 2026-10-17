//! UiBridge 实现。
//!
//! 对应现状 core 反向调用 UI 的 bus 通道：
//! - `dialog:confirm-risk` → `confirm_risk`
//! - `dialog:confirm-write` → `confirm_write`
//! - `dialog:request-takeover` → `request_takeover`
//!
//! （见 `src/domains/dialog/handlers.ts:12`）
//!
//! **fail-closed**：所有超时/异常路径一律拒绝，不默认放行。

use async_trait::async_trait;
use sky_core::{UiBridge, WriteDecision, WriteRequest};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 默认超时（毫秒）。用户不响应即拒绝。
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 进度事件合帧间隔（毫秒）。
///
/// Wave 0 探针实测：Dioxus desktop 流式渲染约 63.8 token/s（300 token / 4.70s），
/// 每轮重绘多耗约 5.7ms。**每 token 直接推一次会打爆 WebView 消息队列**——
/// 故合并为 16ms 一帧（约 60fps）。
pub const FRAME_COALESCE_MS: u64 = 16;

/// 进度事件。
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressEvent {
    /// 路由决策（供路由面板展示）。
    RouteDecision { source: String, confidence: f32 },
    /// 流式 token 增量。
    TokenDelta(String),
    /// 步骤状态变化。
    StepStatus { step: u32, status: String },
    /// 通知。
    Notice { level: String, text: String },
}

/// 合帧缓冲器。
///
/// 累积事件，达到间隔或容量上限时一次性交付。
#[derive(Debug)]
pub struct FrameCoalescer {
    buf: Vec<ProgressEvent>,
    last_flush: Instant,
    interval: Duration,
    max_events: usize,
    /// 已刷新的帧数（可观测指标）。
    pub flushed_frames: u64,
    /// 已累积的事件总数。
    pub total_events: u64,
}

impl FrameCoalescer {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            last_flush: Instant::now(),
            interval: Duration::from_millis(FRAME_COALESCE_MS),
            max_events: 64,
            flushed_frames: 0,
            total_events: 0,
        }
    }

    pub fn with_interval(ms: u64) -> Self {
        let mut s = Self::new();
        s.interval = Duration::from_millis(ms);
        s
    }

    /// 推入事件。返回需要交付的批次（可能为空）。
    pub fn push(&mut self, ev: ProgressEvent) -> Vec<ProgressEvent> {
        self.buf.push(ev);
        self.total_events += 1;

        // 容量到顶 或 时间到 → 刷帧
        if self.buf.len() >= self.max_events || self.last_flush.elapsed() >= self.interval {
            return self.flush();
        }
        Vec::new()
    }

    /// 强制刷帧。
    pub fn flush(&mut self) -> Vec<ProgressEvent> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let batch = std::mem::take(&mut self.buf);
        self.last_flush = Instant::now();
        self.flushed_frames += 1;
        batch
    }

    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

impl Default for FrameCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

/// UI 桥接实现。
///
/// 测试与无界面场景使用 `AutoDenyBridge`（全拒），
/// 真实 UI 用 `RecordingBridge` 记录请求供前端轮询。
pub struct AutoDenyBridge {
    /// 风险确认的固定答复。
    pub risk_answer: bool,
    /// 写操作的固定裁决。
    pub write_answer: WriteDecision,
    /// 已收到的写请求数（可观测）。
    pub write_requests: Arc<AtomicU64>,
    /// 合帧器。
    pub coalescer: std::sync::Mutex<FrameCoalescer>,
}

impl Default for AutoDenyBridge {
    fn default() -> Self {
        Self {
            // fail-closed 默认值
            risk_answer: false,
            write_answer: WriteDecision::Deny,
            write_requests: Arc::new(AtomicU64::new(0)),
            coalescer: std::sync::Mutex::new(FrameCoalescer::new()),
        }
    }
}

impl AutoDenyBridge {
    /// 全放行的测试桥（仅测试用——生产必须用 fail-closed 默认值）。
    pub fn permissive() -> Self {
        Self {
            risk_answer: true,
            write_answer: WriteDecision::Once,
            write_requests: Arc::new(AtomicU64::new(0)),
            coalescer: std::sync::Mutex::new(FrameCoalescer::new()),
        }
    }

    pub fn write_request_count(&self) -> u64 {
        self.write_requests.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl UiBridge for AutoDenyBridge {
    async fn confirm_risk(&self, _manifest: &str) -> bool {
        self.risk_answer
    }

    async fn confirm_write(&self, _req: &WriteRequest) -> WriteDecision {
        self.write_requests.fetch_add(1, Ordering::SeqCst);
        self.write_answer
    }

    async fn request_takeover(&self, _step: u32) -> String {
        // 默认不接管
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalescer_buffers_until_interval() {
        let mut c = FrameCoalescer::with_interval(10_000); // 10 秒，不会自然触发
        let out = c.push(ProgressEvent::TokenDelta("a".into()));
        assert!(out.is_empty(), "未到间隔不应交付");
        assert_eq!(c.pending(), 1);
    }

    #[test]
    fn coalescer_flushes_at_capacity() {
        let mut c = FrameCoalescer::with_interval(10_000);
        let mut delivered = Vec::new();
        for i in 0..64 {
            delivered.extend(c.push(ProgressEvent::TokenDelta(format!("t{i}"))));
        }
        assert_eq!(delivered.len(), 64, "容量到顶应整批交付");
        assert_eq!(c.flushed_frames, 1);
    }

    #[test]
    fn coalescer_manual_flush() {
        let mut c = FrameCoalescer::with_interval(10_000);
        c.push(ProgressEvent::TokenDelta("x".into()));
        let batch = c.flush();
        assert_eq!(batch.len(), 1);
        assert_eq!(c.pending(), 0);
    }

    #[test]
    fn coalescer_empty_flush_is_noop() {
        let mut c = FrameCoalescer::new();
        assert!(c.flush().is_empty());
        assert_eq!(c.flushed_frames, 0);
    }

    #[test]
    fn coalescer_counts_total_events() {
        let mut c = FrameCoalescer::with_interval(10_000);
        for _ in 0..5 {
            c.push(ProgressEvent::TokenDelta("x".into()));
        }
        assert_eq!(c.total_events, 5);
    }

    #[tokio::test]
    async fn auto_deny_bridge_denies_write_by_default() {
        let b = AutoDenyBridge::default();
        let d = b
            .confirm_write(&WriteRequest {
                tool_name: "t".into(),
                operation: "write".into(),
                target: "x".into(),
            })
            .await;
        assert_eq!(d, WriteDecision::Deny, "默认必须 fail-closed");
    }

    #[tokio::test]
    async fn auto_deny_bridge_rejects_risk_by_default() {
        let b = AutoDenyBridge::default();
        assert!(!b.confirm_risk("危险操作").await, "默认必须拒绝风险");
    }

    #[tokio::test]
    async fn bridge_counts_write_requests() {
        let b = AutoDenyBridge::default();
        let req = WriteRequest {
            tool_name: "t".into(),
            operation: "write".into(),
            target: "x".into(),
        };
        b.confirm_write(&req).await;
        b.confirm_write(&req).await;
        assert_eq!(b.write_request_count(), 2);
    }

    #[tokio::test]
    async fn takeover_defaults_to_empty() {
        let b = AutoDenyBridge::default();
        assert!(b.request_takeover(1).await.is_empty());
    }
}
