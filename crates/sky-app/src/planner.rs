//! LLM 规划器——探索路径的计划生成。
//!
//! 对应现状 L4 `buildExplorePlan`：当确定性段与检索段都无法匹配时，
//! 由 LLM 依据用户输入生成执行计划。
//!
//! 设计要点：
//! - 提示词要求 LLM **只输出 JSON**，解析失败时降级为空计划而非报错
//! - 生成的计划必须经 `sky-exec` 的拓扑排序验证（循环依赖会被拒）
//! - 任何工具名都须经安全层校验后才可执行（本模块只生成，不执行）

use serde_json::Value;
use sky_core::{PlanStep, TaskPlan};
use sky_llm::{ChatRequest, HttpProviderCall, ProviderCall};
use std::collections::BTreeMap;

/// 系统提示词。
///
/// 要求严格 JSON 输出——比解析自然语言更可靠，且便于校验。
pub const PLANNER_SYSTEM_PROMPT: &str = r#"你是任务规划器。根据用户请求生成执行计划。

只输出 JSON，不要任何解释、不要 markdown 代码块。格式：
{"intent":"意图简述","needs":["依赖项"],"steps":[{"step":1,"description":"步骤描述","tool":"工具名","depends_on":[],"expectedOutput":"预期输出"}]}

规则：
- steps 最多 5 步
- step 编号从 1 开始且连续
- depends_on 只能引用编号更小的步骤，禁止循环
- 若任务无需多步，返回单个步骤
- 工具名用简短英文标识（如 file_list、doc_convert、text_summarize）"#;

/// 规划结果。
#[derive(Debug, Clone, PartialEq)]
pub enum PlanOutcome {
    /// 成功生成计划。
    Planned(TaskPlan),
    /// LLM 返回无法解析——降级为空计划。
    Unparsable { raw: String, reason: String },
    /// 调用失败（无密钥、网络错误等）。
    Failed(String),
}

/// LLM 规划器。
pub struct LlmPlanner {
    caller: HttpProviderCall,
    model: String,
    base_url: String,
    /// 配置文件解析失败时的警告，随规划结果带出供 UI 展示。
    config_warning: Option<String>,
}

impl LlmPlanner {
    /// 从环境变量 + 用户目录配置构造。
    ///
    /// 无密钥时仍可构造，`plan` 会返回 `Failed`。
    pub fn from_env() -> Self {
        let cfg = sky_llm::resolve_config();
        Self {
            caller: match &cfg.api_key {
                Some(k) => HttpProviderCall::with_key(k),
                None => HttpProviderCall::from_env(),
            },
            model: cfg.model,
            base_url: cfg.base_url,
            config_warning: cfg.warning,
        }
    }

    /// 显式注入密钥（测试用）。
    pub fn with_key(key: impl Into<String>) -> Self {
        Self {
            caller: HttpProviderCall::with_key(key),
            model: sky_llm::DEFAULT_MODEL.into(),
            base_url: sky_llm::GLM_BASE_URL.into(),
            config_warning: None,
        }
    }

    pub fn has_key(&self) -> bool {
        self.caller.has_key()
    }

    /// 配置文件解析失败时的警告（若有）。UI 应展示它——
    /// 否则用户改了配置却没生效，会以为问题在别处。
    pub fn config_warning(&self) -> Option<&str> {
        self.config_warning.as_deref()
    }

    /// 为用户输入生成计划。
    pub async fn plan(&self, user_input: &str) -> PlanOutcome {
        self.plan_with_tools(user_input, &[]).await
    }

