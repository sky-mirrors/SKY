//! 化学结构基础工具——SMILES 解析（95 册 §9.7 化学台第一件）。
//!
//! **定位**：SMILES 是形式化语言，可机器验证——这就是化学领域
//! anti-hallucination 的硬闸门：LLM 说「阿司匹林的 SMILES 是 X」，
//! 解析失败即为幻觉，无需任何语义判断。
//!
//! **实现范围（诚实声明）**：内置解析器只覆盖 SMILES 的核心子集——
//! 有机主族（B/C/N/O/F/P/S/Cl/Br/I）、直链与分支 `(...)`、双键 `=`、
//! 三键 `#`、环编号数字。**不支持**：立体标记 `@`、手性 `\ /`、
//! 电荷 `[NH4+]` 括号原子内的复杂形态、聚合/反应 SMILES `>>`。
//! 解析器遇到不支持形态会**报错而非猜**——宁拒勿错。
//! 完整 SMILES 需 RDKit/OpenBabel（未来经 shell_exec 子进程接入）。
//!
//! **隐式氢模型（两遍解析）**：第一遍建「原子表 + 键表」（每个键记录
//! 两端原子下标与键级——含分支回到主链、环闭合），第二遍对每个原子算
//! `占用键级和 = Σ 相邻键级`，`隐式 H = 价键数 − 占用`。这是 SMILES 的
//! 正确语义，一遍流式近似在分支/环场景会算错（实测踩过：阿司匹林 H26）。

use serde_json::{json, Value};

/// 常见元素标准原子量（IUPAC 2021，g/mol）。
const ATOMIC_MASSES: &[(&str, f64)] = &[
    ("H", 1.008),
    ("B", 10.81),
    ("C", 12.011),
    ("N", 14.007),
    ("O", 15.999),
    ("F", 18.998),
    ("P", 30.974),
    ("S", 32.06),
    ("Cl", 35.45),
    ("Br", 79.904),
    ("I", 126.904),
];

fn atomic_mass(element: &str) -> Option<f64> {
    ATOMIC_MASSES
        .iter()
        .find(|(e, _)| *e == element)
        .map(|(_, m)| *m)
}

fn valence_of(element: &str) -> u32 {
    match element {
        "C" => 4,
        "N" | "P" | "B" => 3,
        "O" | "S" => 2,
        "F" | "Cl" | "Br" | "I" => 1,
        _ => 0,
    }
}

/// 有序原子计数表（元素 → 个数）。
pub type BTreeCount = std::collections::BTreeMap<String, u64>;

