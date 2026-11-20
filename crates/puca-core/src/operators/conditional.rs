//! ConditionalExpression: replace simple predicates with `true` / `false`.
//!
//! Applies to `if` / `while` / `do…while` tests and ternary `cond`, not `for`
//! headers. Whole-predicate mutants fire only for Identifier or `!id`.

use crate::site::Site;
use oxc_ast::ast::Expression;
use oxc_span::GetSpan;
use oxc_syntax::operator::UnaryOperator;

const MUTATOR: &str = "ConditionalExpression";

pub(crate) fn collect_predicate(
    path: &str,
    source: &str,
    test: &Expression<'_>,
    sites: &mut Vec<Site>,
) {
    if !is_simple_predicate(test) {
        return;
    }
    let span = test.span();
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

fn is_simple_predicate(test: &Expression<'_>) -> bool {
    match test.get_inner_expression() {
        Expression::Identifier(_) => true,
        Expression::UnaryExpression(unary) => {
            unary.operator == UnaryOperator::LogicalNot
                && matches!(
                    unary.argument.get_inner_expression(),
                    Expression::Identifier(_)
                )
        }
        _ => false,
    }
}
