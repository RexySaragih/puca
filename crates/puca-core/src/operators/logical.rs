//! LogicalOperator: `&&` ↔ `||` (not `??`).

use super::{infix_operator_span, push_operator_sites};
use crate::site::Site;
use oxc_ast::ast::LogicalExpression;
use oxc_span::GetSpan;
use oxc_syntax::operator::LogicalOperator;

const MUTATOR: &str = "LogicalOperator";

pub(crate) fn collect(
    path: &str,
    source: &str,
    expr: &LogicalExpression<'_>,
    sites: &mut Vec<Site>,
) {
    let replacement = match expr.operator {
        LogicalOperator::And => "||",
        LogicalOperator::Or => "&&",
        LogicalOperator::Coalesce => return,
    };

    let op = expr.operator.as_str();
    let Some((start, end)) =
        infix_operator_span(source, expr.left.span().end, expr.right.span().start, op)
    else {
        return;
    };
    push_operator_sites(path, source, start, end, MUTATOR, &[replacement], sites);
}