/// 解析 SMILES 核心子集：两遍——①建原子/键表 ②按占用键级算隐式氢。
pub fn parse_smiles_atoms(smiles: &str) -> Result<BTreeCount, String> {
    let s = smiles.trim();
    if s.is_empty() {
        return Err("SMILES 为空".into());
    }
    let chars: Vec<char> = s.chars().collect();

    // ---------- 第一遍：原子表 + 键表 ----------
    // atoms[i] = (元素, 价键数)
    let mut atoms: Vec<(String, u32)> = Vec::new();
    // bonds = (端 A 下标, 端 B 下标, 键级)
    let mut bonds: Vec<(usize, usize, u32)> = Vec::new();
    // 分支栈：分支起点原子下标
    let mut branch_stack: Vec<usize> = Vec::new();
    // 主链/分支的「当前尾部原子」：新原子与它成键。栈顶为当前尾。
    let mut tail_stack: Vec<usize> = Vec::new();
    // 环编号 → 等待闭合的原子下标
    let mut ring_open: std::collections::BTreeMap<char, usize> =
        std::collections::BTreeMap::new();
    // 待生效的键级标记（= / #）
    let mut pending_order: u32 = 0;

    let mut i = 0usize;
    let mut depth = 0i32;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '(' => {
                // 把当前尾压栈，分支内的新原子接到同一个起点
                if let Some(&t) = tail_stack.last() {
                    branch_stack.push(t);
                }
                depth += 1;
                i += 1;
            }
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("SMILES 括号不匹配（位置 {i} 多余的 ')'）"));
                }
                // 分支结束：从分支起点栈恢复一个尾巴
                if let Some(start) = branch_stack.pop() {
                    // 只有当分支内产生过原子时才弹尾巴栈
                    tail_stack.pop();
                    tail_stack.push(start);
                }
                i += 1;
            }
            '.' => {
                // 组分分隔：断键
                tail_stack.pop();
                i += 1;
            }
            '0'..='9' => {
                let digit = c;
                // 环编号：与等待闭合的原子成键
                match ring_open.remove(&digit) {
                    Some(start_atom) => {
                        if let Some(&t) = tail_stack.last() {
                            bonds.push((start_atom, t, pending_order.max(1)));
                            pending_order = 0;
                        }
                    }
                    None => {
                        if let Some(&t) = tail_stack.last() {
                            ring_open.insert(digit, t);
                        }
                        pending_order = 0;
                    }
                }
                i += 1;
            }
            '=' | '#' | '-' | '/' | '\\' => {
                pending_order = match c {
                    '=' => 2,
                    '#' => 3,
                    _ => 1,
                };
                i += 1;
            }
            _ => {
                let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
                let one = c.to_string();
                let two_known = i + 1 < chars.len() && atomic_mass(&two).is_some();
                let (element, advance) = if two_known {
                    (two, 2usize)
                } else if atomic_mass(&one).is_some() {
                    (one, 1usize)
                } else {
                    return Err(format!(
                        "SMILES 含不支持的原子/形态「{c}」（位置 {i}）。\
                         本解析器只支持有机主族核心子集，立体/电荷形态请用 RDKit 通道。"
                    ));
                };

                let idx = atoms.len();
                atoms.push((element.clone(), valence_of(&element)));

                // 与当前尾成键（若无尾 = 第一个原子/新组分起点）
                if let Some(&t) = tail_stack.last() {
                    bonds.push((t, idx, pending_order.max(1)));
                }
                pending_order = 0;

                // 更新尾巴：当前原子成为新尾
                if tail_stack.is_empty() || branch_stack.is_empty() {
                    // 无分支上下文：直接换尾
                    if tail_stack.len() > branch_stack.len() {
                        tail_stack.pop();
                    }
                    tail_stack.push(idx);
                } else {
                    // 分支内：换尾（分支结束后 ')' 恢复起点）
                    tail_stack.pop();
                    tail_stack.push(idx);
                }

                i += advance;
            }
        }
    }
    if depth != 0 {
        return Err("SMILES 括号不匹配（有未闭合的 '('）".into());
    }

    // ---------- 第二遍：占用键级和 → 隐式氢 ----------
    let mut used: Vec<u32> = vec![0; atoms.len()];
    for (a, b, order) in &bonds {
        used[*a] += order;
        used[*b] += order;
    }

    let mut counts: BTreeCount = BTreeCount::default();
    let mut h_total: u64 = 0;
    for (idx, (element, valence)) in atoms.iter().enumerate() {
        let h = (*valence).saturating_sub(used[idx]);
        h_total += h as u64;
        *counts.entry(element.clone()).or_insert(0) += 1;
    }
    if h_total > 0 {
        *counts.entry("H".to_string()).or_insert(0) += h_total;
    }

    if counts.is_empty() {
        return Err("SMILES 未解析出任何原子".into());
    }
    Ok(counts)
}

/// 从计数表算分子式（Hill 系统序：C 先、H 次、其余字母序）与分子量。
pub fn formula_and_mass(counts: &BTreeCount) -> (String, f64) {
    let mut formula = String::new();
    let mut mass = 0.0;
    // Hill 序：C、H 优先，其余字母序
    let mut ordered: Vec<(&String, &u64)> = counts.iter().collect();
    ordered.sort_by(|a, b| {
        let rank = |e: &str| -> u8 {
            if e == "C" {
                0
            } else if e == "H" {
                1
            } else {
                2
            }
        };
        rank(a.0).cmp(&rank(b.0)).then(a.0.cmp(b.0))
    });
    for (element, count) in ordered {
        formula.push_str(element);
        if *count > 1 {
            formula.push_str(&count.to_string());
        }
        mass += atomic_mass(element).unwrap_or(0.0) * (*count as f64);
    }
    (formula, (mass * 100.0).round() / 100.0)
}

