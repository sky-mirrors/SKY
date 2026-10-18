//! 用户目录配置文件。
//!
//! 免去每次启动都设环境变量的麻烦——密钥、模型、端点可以写进配置文件。
//!
//! **位置**：`<用户配置目录>/sky/config.toml`
//! - Windows: `C:\Users\<用户名>\AppData\Roaming\sky\config.toml`
//! - macOS:   `~/Library/Application Support/sky/config.toml`
//! - Linux:   `~/.config/sky/config.toml`
//!
//! 可用环境变量 `SKY_CONFIG` 覆盖路径（测试与多环境切换用）。
//!
//! **优先级**：环境变量 > 配置文件。这样临时切换密钥不必改文件。
//!
//! **fail-closed 约定**：
//! - 文件不存在 → 正常，用默认值（`Missing`）
//! - 文件存在但解析失败 → 报错，不当默认值处理（`Invalid`）
//! - 出现未知键 → 报错。`api_ky = "..."` 这类拼写错误静默失效
//!   会让人排查很久，宁可大声失败。
//!
//! 密钥绝不写入仓库——配置文件在用户目录下，不在工作区内。

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 覆盖配置文件路径的环境变量。
pub const CONFIG_PATH_ENV: &str = "SKY_CONFIG";

/// 默认模型。
pub const DEFAULT_MODEL: &str = "glm-4-flash";

/// 配置文件内容。
///
/// `deny_unknown_fields`：拼错的键名会被拒绝而非静默忽略。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserConfig {
    /// GLM 密钥。留空等同于未配置。
    pub api_key: Option<String>,
    /// 模型名。缺省用 [`DEFAULT_MODEL`]。
    pub model: Option<String>,
    /// 端点。缺省用 [`crate::GLM_BASE_URL`]。
    pub base_url: Option<String>,
}

/// 配置文件加载结果。
///
/// 三态而非 `Option`——「不存在」和「坏了」必须区分。
#[derive(Debug, Clone, PartialEq)]
pub enum ConfigLoad {
    /// 文件不存在。正常情况，用默认值。
    Missing,
    /// 加载成功。
    Loaded(UserConfig),
    /// 文件存在但无法解析。**调用方应把原因报给用户**，
    /// 不能静默当默认值——否则用户改了配置却没生效，
    /// 会以为是自己写错了别的地方。
    Invalid { path: PathBuf, reason: String },
}

impl ConfigLoad {
    /// 取配置内容；`Missing` 与 `Invalid` 都返回默认值。
    ///
    /// 需要区分二者时用 [`ConfigLoad::warning`]。
    pub fn config(&self) -> UserConfig {
        match self {
            ConfigLoad::Loaded(c) => c.clone(),
            _ => UserConfig::default(),
        }
    }

    /// 供 UI 展示的警告文本。`Missing` 返回 `None`（正常，无需打扰用户）。
    pub fn warning(&self) -> Option<String> {
        match self {
            ConfigLoad::Missing | ConfigLoad::Loaded(_) => None,
            ConfigLoad::Invalid { path, reason } => Some(format!(
                "配置文件 {} 无法解析：{reason}（已忽略，使用默认值）",
                path.display()
            )),
        }
    }
}

/// 配置文件路径。
///
/// 优先 `SKY_CONFIG`；未设置时落到用户配置目录。
/// 两者都取不到（极少数环境）返回 `None`。
pub fn config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(CONFIG_PATH_ENV) {
        let p = p.trim();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::config_dir().map(|d| d.join("sky").join("config.toml"))
}

/// 从指定路径加载。
pub fn load_from(path: &Path) -> ConfigLoad {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ConfigLoad::Missing,
        Err(e) => {
            return ConfigLoad::Invalid {
                path: path.to_path_buf(),
                reason: format!("读取失败：{e}"),
            }
        }
    };

    match toml::from_str::<UserConfig>(&text) {
        Ok(c) => ConfigLoad::Loaded(c),
        Err(e) => ConfigLoad::Invalid {
            path: path.to_path_buf(),
            reason: e.message().to_string(),
        },
    }
}

/// 加载用户目录配置。
pub fn load() -> ConfigLoad {
    match config_path() {
        Some(p) => load_from(&p),
        None => ConfigLoad::Missing,
    }
}

/// 解析后的生效配置——环境变量与配置文件合并的最终结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedConfig {
    /// 生效密钥。`None` 表示未配置。
    pub api_key: Option<String>,
    /// 生效模型名。
    pub model: String,
    /// 生效端点。
    pub base_url: String,
    /// 配置文件解析失败时的警告文本，供 UI 展示。
    pub warning: Option<String>,
}