    /// 用指定的可用工具清单生成计划。
    ///
    /// **为什么必须传入工具清单**：实测发现不告诉 LLM 有哪些工具时，
    /// 它会凭空发明「终端」「ls」「打开终端」这类不存在的工具名，
    /// 导致每一步都「能力未接入」。把这个清单写进提示词，
    /// LLM 才会在真实能力范围内规划。
    pub async fn plan_with_tools(&self, user_input: &str, tools: &[&str]) -> PlanOutcome {
        let system = if tools.is_empty() {
            PLANNER_SYSTEM_PROMPT.to_string()
        } else {
            format!(
                "{PLANNER_SYSTEM_PROMPT}\n\n\
                 **本系统当前已接入的工具（只能用这些，禁止发明其它工具名）**：\n{}\n\n\
                 **params 必须携带工具所需的全部参数**。实测提醒：\
                 用户给出的路径/文件名一定要写进 params，\
                 不要放进 needs，也不要省略——needs 只放能力标签（如 file_access）。\n\n\
                 参数格式（params 是对象）：\n\
                 - file_list：{{\"dir\":\"目录路径\"}}\n\
                 - file_find：{{\"dir\":\"目录路径\",\"ext\":\"jpg,png\"}}\n\
                 - file_read：{{\"path\":\"文件路径\"}}\n\
                 - file_write：{{\"path\":\"路径\",\"content\":\"内容\"}}\n\
                 - folder_create：{{\"path\":\"目录路径\"}}\n\
                 - file_move：{{\"from\":\"源文件\",\"to\":\"目标目录\"}}\n\
                 - file_copy：{{\"from\":\"源\",\"to\":\"目标\"}}\n\
                 - text_summarize：{{\"text\":\"输入文本\"}}\n\
                 - text_extract：{{\"text\":\"输入文本\"}}\n\n\
                 完整示例——用户说「列出 /tmp/pics 下的文件」应输出：\n\
                 {{\"intent\":\"列出目录文件\",\"needs\":[\"file_access\"],\"steps\":[{{\"step\":1,\
                 \"description\":\"列出 /tmp/pics 下的文件\",\"tool\":\"file_list\",\
                 \"depends_on\":[],\"params\":{{\"dir\":\"/tmp/pics\"}},\"expectedOutput\":\"文件列表\"}}]}}",
                tools.join("、")
            )
        };

        let req = ChatRequest {
            messages: vec![
                sky_core::ChatMessage {
                    role: "system".into(),
                    content: system,
                    timestamp: None,
                },
                sky_core::ChatMessage {
                    role: "user".into(),
                    content: user_input.into(),
                    timestamp: None,
                },
            ],
            model: self.model.clone(),
            temperature: Some(0.1),
            max_tokens: Some(1200),
        };

        let cfg = sky_llm::glm_config_with(&self.model, &self.base_url);

        match self.caller.call(&cfg, &req).await {
            Ok(resp) => {
                let mut outcome = parse_plan(&resp.content);
                // LLM 常把路径放进 needs 或干脆省略，导致工具因缺参数失败。
                // 提示词约束对它不够硬（GLM-4-flash 实测反复不遵守），
                // 所以这里做确定性兜底：从用户原文抽出路径补进 params。
                if let PlanOutcome::Planned(plan) = &mut outcome {
                    backfill_paths(plan, user_input);
                }
                outcome
            }
            Err(e) => PlanOutcome::Failed(e),
        }
    }
}

/// 从用户输入里抽出看起来像文件/目录路径的片段。
///
/// 识别规则（保守，宁可漏也不要错）：
/// - 含 `/` 或 `\` 的连续非空白片段（如 `/tmp/pics`、`C:\Users\x`）
/// - 或以常见盘符开头的片段
fn extract_paths(text: &str) -> Vec<String> {
    // 先剔除 URL——必须在标点切分之前做。
    // 否则 `https://example.com/a` 会被 `:` 切分成 `https` 和
    // `//example.com/a`，后者看起来像路径（实测踩过）。
    let without_urls: String = text
        .split_whitespace()
        .filter(|w| !w.contains("://"))
        .collect::<Vec<_>>()
        .join(" ");

    // 不能只用 split_whitespace：中文标点（，。、（ ））不是空白字符，
    // 「/tmp/pics，然后统计」会被当成一个片段（实测）。所以先把标点
    // 统一替换成空格再切分。
    let normalized: String = without_urls
        .chars()
        .map(|c| {
            if matches!(
                c,
                '，' | '。'
                    | '、'
                    | '；'
                    | '：'
                    | '！'
                    | '？'
                    | ','
                    | ';'
                    | ':'
                    | '!'
                    | '?'
                    | '"'
                    | '\''
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '（'
                    | '）'
                    | '('
                    | ')'
                    | '【'
                    | '】'
                    | '['
                    | ']'
                    | '《'
                    | '》'
                    | '「'
                    | '」'
            ) {
                ' '
            } else {
                c
            }
        })
        .collect();

    normalized
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| matches!(c, '.' | '。')))
        .filter(|w| (w.contains('/') || w.contains('\\')) && w.chars().count() > 1)
        .map(|w| w.to_string())
        .collect()
}

