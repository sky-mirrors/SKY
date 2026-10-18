//! 应用自动化——SKY 作为 harness 驱动 ChemDraw / Origin（95 册 §9.7 化学台）。
//!
//! **用户裁定**：SKY 是 harness，应当能操作专业软件，而不是绕开它们。
//! Windows 上的正式通道是 COM 自动化：
//! - Origin：`Origin.ApplicationSI` COM 服务器 + LabTalk 脚本（官方支持）
//! - ChemDraw：`ChemDraw.Application` COM 对象模型
//!
//! **安全姿态（与 shell_exec 同源，fail-closed）**：
//! 1. **操作模板白名单**——只允许固定的操作模板（打开工程 / 导入数据 /
//!    跑 LabTalk / 导出图），用户/任务书只能填参数，不能拼脚本
//! 2. **路径转义**——参数中的路径必须经 `escape_path` 规范化（引号包裹 +
//!    内部引号加倍），防注入
//! 3. **不可解释即拒绝**——未知应用/操作模板直接报错，不猜
//!
//! 纯逻辑层：本模块只产出「要执行的命令串」，真实 COM 调用由调用方
//! 经 `std::process::Command`（powershell）执行——与 shell_exec 的
//! 闸门/执行分离同构，便于单测。

use serde_json::Value;

/// 支持自动化的应用与 COM ProgID。
pub const AUTOMATION_APPS: &[(&str, &str)] = &[
    ("origin", "Origin.ApplicationSI"),
    ("chemdraw", "ChemDraw.Application"),
];

/// 操作模板。`{app}` `{path}` `{script}` 为参数槽位。
pub const OPERATION_TEMPLATES: &[(&str, &str)] = &[
    // 打开/激活应用
    ("open", "$app = New-Object -ComObject {progid}"),
    // 导入数据文件到 Origin 工程并保存
    (
        "import_data",
        "$app = New-Object -ComObject {progid}; \
         $app.Execute(\"doc -o {path}\"); \
         $app.Execute(\"impfile type:=csv fname:={path2}\")",
    ),
    // 执行 LabTalk 脚本文件（Origin 专属）
    (
        "run_script",
        "$app = New-Object -ComObject {progid}; \
         $app.Execute(\"run -p {path}\")",
    ),
    // 导出当前图到图片文件
    (
        "export_graph",
        "$app = New-Object -ComObject {progid}; \
         $app.Execute(\"expGraph type:=png path:={path}\")",
    ),
    // 打开文档（ChemDraw/Origin 通用：让应用打开指定文件）
    (
        "open_document",
        "$app = New-Object -ComObject {progid}; \
         $app.Visible = $true; \
         $app.Documents.Open(\"{path}\")",
    ),
];

/// 路径参数转义：反斜杠规范化 + 双引号包裹 + 内部双引号加倍。
/// PowerShell 单引号串内不展开变量，最安全；这里统一单引号包裹。
pub fn escape_path(p: &str) -> String {
    let normalized = p.replace('/', "\\");
    format!("'{}'", normalized.replace('\'', "''"))
}

