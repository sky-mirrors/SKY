//! 窗口注册表。
//!
//! 对应现状 `electron/window-manager.ts` 的 8 个 BrowserWindow。
//!
//! **关键实现约束（Wave 0 探针实证）**：
//! `DesktopContext::new_window(dom, cfg)` 返回 future，**必须在 `spawn` 内 await**。
//! 原因见 `dioxus-desktop-0.7.10/src/desktop_context.rs:120-124` 注释：
//! WebView2 不支持在 webview 回调内同步创建窗口（wry#583 / dioxus#3080）。
//! 在事件处理器里同步调用会静默失败——窗口不出现且无错误。
//!
//! 8 个窗口共享**单一真相源**（`Arc<AppState>`），各窗口订阅而非各自持有副本。
//! 这修复了现状靠 `storeSyncToPipeline` 等四组通道手工同步的脆弱点。

use serde::{Deserialize, Serialize};

/// 窗口标识。对齐现状 8 个 HTML 入口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowId {
    /// `index.html` —— 主对话窗口
    Main,
    /// `pipeline.html` —— 流水线工作台
    Pipeline,
    /// `debug.html` —— 调试监视器
    Debug,
    /// `dev.html` —— 开发者端
    Dev,
    /// `knowledge.html` —— 知识库
    Knowledge,
    /// `packs.html` —— 领域包编辑器
    Packs,
    /// `benchmark.html` —— Token 优化压测台
    Benchmark,
    /// `rule-review.html` —— 规则审核
    RuleReview,
}

impl WindowId {
    /// 全部窗口，按现状启动顺序。
    pub const ALL: [WindowId; 8] = [
        WindowId::Main,
        WindowId::Pipeline,
        WindowId::Debug,
        WindowId::Dev,
        WindowId::Knowledge,
        WindowId::Packs,
        WindowId::Benchmark,
        WindowId::RuleReview,
    ];

    /// 窗口标题。对齐 `window-manager.ts` 的 title。
    pub fn title(&self) -> &'static str {
        match self {
            WindowId::Main => "SKY",
            WindowId::Pipeline => "SKY - 流水线工作台",
            WindowId::Debug => "SKY - 调试监视器",
            WindowId::Dev => "SKY - 开发者端",
            WindowId::Knowledge => "SKY - 知识库",
            WindowId::Packs => "SKY - 领域包编辑器",
            WindowId::Benchmark => "SKY - Token优化压测台",
            WindowId::RuleReview => "SKY - 规则审核",
        }
    }

    /// 默认尺寸。对齐 `window-manager.ts` 各 BrowserWindow 的 width/height。
    pub fn size(&self) -> (f64, f64) {
        match self {
            WindowId::Main => (1280.0, 800.0),
            WindowId::Pipeline => (1200.0, 800.0),
            WindowId::Debug => (800.0, 400.0),
            WindowId::Dev => (1100.0, 720.0),
            WindowId::Knowledge => (900.0, 680.0),
            WindowId::Packs => (1100.0, 780.0),
            WindowId::Benchmark => (1000.0, 700.0),
            WindowId::RuleReview => (1000.0, 700.0),
        }
    }

    /// 是否为单例窗口（重复打开时聚焦已有实例而非新建）。
    ///
    /// 对齐现状：所有 8 个窗口都是单例——`window-manager.ts` 用
    /// `if (win && !win.isDestroyed()) { win.focus(); return }` 保护。
    pub fn is_singleton(&self) -> bool {
        true
    }
}

/// 窗口注册表。
#[derive(Debug, Default)]
pub struct WindowRegistry {
    open: Vec<WindowId>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self { open: Vec::new() }
    }

    /// 请求打开窗口。返回 `OpenAction` 指示调用方该做什么。
    pub fn request_open(&mut self, id: WindowId) -> OpenAction {
        if id.is_singleton() && self.open.contains(&id) {
            return OpenAction::FocusExisting(id);
        }
        self.open.push(id);
        OpenAction::Create(id)
    }

    /// 标记窗口已关闭。
    pub fn on_closed(&mut self, id: WindowId) {
        self.open.retain(|w| *w != id);
    }

    pub fn is_open(&self, id: WindowId) -> bool {
        self.open.contains(&id)
    }

    pub fn open_windows(&self) -> &[WindowId] {
        &self.open
    }

    pub fn count(&self) -> usize {
        self.open.len()
    }
}

/// 打开动作。调用方据此决定是新建还是聚焦。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAction {
    Create(WindowId),
    FocusExisting(WindowId),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_eight_windows_defined() {
        assert_eq!(WindowId::ALL.len(), 8);
    }

    #[test]
    fn window_titles_match_current_app() {
        assert_eq!(WindowId::Main.title(), "SKY");
        assert_eq!(WindowId::Pipeline.title(), "SKY - 流水线工作台");
        assert_eq!(WindowId::Debug.title(), "SKY - 调试监视器");
        assert_eq!(WindowId::Benchmark.title(), "SKY - Token优化压测台");
    }

    #[test]
    fn window_sizes_match_current_app() {
        assert_eq!(WindowId::Main.size(), (1280.0, 800.0));
        assert_eq!(WindowId::Debug.size(), (800.0, 400.0));
    }

    /// 单例语义：重复请求同一窗口应聚焦而非新建。
    #[test]
    fn duplicate_request_focuses_existing() {
        let mut r = WindowRegistry::new();
        assert_eq!(r.request_open(WindowId::Main), OpenAction::Create(WindowId::Main));
        assert_eq!(
            r.request_open(WindowId::Main),
            OpenAction::FocusExisting(WindowId::Main),
            "单例窗口重复打开应聚焦"
        );
        assert_eq!(r.count(), 1);
    }

    #[test]
    fn different_windows_open_independently() {
        let mut r = WindowRegistry::new();
        r.request_open(WindowId::Main);
        r.request_open(WindowId::Pipeline);
        assert_eq!(r.count(), 2);
        assert!(r.is_open(WindowId::Main));
        assert!(r.is_open(WindowId::Pipeline));
    }

    #[test]
    fn closed_window_removed() {
        let mut r = WindowRegistry::new();
        r.request_open(WindowId::Debug);
        r.on_closed(WindowId::Debug);
        assert!(!r.is_open(WindowId::Debug));
        assert_eq!(r.count(), 0);
    }

    /// 关闭后可重新打开（不残留单例标记）。
    #[test]
    fn reopen_after_close_creates_new() {
        let mut r = WindowRegistry::new();
        r.request_open(WindowId::Debug);
        r.on_closed(WindowId::Debug);
        assert_eq!(
            r.request_open(WindowId::Debug),
            OpenAction::Create(WindowId::Debug),
            "关闭后重开应新建而非聚焦"
        );
    }

    #[test]
    fn window_id_serializes_kebab_case() {
        let j = serde_json::to_string(&WindowId::RuleReview).unwrap();
        assert_eq!(j, "\"rule-review\"");
        let j2 = serde_json::to_string(&WindowId::Main).unwrap();
        assert_eq!(j2, "\"main\"");
    }
}
