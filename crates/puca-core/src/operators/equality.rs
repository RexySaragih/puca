//! EqualityOperator: `== != === !==` and relational `< <= > >=`.

use super::{infix_operator_span, push_operator_sites};
use crate::site::Site;
use oxc_ast::ast::BinaryExpression;
use oxc_span::GetSpan;
use oxc_syntax::operator::BinaryOperator;

const MUTATOR: &str = "EqualityOperator";

pub(crate) fn collect(
    path: &str,
    source: &str,
    expr: &BinaryExpression<'_>,
    sites: &mut Vec<Site>,
) {
    let replacements = match expr.operator {
        BinaryOperator::Equality => &["!="][..],
        BinaryOperator::Inequality => &["=="][..],
        BinaryOperator::StrictEquality => &["!=="][..],
        BinaryOperator::StrictInequality => &["==="][..],
        BinaryOperator::LessThan => &["<=", ">="][..],
        BinaryOperator::LessEqualThan => &["<", ">"][..],
        BinaryOperator::GreaterThan => &[">=", "<="][..],
        BinaryOperator::GreaterEqualThan => &[">", "<"][..],
        _ => return,
    };

    let op = expr.operator.as_str();
    let Some((start, end)) =
        infix_operator_span(source, expr.left.span().end, expr.right.span().start, op)
    else {
        return;
    };
    push_operator_sites(path, source, start, end, MUTATOR, replacements, sites);
}