/// 校验参数并渲染命令。
///
/// fail-closed：应用不在白名单 / 操作不在模板表 / 缺参数 / 参数含可疑
/// 形态（路径外引号、分号、反引号、`$`、换行）→ Err。
pub fn render_automation(app: &str, operation: &str, params: &Value) -> Result<String, String> {
    // 闸门 1：应用白名单
    let (_, progid) = AUTOMATION_APPS
        .iter()
        .find(|(name, _)| *name == app)
        .ok_or_else(|| {
            format!(
                "app_automate 拒绝：应用「{app}」不在自动化白名单。支持：{}",
                AUTOMATION_APPS
                    .iter()
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;

    // 闸门 2：操作模板白名单
    let template = OPERATION_TEMPLATES
        .iter()
        .find(|(name, _)| *name == operation)
        .map(|(_, t)| *t)
        .ok_or_else(|| {
            format!(
                "app_automate 拒绝：操作「{operation}」不在模板表。支持：{}",
                OPERATION_TEMPLATES
                    .iter()
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;

    // 闸门 3：参数提取与消毒
    let obj = params.as_object().ok_or("app_automate 需要 object 参数")?;
    let mut rendered = template.replace("{progid}", progid);
    for (k, v) in obj {
        let val = v.as_str().ok_or_else(|| format!("参数 {k} 必须是字符串"))?;
        // 闸门 3a：可疑形态一律拒绝（引号逃逸、命令拼接、变量展开）
        if val.contains('\'')
            || val.contains(';')
            || val.contains('`')
            || val.contains('$')
            || val.contains('\n')
            || val.contains('"')
        {
            return Err(format!(
                "app_automate 拒绝：参数 {k} 含不允许的字符（引号/分号/反引号/$/换行）"
            ));
        }
        let escaped = escape_path(val);
        rendered = rendered.replace(&format!("{{{k}}}"), &escaped);
        // path2 是同一文件的第二引用（import_data 模板）
        if k == "path" {
            rendered = rendered.replace("{path2}", &escaped);
        }
    }

    // 闸门 4：模板中残留未填充的槽位 → 缺参数
    if rendered.contains("{path}") || rendered.contains("{path2}") {
        return Err("app_automate 拒绝：该操作需要 path 参数（数据/工程文件路径）".into());
    }

    Ok(rendered)
}

/// 该机器上应用是否可用（COM ProgID 注册探测）。
/// 返回 (应用名, 是否注册)。探测本身无害——只查注册表键存在性。
pub fn availability_probe() -> Vec<(String, bool)> {
    AUTOMATION_APPS
        .iter()
        .map(|(name, progid)| {
            let registered = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "[bool](Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\{progid}' -ErrorAction SilentlyContinue)"
                    ),
                ])
                .output()
                .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "True")
                .unwrap_or(false);
            (name.to_string(), registered)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn escape_path_handles_backslashes_and_quotes() {
        assert_eq!(escape_path("C:/Data/a.csv"), "'C:\\Data\\a.csv'");
        assert_eq!(escape_path("it's.csv"), "'it''s.csv'");
    }

    #[test]
    fn unknown_app_denied() {
        let r = render_automation("word", "open", &json!({}));
        assert!(r.unwrap_err().contains("不在自动化白名单"));
    }

    #[test]
    fn unknown_operation_denied() {
        let r = render_automation("origin", "format_disk", &json!({}));
        assert!(r.unwrap_err().contains("不在模板表"));
    }

    /// 注入攻击面：参数带分号/引号/$ 一律拒绝——命令拼接进不来。
    #[test]
    fn injection_characters_denied() {
        for bad in [
            "a.csv'; Remove-Item C:\\ -Recurse; '",
            "a$(calc).csv",
            "a`b.csv",
            "a\nb.csv",
        ] {
            let r = render_automation("origin", "import_data", &json!({ "path": bad }));
            assert!(r.is_err(), "含注入形态的参数应被拒绝：{bad}");
        }
    }

    #[test]
    fn missing_path_denied_for_import() {
        let r = render_automation("origin", "import_data", &json!({}));
        assert!(r.unwrap_err().contains("需要 path 参数"));
    }

    #[test]
    fn valid_import_renders_command() {
        let r = render_automation(
            "origin",
            "import_data",
            &json!({ "path": "C:/Data/spectrum.csv" }),
        )
        .unwrap();
        assert!(r.contains("Origin.ApplicationSI"), "{r}");
        assert!(r.contains("'C:\\Data\\spectrum.csv'"), "{r}");
        assert!(!r.contains("{path}"), "槽位应全部填充：{r}");
    }

    #[test]
    fn chemdraw_open_document_renders() {
        let r = render_automation(
            "chemdraw",
            "open_document",
            &json!({ "path": "C:/Structures/aspirin.cdx" }),
        )
        .unwrap();
        assert!(r.contains("ChemDraw.Application"), "{r}");
        assert!(r.contains("Documents.Open"), "{r}");
    }

    /// 操作模板表本身就是安全边界：模板是固定串，参数只能落在转义槽位。
    #[test]
    fn templates_are_fixed_and_few() {
        // 模板数量收敛（今天 5 个），每个都不含用户可控的自由段
        assert!(OPERATION_TEMPLATES.len() <= 8);
        for (_, t) in OPERATION_TEMPLATES {
            assert!(t.contains("New-Object -ComObject"), "模板应经 COM：{t}");
        }
    }
}