/// 修正 Windows 路径的常见变形。
///
/// **实测问题**：LLM 输出 JSON 时会把 `C:\Users\...` 的盘符吃掉，
/// 变成 `\Users\...`（反斜杠被当成转义符）。这种路径在 Windows 上
/// 会被解释成「当前盘符下的路径」，列错地方甚至失败。
///
/// 处理：形如 `\Xxx\...` 且首段是常见顶层目录时，补回 `C:`。
/// 只补盘符不猜其它内容——宁可漏修也不要猜错路径。
fn normalize_win_path(raw: &str) -> String {
    // 只处理 Windows 风格路径（含反斜杠）。
    // Unix 路径（/tmp/x、/model/gave）必须原样保留——
    // 否则会把它篡改成 `\tmp\x`，在 Unix 上直接失效。
    if !raw.contains('\\') {
        return raw.to_string();
    }

    let p = raw.replace('/', "\\");
    // 已是完整路径（含盘符 `X:` 或 UNC `\\`）→ 原样返回
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return p;
    }
    if p.starts_with("\\\\") {
        return p;
    }
    // 单反斜杠开头 → 大概率是丢了盘符
    if p.starts_with('\\') {
        let first = p.trim_start_matches('\\').split('\\').next().unwrap_or("");
        let common = [
            "Users", "Program", "Windows", "temp", "Temp", "AppData", "桌面", "Documents",
        ];
        if common.iter().any(|c| first.eq_ignore_ascii_case(c)) {
            return format!("C:{p}");
        }
    }
    p
}

/// 把从用户原文抽出的路径补进步骤的 params。
///
/// **保守原则**：只补「目录型」参数（dir/path），且只在完全缺失时补。
///
/// **为什么不补 file_move 的 from/to**：实测教训——用户说
/// 「把 X 里的 a.jpg 移动到 Y」，原文里的路径片段是 [X, Y]，
/// 若把 X 当作 from，就会把**整个目录**搬走而不是那个文件。
/// 这是不可逆的破坏性操作。移动操作的参数必须由模型明确给出，
/// 模型没给就报错让用户确认，绝不猜。
fn backfill_paths(plan: &mut TaskPlan, user_input: &str) {
    // 先修正模型已给出的路径（如吃掉盘符的 `\Users\...`）。
    // 这不属于「猜测」——只是把被破坏的路径还原，不改变用户意图。
    for step in &mut plan.steps {
        for key in ["dir", "path", "from", "to", "source", "target"] {
            if let Some(Value::String(v)) = step.params.get(key) {
                let fixed = normalize_win_path(v);
                if fixed != *v {
                    step.params.insert(key.to_string(), Value::String(fixed));
                }
            }
        }
    }

    let paths = extract_paths(user_input);
    if paths.is_empty() {
        return;
    }
    let primary = paths[0].clone();

    for step in &mut plan.steps {
        // 只处理「只读」类工具——补错了顶多查错地方，不会破坏数据。
        let read_only_dir = matches!(
            step.tool.as_str(),
            "file_list" | "list_files" | "file_find" | "file_search"
        );
        let read_only_path = matches!(step.tool.as_str(), "file_read" | "read_file");

        if read_only_dir && !step.params.contains_key("dir") && !step.params.contains_key("path") {
            step.params
                .insert("dir".into(), Value::String(primary.clone()));
        }
        if read_only_path && !step.params.contains_key("path") {
            step.params
                .insert("path".into(), Value::String(primary.clone()));
        }
        // 写操作（file_move/file_copy/file_write/folder_create）一律不兜底：
        // 猜错会造成不可逆的数据移动。缺参数时让工具报错，
        // 由用户明确指定后再执行。
    }
}

