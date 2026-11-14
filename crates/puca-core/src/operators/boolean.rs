//! BooleanLiteral: `true` ↔ `false` (keyword literals only).

use crate::site::Site;
use oxc_ast::ast::BooleanLiteral;

const MUTATOR: &str = "BooleanLiteral";

pub(crate) fn collect(path: &str, source: &str, lit: &BooleanLiteral, sites: &mut Vec<Site>) {
    let replacement = if lit.value { "false" } else { "true" };
    sites.push(Site::at(
        path,
        source,
        lit.span.start,
        lit.span.end,
        MUTATOR,
        replacement,
    ));
}