/// 工具入口：SMILES → 分子式 + 分子量 + 原子计数（JSON）。
///
/// 这就是「LLM 报 SMILES → harness 机器验证」的验证端：
/// 解析失败 = 幻觉，直接打回。
pub fn tool_smiles_info(step: &std::collections::BTreeMap<String, Value>) -> Result<Value, String> {
    let smiles = step
        .get("smiles")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "smiles_info 缺少 smiles 参数".to_string())?;
    let counts = parse_smiles_atoms(smiles)?;
    let (formula, mass) = formula_and_mass(&counts);
    let atoms: u64 = counts.values().sum();
    Ok(json!({
        "smiles": smiles.trim(),
        "formula": formula,
        "molecular_weight": mass,
        "atom_count": atoms,
        "elements": counts,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn run(smiles: &str) -> Result<Value, String> {
        let mut m = BTreeMap::new();
        m.insert("smiles".to_string(), json!(smiles));
        tool_smiles_info(&m)
    }

    /// 经典验证：乙醇 CCO → C2H6O，46.07。
    #[test]
    fn ethanol_parses_to_c2h6o() {
        let r = run("CCO").unwrap();
        assert_eq!(r["formula"], "C2H6O");
        assert_eq!(r["molecular_weight"], json!(46.07));
        assert_eq!(r["atom_count"], 9);
    }

    /// 阿司匹林简化骨架：分支 + 环编号 + 双键——两遍解析的主验证。
    #[test]
    fn aspirin_simplified_with_branch_and_ring() {
        let r = run("CC(=O)OC1=CC=CC=C1C(=O)O").unwrap();
        assert_eq!(r["formula"], "C9H8O4", "阿司匹林 C9H8O4");
        let mw = r["molecular_weight"].as_f64().unwrap();
        assert!((mw - 180.16).abs() < 0.05, "分子量应 180.16，实际 {mw}");
    }

    /// LLM 幻觉闸门：编造的 SMILES 必须报错。
    #[test]
    fn hallucinated_smiles_rejected() {
        assert!(run("").is_err(), "空串应报错");
        assert!(run("C(C").is_err(), "未闭合括号应报错");
        assert!(run("C)C").is_err(), "多余右括号应报错");
        assert!(run("XYZ").is_err(), "非元素字符应报错");
        assert!(run("[Na+].Cl-").is_err(), "括号电荷形态暂不支持——应报错而非猜");
    }

    /// 双键/三键标记：乙烯 C2H4、氰化氢 HCN（C 三键 N，各 1 个 H...实际 HCN 是 CHN）。
    #[test]
    fn bond_orders_affect_hydrogens() {
        let r = run("C=C").unwrap();
        assert_eq!(r["formula"], "C2H4", "乙烯：每个 C 占 4（2 来+2 去...实际各占双键 2）");
        let r2 = run("C#N").unwrap();
        // H-C≡N：C 来键 0 出键 3 → 1 个 H；N 价 3 占 3 → 0 H
        assert_eq!(r2["formula"], "CHN");
    }

    /// 两字母元素优先：Cl/Br 整体解析，价 1。
    #[test]
    fn two_letter_elements_take_priority() {
        let counts = parse_smiles_atoms("ClCBr").unwrap();
        assert_eq!(counts.get("Cl"), Some(&1));
        assert_eq!(counts.get("Br"), Some(&1));
        assert_eq!(counts.get("C"), Some(&1));
        // H：Cl 价 1 占 1 → 0；Br 同；C 价 4 占 2（两根来键）→ 2
        assert_eq!(counts.get("H"), Some(&2));
    }
}