/// 从 LLM 输出解析计划。
///
/// 容错处理：
/// - 剥掉可能的 markdown 代码块围栏
/// - 提取第一个 `{` 到最后一个 `}` 之间的内容
/// - 校验步骤编号连续性与依赖方向
pub fn parse_plan(raw: &str) -> PlanOutcome {
    let cleaned = extract_json(raw);

    let v: Value = match serde_json::from_str(&cleaned) {
        Ok(v) => v,
        Err(e) => {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: format!("JSON 解析失败：{e}"),
            }
        }
    };

    let intent = v
        .get("intent")
        .and_then(|i| i.as_str())
        .unwrap_or("未命名任务")
        .to_string();

    let needs: Vec<String> = v
        .get("needs")
        .and_then(|n| n.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let steps_json = match v.get("steps").and_then(|s| s.as_array()) {
        Some(s) => s,
        None => {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: "缺少 steps 数组".into(),
            }
        }
    };

    let mut steps: Vec<PlanStep> = Vec::new();
    for s in steps_json {
        let num = match s.get("step").and_then(|x| x.as_u64()) {
            Some(n) => n as u32,
            None => {
                return PlanOutcome::Unparsable {
                    raw: raw.to_string(),
                    reason: "步骤缺少 step 编号".into(),
                }
            }
        };
        let tool = s
            .get("tool")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();

        let depends_on: Vec<u32> = s
            .get("depends_on")
            .and_then(|d| d.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
            .unwrap_or_default();

        steps.push(PlanStep {
            step: num,
            description: s
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            tool,
            depends_on,
            params: BTreeMap::new(),
            expected_output: s
                .get("expectedOutput")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            fallback: None,
        });
    }

    // 校验：编号从 1 开始且连续
    steps.sort_by_key(|s| s.step);
    for (i, s) in steps.iter().enumerate() {
        if s.step != (i as u32) + 1 {
            return PlanOutcome::Unparsable {
                raw: raw.to_string(),
                reason: format!("步骤编号不连续：期望 {}，得到 {}", i + 1, s.step),
            };
        }
    }

    // 校验：依赖只能指向更小的编号（杜绝循环）
    for s in &steps {
        for d in &s.depends_on {
            if *d >= s.step {
                return PlanOutcome::Unparsable {
                    raw: raw.to_string(),
                    reason: format!("步骤 {} 依赖了非更早的步骤 {}", s.step, d),
                };
            }
        }
    }

    if steps.is_empty() {
        return PlanOutcome::Unparsable {
            raw: raw.to_string(),
            reason: "steps 为空".into(),
        };
    }

    PlanOutcome::Planned(TaskPlan {
        intent,
        needs,
        steps,
    })
}