/// 合并环境变量与配置文件，得到生效配置。
///
/// 优先级：`SKY_GLM_API_KEY` 环境变量 > 配置文件 `api_key`。
pub fn resolve() -> ResolvedConfig {
    let load = load();
    let file = load.config();

    let env_key = crate::api_key_from_env();
    let file_key = file
        .api_key
        .as_ref()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());

    ResolvedConfig {
        api_key: env_key.or(file_key),
        model: file
            .model
            .as_ref()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        base_url: file
            .base_url
            .as_ref()
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| crate::GLM_BASE_URL.to_string()),
        warning: load.warning(),
    }
}

/// 生成一份带注释的配置模板，便于用户照着填。
pub fn template() -> String {
    format!(
        "# SKY 配置\n\
         # 位置：{}（也可用环境变量 {CONFIG_PATH_ENV} 覆盖）\n\
         #\n\
         # 环境变量 SKY_GLM_API_KEY 优先级高于本文件，可临时覆盖。\n\n\
         # 智谱 GLM 密钥，从 https://open.bigmodel.cn 获取\n\
         api_key = \"\"\n\n\
         # 模型名，缺省 {DEFAULT_MODEL}\n\
         # model = \"{DEFAULT_MODEL}\"\n\n\
         # 端点，缺省 {}\n\
         # base_url = \"{}\"\n",
        config_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<用户配置目录>/sky/config.toml".into()),
        crate::GLM_BASE_URL,
        crate::GLM_BASE_URL,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 环境变量是进程级的，测试并行跑会互相污染——串行化。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 写一个临时配置文件，返回路径。调用方负责清理。
    fn temp_config(name: &str, content: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sky-cfg-test-{name}.toml"));
        std::fs::write(&p, content).expect("写临时配置失败");
        p
    }

    fn cleanup(p: &Path) {
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn missing_file_is_missing_not_invalid() {
        let p = std::env::temp_dir().join("sky-cfg-test-definitely-absent.toml");
        cleanup(&p);
        assert_eq!(load_from(&p), ConfigLoad::Missing);
        assert!(load_from(&p).warning().is_none(), "文件不存在不该打扰用户");
    }

    #[test]
    fn valid_file_loads() {
        let p = temp_config(
            "valid",
            "api_key = \"k-123\"\nmodel = \"glm-4-plus\"\nbase_url = \"https://x/v4\"\n",
        );
        let got = load_from(&p);
        cleanup(&p);
        assert_eq!(
            got,
            ConfigLoad::Loaded(UserConfig {
                api_key: Some("k-123".into()),
                model: Some("glm-4-plus".into()),
                base_url: Some("https://x/v4".into()),
            })
        );
    }

    #[test]
    fn malformed_file_is_invalid_not_silently_defaulted() {
        let p = temp_config("malformed", "this is not = = toml\n");
        let got = load_from(&p);
        cleanup(&p);
        match got {
            ConfigLoad::Invalid { reason, .. } => assert!(!reason.is_empty(), "必须给出原因"),
            other => panic!("损坏的配置必须报 Invalid，实际：{other:?}"),
        }
    }

    #[test]
    fn invalid_file_surfaces_warning_with_path() {
        let p = temp_config("warn", "api_key = [unclosed\n");
        let got = load_from(&p);
        let w = got.warning().expect("Invalid 必须给出警告");
        cleanup(&p);
        assert!(w.contains("无法解析"), "警告应说明解析失败：{w}");
        assert!(
            w.contains(&p.display().to_string()),
            "警告应带上路径，用户才知道改哪个文件：{w}"
        );
    }

    /// 拼错的键名必须报错——静默忽略会让人排查很久。
    #[test]
    fn unknown_key_is_rejected() {
        let p = temp_config("typo", "api_ky = \"k-123\"\n");
        let got = load_from(&p);
        cleanup(&p);
        match got {
            ConfigLoad::Invalid { reason, .. } => {
                assert!(reason.contains("api_ky"), "应点名拼错的键：{reason}");
            }
            other => panic!("未知键必须报 Invalid，实际：{other:?}"),
        }
    }

    #[test]
    fn empty_api_key_in_file_treated_as_absent() {
        let p = temp_config("emptykey", "api_key = \"   \"\n");
        let got = load_from(&p);
        cleanup(&p);
        let cfg = got.config();
        assert_eq!(cfg.api_key.as_deref(), Some("   "));
        // resolve 层面才做 trim/空值过滤，这里验证过滤逻辑本身
        let filtered = cfg
            .api_key
            .as_ref()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        assert!(filtered.is_none(), "纯空白密钥应视为未配置");
    }

    #[test]
    fn resolve_prefers_env_over_file() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = temp_config("prio", "api_key = \"from-file\"\n");
        let prev_cfg = std::env::var(CONFIG_PATH_ENV).ok();
        let prev_key = std::env::var(crate::GLM_API_KEY_ENV).ok();

        std::env::set_var(CONFIG_PATH_ENV, &p);
        std::env::set_var(crate::GLM_API_KEY_ENV, "from-env");

        let got = resolve();
        assert_eq!(got.api_key.as_deref(), Some("from-env"), "环境变量应优先");

        // 还原
        cleanup(&p);
        match prev_cfg {
            Some(v) => std::env::set_var(CONFIG_PATH_ENV, v),
            None => std::env::remove_var(CONFIG_PATH_ENV),
        }
        match prev_key {
            Some(v) => std::env::set_var(crate::GLM_API_KEY_ENV, v),
            None => std::env::remove_var(crate::GLM_API_KEY_ENV),
        }
    }

    #[test]
    fn resolve_falls_back_to_file_when_env_absent() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = temp_config(
            "fallback",
            "api_key = \"from-file\"\nmodel = \"glm-4-plus\"\nbase_url = \"https://custom/v4/\"\n",
        );
        let prev_cfg = std::env::var(CONFIG_PATH_ENV).ok();
        let prev_key = std::env::var(crate::GLM_API_KEY_ENV).ok();

        std::env::set_var(CONFIG_PATH_ENV, &p);
        std::env::remove_var(crate::GLM_API_KEY_ENV);

        let got = resolve();
        assert_eq!(got.api_key.as_deref(), Some("from-file"));
        assert_eq!(got.model, "glm-4-plus");
        // 尾部斜杠应被归一化，避免拼出 //chat/completions
        assert_eq!(got.base_url, "https://custom/v4");
        assert!(got.warning.is_none());

        cleanup(&p);
        match prev_cfg {
            Some(v) => std::env::set_var(CONFIG_PATH_ENV, v),
            None => std::env::remove_var(CONFIG_PATH_ENV),
        }
        match prev_key {
            Some(v) => std::env::set_var(crate::GLM_API_KEY_ENV, v),
            None => std::env::remove_var(crate::GLM_API_KEY_ENV),
        }
    }

    #[test]
    fn resolve_uses_defaults_when_nothing_configured() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = std::env::temp_dir().join("sky-cfg-test-absent-defaults.toml");
        cleanup(&p);
        let prev_cfg = std::env::var(CONFIG_PATH_ENV).ok();
        let prev_key = std::env::var(crate::GLM_API_KEY_ENV).ok();

        std::env::set_var(CONFIG_PATH_ENV, &p);
        std::env::remove_var(crate::GLM_API_KEY_ENV);

        let got = resolve();
        assert_eq!(got.api_key, None);
        assert_eq!(got.model, DEFAULT_MODEL);
        assert_eq!(got.base_url, crate::GLM_BASE_URL);
        assert!(got.warning.is_none());

        match prev_cfg {
            Some(v) => std::env::set_var(CONFIG_PATH_ENV, v),
            None => std::env::remove_var(CONFIG_PATH_ENV),
        }
        match prev_key {
            Some(v) => std::env::set_var(crate::GLM_API_KEY_ENV, v),
            None => std::env::remove_var(crate::GLM_API_KEY_ENV),
        }
    }

    #[test]
    fn resolve_reports_invalid_config_as_warning() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = temp_config("invalid-resolve", "= broken\n");
        let prev_cfg = std::env::var(CONFIG_PATH_ENV).ok();

        std::env::set_var(CONFIG_PATH_ENV, &p);
        let got = resolve();
        cleanup(&p);

        assert!(
            got.warning.is_some(),
            "配置损坏必须带出警告，不能静默用默认值"
        );

        match prev_cfg {
            Some(v) => std::env::set_var(CONFIG_PATH_ENV, v),
            None => std::env::remove_var(CONFIG_PATH_ENV),
        }
    }

    #[test]
    fn config_path_honours_env_override() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var(CONFIG_PATH_ENV).ok();

        std::env::set_var(CONFIG_PATH_ENV, "/tmp/custom-sky.toml");
        assert_eq!(
            config_path(),
            Some(PathBuf::from("/tmp/custom-sky.toml")),
            "SKY_CONFIG 应覆盖默认路径"
        );

        // 空白值应回落到默认路径，而不是当成空路径
        std::env::set_var(CONFIG_PATH_ENV, "   ");
        let fallback = config_path();
        assert!(
            fallback.is_some(),
            "空白 SKY_CONFIG 应回落到用户配置目录"
        );
        assert!(
            fallback.unwrap().to_string_lossy().contains("sky"),
            "默认路径应含 sky 子目录"
        );

        match prev {
            Some(v) => std::env::set_var(CONFIG_PATH_ENV, v),
            None => std::env::remove_var(CONFIG_PATH_ENV),
        }
    }

    #[test]
    fn template_is_valid_and_parses() {
        let t = template();
        let parsed = toml::from_str::<UserConfig>(&t);
        assert!(
            parsed.is_ok(),
            "模板必须能被自己解析，否则用户复制即报错：{:?}",
            parsed.err()
        );
        // 模板里 api_key 留空 → 视为未配置
        let cfg = parsed.unwrap();
        assert_eq!(cfg.api_key.as_deref(), Some(""));
    }
}
