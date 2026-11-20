//! Line-oriented `// puca-disable*` comment filtering for discovery.

use crate::site::Site;
use std::collections::{HashMap, HashSet};

const DISABLE_NEXT_LINE: &str = "puca-disable-next-line";
const DISABLE_REST: &str = "puca-disable";

/// Exact current mutator name strings (A47 / A49).
const KNOWN_MUTATORS: &[&str] = &[
    "ArithmeticOperator",
    "EqualityOperator",
    "BooleanLiteral",
    "LogicalOperator",
    "ConditionalExpression",
];

/// Operator set for a next-line directive: all mutators, or a named subset.
#[derive(Debug, Clone)]
enum NextLineRule {
    All,
    Named(HashSet<String>),
}

/// Directives parsed from physical `//` line comments in `source`.
#[derive(Debug, Default, Clone)]
pub struct DisableMap {
    /// 1-based lines → next-line omit rule.
    next_line: HashMap<u32, NextLineRule>,
    /// Earliest 1-based line from which all later sites are omitted (`puca-disable`).
    disable_from: Option<u32>,
}

impl DisableMap {
    /// Whether a site on `start_line` with `mutator_name` is suppressed.
    pub fn is_disabled(&self, start_line: u32, mutator_name: &str) -> bool {
        if let Some(rule) = self.next_line.get(&start_line) {
            match rule {
                NextLineRule::All => return true,
                NextLineRule::Named(names) if names.contains(mutator_name) => return true,
                NextLineRule::Named(_) => {}
            }
        }
        match self.disable_from {
            Some(from) => start_line >= from,
            None => false,
        }
    }
}

/// Result of scanning disable comments: map + non-fatal warnings.
#[derive(Debug, Default, Clone)]
pub struct DisableScan {
    pub map: DisableMap,
    pub warnings: Vec<String>,
}

/// Scan `source` for line-oriented UTF-8 `//` disable directives.
///
/// Supports:
/// - `// puca-disable-next-line` — all mutators on the following line
/// - `// puca-disable-next-line OpA, OpB` — named mutators only
/// - `// puca-disable` — rest-of-file all mutators
///
/// Block comments and foreign tools (e.g. `// Stryker disable`) are ignored.
/// Unknown mutator tokens produce warnings; known tokens still apply.
pub fn scan_disables(source: &str) -> DisableScan {
    let mut map = DisableMap::default();
    let mut warnings = Vec::new();
    let mut line_no = 1_u32;

    for line in source.split('\n') {
        if let Some(body) = line_comment_body(line) {
            if let Some(rest) = body.strip_prefix(DISABLE_NEXT_LINE) {
                let target = line_no.saturating_add(1);
                let (rule, line_warnings) = parse_next_line_ops(rest);
                warnings.extend(line_warnings);
                merge_next_line(&mut map, target, rule);
            } else if body.starts_with(DISABLE_REST) {
                // Avoid matching `puca-disable-next-line` via the shorter prefix:
                // already handled above. `puca-disable` alone (or with trailing junk).
                if !body.starts_with(DISABLE_NEXT_LINE) {
                    let from = line_no.saturating_add(1);
                    map.disable_from = Some(match map.disable_from {
                        Some(existing) => existing.min(from),
                        None => from,
                    });
                }
            }
        }
        line_no = line_no.saturating_add(1);
    }

    DisableScan { map, warnings }
}

fn parse_next_line_ops(rest: &str) -> (NextLineRule, Vec<String>) {
    let trimmed = rest.trim_start();
    if trimmed.is_empty() {
        return (NextLineRule::All, Vec::new());
    }

    let mut known = HashSet::new();
    let mut warnings = Vec::new();
    for token in trimmed.split(',') {
        let name = token.trim();
        if name.is_empty() {
            continue;
        }
        if KNOWN_MUTATORS.contains(&name) {
            known.insert(name.to_string());
        } else {
            warnings.push(format!(
                "Unknown mutator in puca-disable-next-line: `{name}`"
            ));
        }
    }

    if known.is_empty() && warnings.is_empty() {
        (NextLineRule::All, warnings)
    } else if known.is_empty() {
        // Only unknown tokens — nothing to suppress by name; treat as no named omits.
        (NextLineRule::Named(known), warnings)
    } else {
        (NextLineRule::Named(known), warnings)
    }
}

fn merge_next_line(map: &mut DisableMap, target: u32, rule: NextLineRule) {
    match map.next_line.remove(&target) {
        None => {
            map.next_line.insert(target, rule);
        }
        Some(NextLineRule::All) => {
            map.next_line.insert(target, NextLineRule::All);
        }
        Some(NextLineRule::Named(mut existing)) => match rule {
            NextLineRule::All => {
                map.next_line.insert(target, NextLineRule::All);
            }
            NextLineRule::Named(extra) => {
                existing.extend(extra);
                map.next_line.insert(target, NextLineRule::Named(existing));
            }
        },
    }
}

/// Drop sites whose start line / mutator is covered by a disable directive.
pub fn filter_disabled(source: &str, sites: Vec<Site>) -> Vec<Site> {
    let scan = scan_disables(source);
    sites
        .into_iter()
        .filter(|site| !scan.map.is_disabled(site.start_line, &site.mutator_name))
        .collect()
}

/// Body after the first `//` on the line, trimmed; `None` if no line comment.
fn line_comment_body(line: &str) -> Option<&str> {
    let idx = line.find("//")?;
    Some(line[idx + 2..].trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_line_directive_targets_following_line() {
        let source = "// puca-disable-next-line\nreturn a + b;\n";
        let scan = scan_disables(source);
        assert!(scan.map.is_disabled(2, "ArithmeticOperator"));
        assert!(!scan.map.is_disabled(1, "ArithmeticOperator"));
        assert!(!scan.map.is_disabled(3, "ArithmeticOperator"));
    }

    #[test]
    fn named_next_line_only_lists_operators() {
        let source = "// puca-disable-next-line EqualityOperator\na + b === c;\n";
        let scan = scan_disables(source);
        assert!(scan.map.is_disabled(2, "EqualityOperator"));
        assert!(!scan.map.is_disabled(2, "ArithmeticOperator"));
    }

    #[test]
    fn unknown_token_warns_and_known_still_applies() {
        let source = "// puca-disable-next-line NoSuchOp, ArithmeticOperator\na + b;\n";
        let scan = scan_disables(source);
        assert!(scan.map.is_disabled(2, "ArithmeticOperator"));
        assert_eq!(scan.warnings.len(), 1);
        assert!(scan.warnings[0].contains("NoSuchOp"));
    }

    #[test]
    fn rest_directive_suppresses_later_lines_only() {
        let source = "a + b;\n// puca-disable\nc - d;\n";
        let scan = scan_disables(source);
        assert!(!scan.map.is_disabled(1, "ArithmeticOperator"));
        assert!(!scan.map.is_disabled(2, "ArithmeticOperator"));
        assert!(scan.map.is_disabled(3, "ArithmeticOperator"));
    }

    #[test]
    fn stryker_directive_is_ignored() {
        let source = "// Stryker disable\nreturn a + b;\n";
        let scan = scan_disables(source);
        assert!(!scan.map.is_disabled(2, "ArithmeticOperator"));
    }

    #[test]
    fn block_comment_disable_is_ignored() {
        let source = "/* puca-disable */\nreturn a + b;\n";
        let scan = scan_disables(source);
        assert!(!scan.map.is_disabled(2, "ArithmeticOperator"));
        assert!(scan.warnings.is_empty());
    }
}