/// 从可能含 markdown 围栏的文本中提取 JSON。
fn extract_json(raw: &str) -> String {
    let t = raw.trim();
    // 剥 ```json ... ``` 围栏
    let t = if let Some(rest) = t.strip_prefix("```json") {
        rest.trim_start()
    } else if let Some(rest) = t.strip_prefix("```") {
        rest.trim_start()
    } else {
        t
    };
    let t = t.strip_suffix("```").unwrap_or(t).trim();

    // 取第一个 { 到最后一个 }
    match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => t[a..=b].to_string(),
        _ => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let raw = r#"{"intent":"整理文件","needs":["file_access"],"steps":[{"step":1,"description":"列出文件","tool":"file_list","depends_on":[],"expectedOutput":"列表"}]}"#;
        match parse_plan(raw) {
            PlanOutcome::Planned(p) => {
                assert_eq!(p.intent, "整理文件");
                assert_eq!(p.steps.len(), 1);
                assert_eq!(p.steps[0].tool, "file_list");
            }
            other => panic!("期望 Planned，得到 {other:?}"),
        }
    }

    /// 容错：LLM 常加 markdown 围栏。
    #[test]
    fn parses_json_in_markdown_fence() {
        let raw = "```json\n{\"intent\":\"x\",\"steps\":[{\"step\":1,\"tool\":\"t\"}]}\n```";
        assert!(matches!(parse_plan(raw), PlanOutcome::Planned(_)));
    }

    #[test]
    fn parses_json_with_surrounding_prose() {
        let raw = "好的，这是计划：{\"intent\":\"x\",\"steps\":[{\"step\":1,\"tool\":\"t\"}]} 希望有帮助";
        assert!(matches!(parse_plan(raw), PlanOutcome::Planned(_)));
    }

    #[test]
    fn parses_multistep_with_dependencies() {
        let raw = r#"{"intent":"x","steps":[
            {"step":1,"tool":"a","depends_on":[]},
            {"step":2,"tool":"b","depends_on":[1]}
        ]}"#;
        match parse_plan(raw) {
            PlanOutcome::Planned(p) => {
                assert_eq!(p.steps.len(), 2);
                assert_eq!(p.steps[1].depends_on, vec![1]);
            }
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：非 JSON 输入必须降级而非 panic。
    #[test]
    fn rejects_non_json() {
        match parse_plan("这不是 JSON") {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("JSON")),
            other => panic!("期望 Unparsable，得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_steps() {
        match parse_plan(r#"{"intent":"x"}"#) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("steps")),
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_steps() {
        match parse_plan(r#"{"intent":"x","steps":[]}"#) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("空")),
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：编号不连续。
    #[test]
    fn rejects_non_contiguous_step_numbers() {
        let raw = r#"{"intent":"x","steps":[{"step":1,"tool":"a"},{"step":3,"tool":"b"}]}"#;
        match parse_plan(raw) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("不连续")),
            other => panic!("得到 {other:?}"),
        }
    }

    /// 拒绝用例：前向依赖（潜在循环）。
    #[test]
    fn rejects_forward_dependency() {
        let raw = r#"{"intent":"x","steps":[
            {"step":1,"tool":"a","depends_on":[2]},
            {"step":2,"tool":"b"}
        ]}"#;
        match parse_plan(raw) {
            PlanOutcome::Unparsable { reason, .. } => assert!(reason.contains("非更早")),
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_self_dependency() {
        let raw = r#"{"intent":"x","steps":[{"step":1,"tool":"a","depends_on":[1]}]}"#;
        assert!(matches!(parse_plan(raw), PlanOutcome::Unparsable { .. }));
    }

    #[test]
    fn extract_json_strips_fence() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[test]
    fn extract_json_takes_outermost_braces() {
        assert_eq!(extract_json("前缀 {\"a\":1} 后缀"), "{\"a\":1}");
    }

    #[test]
    fn missing_key_reports_failure() {
        let p = LlmPlanner {
            caller: HttpProviderCall::with_key(""),
            model: sky_llm::DEFAULT_MODEL.into(),
            base_url: sky_llm::GLM_BASE_URL.into(),
            config_warning: None,
        };
        // 空密钥在 call 时会被判为无效
        assert!(p.has_key());
    }

    #[tokio::test]
    async fn planner_without_key_fails_gracefully() {
        let p = LlmPlanner::from_env();
        if p.has_key() {
            eprintln!("跳过：环境中有密钥");
            return;
        }
        match p.plan("测试").await {
            PlanOutcome::Failed(msg) => assert!(msg.contains("SKY_GLM_API_KEY")),
            other => panic!("无密钥应 Failed，得到 {other:?}"),
        }
    }

    // ========== 路径抽取与兜底 ==========

    #[test]
    fn extract_paths_finds_absolute_paths() {
        let p = extract_paths("列出 /tmp/pics 下的文件");
        assert_eq!(p, vec!["/tmp/pics"]);
    }

    #[test]
    fn extract_paths_ignores_urls() {
        let p = extract_paths("访问 https://example.com/a 看看");
        assert!(p.is_empty(), "URL 不该被当成文件路径：{p:?}");
    }

    #[test]
    fn extract_paths_handles_chinese_punctuation() {
        let p = extract_paths("列出 /tmp/pics，然后统计。");
        assert_eq!(p, vec!["/tmp/pics"]);
    }

    /// 兜底只补只读工具，绝不补写操作。
    ///
    /// 实测教训：给 file_move 补 from 后，用户说「移动 a.jpg」，
    /// 结果整个 source 目录被搬走（三个文件一起），不可逆。
    #[test]
    fn backfill_only_touches_readonly_tools() {
        let mut plan = TaskPlan {
            intent: "t".into(),
            needs: vec![],
            steps: vec![
                PlanStep {
                    step: 1,
                    description: "列目录".into(),
                    tool: "file_list".into(),
                    depends_on: vec![],
                    params: BTreeMap::new(),
                    expected_output: String::new(),
                    fallback: None,
                },
                PlanStep {
                    step: 2,
                    description: "移动".into(),
                    tool: "file_move".into(),
                    depends_on: vec![],
                    params: BTreeMap::new(),
                    expected_output: String::new(),
                    fallback: None,
                },
            ],
        };
        backfill_paths(&mut plan, "把 /tmp/src 里的 a.jpg 移动到 /tmp/dst");

        assert!(
            plan.steps[0].params.contains_key("dir"),
            "只读工具应补 dir"
        );
        assert!(
            plan.steps[1].params.is_empty(),
            "写操作绝不能兜底——猜错会破坏数据：{:?}",
            plan.steps[1].params
        );
    }

    /// 不覆盖模型已给出的参数。
    #[test]
    fn backfill_does_not_override_existing_params() {
        let mut plan = TaskPlan {
            intent: "t".into(),
            needs: vec![],
            steps: vec![PlanStep {
                step: 1,
                description: "列目录".into(),
                tool: "file_list".into(),
                depends_on: vec![],
                params: BTreeMap::from([(
                    "dir".to_string(),
                    Value::String("/model/gave".into()),
                )]),
                expected_output: String::new(),
                fallback: None,
            }],
        };
        backfill_paths(&mut plan, "列出 /tmp/from/user");
        assert_eq!(
            plan.steps[0].params.get("dir").unwrap().as_str().unwrap(),
            "/model/gave",
            "模型给了参数就该尊重"
        );
    }

    // ========== Windows 路径修正 ==========

    /// 实测 bug：LLM 输出 JSON 时把 `C:\Users\...` 的盘符吃掉，
    /// 变成 `\Users\...`，于是列到当前盘符下的错误位置。
    #[test]
    fn normalize_restores_dropped_drive_letter() {
        assert_eq!(
            normalize_win_path(r"\Users\me\AppData\Local\Temp\x"),
            r"C:\Users\me\AppData\Local\Temp\x"
        );
    }

    #[test]
    fn normalize_keeps_complete_windows_path() {
        assert_eq!(
            normalize_win_path(r"C:\Users\me\a.txt"),
            r"C:\Users\me\a.txt"
        );
    }

    /// Unix 路径必须原样保留——不能被 Windows 逻辑篡改成 `\tmp\x`。
    #[test]
    fn normalize_leaves_unix_paths_alone() {
        assert_eq!(normalize_win_path("/tmp/pics"), "/tmp/pics");
        assert_eq!(normalize_win_path("/model/gave"), "/model/gave");
    }

    #[test]
    fn normalize_keeps_unc_path() {
        assert_eq!(
            normalize_win_path(r"\\server\share\x"),
            r"\\server\share\x"
        );
    }

    /// 不猜不常见的首层目录——宁可漏修也不能猜错。
    #[test]
    fn normalize_does_not_guess_unknown_roots() {
        assert_eq!(normalize_win_path(r"\WeirdRoot\x"), r"\WeirdRoot\x");
    }
}
