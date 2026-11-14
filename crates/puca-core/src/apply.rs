//! Lazy mutant apply: splice a site's replacement into original UTF-8 bytes.

use crate::site::Site;

/// Return a new string with `site.replacement` spliced over
/// `[start_offset, end_offset)` in `source`.
///
/// Does not mutate `source`, does not re-print an AST — byte offsets only.
pub fn apply(source: &str, site: &Site) -> String {
    let start = site.start_offset as usize;
    let end = site.end_offset as usize;
    debug_assert!(start <= end);
    debug_assert!(end <= source.len());

    let mut out = String::with_capacity(source.len() - (end - start) + site.replacement.len());
    out.push_str(&source[..start]);
    out.push_str(&site.replacement);
    out.push_str(&source[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::site::Site;

    #[test]
    fn splice_replaces_span_without_mutating_original() {
        let source = String::from("return a + b;");
        let site = Site::at("t.ts", &source, 9, 10, "ArithmeticOperator", "-");
        let mutated = apply(&source, &site);
        assert_eq!(mutated, "return a - b;");
        assert_eq!(source, "return a + b;");
    }
}
