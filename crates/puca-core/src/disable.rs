//! Line-oriented `// puca-disable*` comment filtering for discovery.

use crate::site::Site;
use std::collections::HashSet;

const DISABLE_NEXT_LINE: &str = "puca-disable-next-line";
const DISABLE_REST: &str = "puca-disable";

/// Directives parsed from physical `//` line comments in `source`.
#[derive(Debug, Default, Clone)]
pub struct DisableMap {
    /// 1-based lines whose sites must be omitted (`puca-disable-next-line`).
    next_line: HashSet<u32>,
    /// Earliest 1-based line from which all later sites are omitted (`puca-disable`).
    /// Sites with `start_line >= disable_from` are omitted.
    disable_from: Option<u32>,
}

impl DisableMap {
    /// Whether a site whose span starts on `start_line` (1-based) is suppressed.
    pub fn is_disabled(&self, start_line: u32) -> bool {
        if self.next_line.contains(&start_line) {
            return true;
        }
        match self.disable_from {
            Some(from) => start_line >= from,
            None => false,
        }
    }
}

/// Scan `source` for line-oriented UTF-8 `//` disable directives.
///
/// Only `// puca-disable-next-line` and `// puca-disable` are recognized.
/// Block comments and foreign tools (e.g. `// Stryker disable`) are ignored.
pub fn scan_disables(source: &str) -> DisableMap {
    let mut map = DisableMap::default();
    let mut line_no = 1_u32;

    for line in source.split('\n') {
        if let Some(body) = line_comment_body(line) {
            if body.starts_with(DISABLE_NEXT_LINE) {
                map.next_line.insert(line_no.saturating_add(1));
            } else if body.starts_with(DISABLE_REST) {
                let from = line_no.saturating_add(1);
                map.disable_from = Some(match map.disable_from {
                    Some(existing) => existing.min(from),
                    None => from,
                });
            }
        }
        line_no = line_no.saturating_add(1);
    }

    map
}

/// Drop sites whose start line is covered by a disable directive.
pub fn filter_disabled(source: &str, sites: Vec<Site>) -> Vec<Site> {
    let map = scan_disables(source);
    sites
        .into_iter()
        .filter(|site| !map.is_disabled(site.start_line))
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
        let map = scan_disables(source);
        assert!(map.is_disabled(2));
        assert!(!map.is_disabled(1));
        assert!(!map.is_disabled(3));
    }

    #[test]
    fn rest_directive_suppresses_later_lines_only() {
        let source = "a + b;\n// puca-disable\nc - d;\n";
        let map = scan_disables(source);
        assert!(!map.is_disabled(1));
        assert!(!map.is_disabled(2));
        assert!(map.is_disabled(3));
    }

    #[test]
    fn stryker_directive_is_ignored() {
        let source = "// Stryker disable\nreturn a + b;\n";
        let map = scan_disables(source);
        assert!(!map.is_disabled(2));
    }
}
