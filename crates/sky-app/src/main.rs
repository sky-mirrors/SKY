//! SKY 应用入口。
//!
//! 对应现状 `electron/main.ts`（284 行）。
//!
//! **多窗口关键约束**（Wave 0 探针实证）：
//! `new_window(dom, cfg)` 必须在 `spawn` 内 await——WebView2 不支持在
//! webview 回调内同步建窗（wry#583 / dioxus#3080）。

use sky_app::ui::MainView;
use sky_app::window::{OpenAction, WindowId, WindowRegistry};

fn main() {
    dioxus::LaunchBuilder::new()
        .with_cfg(
            dioxus::desktop::Config::new().with_window(
                dioxus::desktop::WindowBuilder::new()
                    .with_title(WindowId::Main.title())
                    .with_inner_size(dioxus::desktop::LogicalSize::new(
                        WindowId::Main.size().0,
                        WindowId::Main.size().1,
                    )),
            ),
        )
        .launch(MainView);
}

/// 打开一个窗口。
///
/// 返回实际执行的动作，供调用方记录/断言。
/// **必须在 async 上下文中调用**（见模块文档的多窗口约束）。
pub async fn open_window(registry: &mut WindowRegistry, id: WindowId) -> OpenAction {
    let action = registry.request_open(id);
    match action {
        OpenAction::FocusExisting(_) => {
            // 真实实现：聚焦已存在的窗口
        }
        OpenAction::Create(_) => {
            // 真实实现：
            //   let ctx = dioxus::desktop::window();
            //   let cfg = Config::new().with_window(
            //       WindowBuilder::new().with_title(id.title())...);
            //   let dom = VirtualDom::new(view_for(id));
            //   let w = ctx.new_window(dom, cfg).await;  // 必须 await
            //   std::mem::forget(w);  // 保留句柄
        }
    }
    action
}
