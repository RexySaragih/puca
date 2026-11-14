//! ConditionalExpression: replace predicates with `true` / `false`.
//!
//! Applies to `if` / `while` / `do…while` tests and ternary `cond`, not `for` headers.

use crate::site::Site;
use oxc_span::Span;

const MUTATOR: &str = "ConditionalExpression";

pub(crate) fn collect_predicate(path: &str, source: &str, span: Span, sites: &mut Vec<Site>) {
    for replacement in ["true", "false"] {
        sites.push(Site::at(
            path,
            source,
            span.start,
            span.end,
            MUTATOR,
            replacement,
        ));
    }
}
