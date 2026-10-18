//! 输入归一化。
//!
//! **为什么需要**：中文输入法在中文标点模式下，打出的字母与空格是全角的。
//! 用户想输入 `pdf` 却得到 `ｐｄｆ`，想输空格却得到 `　`（U+3000）。
//! 规则用 `contains("pdf")` 匹配全角串会失败，输入便落到兜底段触发 LLM——
//! 实测同一句「把文档转 pdf」：半角命中确定性段 151µs，
//! 全角则落到 explore 段耗时 2.58–11.4s（还消耗 token）。
//!
//! **为什么放在这里而不是各段内部**：归一化必须对所有匹配段一致生效。
//! 若每个段各写一份，就又制造了「同一语义两处实现」的分叉——
//! 本项目的 `Pipeline::run` / `route_only` 曾因此漏接 planner。
//! 归一化只在路由入口做一次，下游一律拿归一化后的文本。
//!
//! **不做的事**：不做同义词替换（「转」≠「转换」）、不做分词、不做简繁转换。
//! 那些属于规则表的职责，改了会让匹配行为难以预测。

/// 归一化输入文本，供各匹配段使用。
///
/// 处理内容：
/// 1. 全角 ASCII（U+FF01–U+FF5E）→ 半角（U+0021–U+007E）
/// 2. 全角空格（U+3000）→ 半角空格
/// 3. 英文大写 → 小写
///
/// 中文汉字不受影响。
pub fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            // 全角 ASCII 区间整体偏移 0xFEE0
            '\u{FF01}'..='\u{FF5E}' => {
                char::from_u32(c as u32 - 0xFEE0).unwrap_or(c)
            }
            // 全角空格单独处理（不在上面的区间内）
            '\u{3000}' => ' ',
            other => other,
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fullwidth_ascii_becomes_halfwidth() {
        assert_eq!(normalize("ｐｄｆ"), "pdf");
        assert_eq!(normalize("ＰＤＦ"), "pdf");
        assert_eq!(normalize("１２３"), "123");
    }

    #[test]
    fn ideographic_space_becomes_ascii_space() {
        assert_eq!(normalize("转\u{3000}pdf"), "转 pdf");
    }

    #[test]
    fn uppercase_is_lowercased() {
        assert_eq!(normalize("PDF"), "pdf");
        assert_eq!(normalize("Pdf File"), "pdf file");
    }

    #[test]
    fn chinese_characters_untouched() {
        assert_eq!(normalize("把文档转 pdf"), "把文档转 pdf");
        assert_eq!(normalize("图片压缩"), "图片压缩");
    }

    /// 关键回归：中文输入法场景下的实际输入应归一到半角。
    #[test]
    fn chinese_ime_input_normalizes_to_matchable() {
        // 用户在中文标点模式下打出的「转 ｐｄｆ」
        let ime_input = "把文档转\u{3000}ｐｄｆ";
        let normalized = normalize(ime_input);
        assert_eq!(normalized, "把文档转 pdf");
        assert!(normalized.contains("转"), "汉字应保留");
        assert!(normalized.contains("pdf"), "全角字母应变成半角，供规则匹配");
    }

    #[test]
    fn mixed_width_and_case() {
        assert_eq!(normalize("转　ＰＤＦ"), "转 pdf");
    }

    #[test]
    fn empty_input_is_fine() {
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn already_normalized_is_idempotent() {
        let s = "把文档转 pdf";
        assert_eq!(normalize(&normalize(s)), normalize(s));
    }
}
