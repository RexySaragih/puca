//! ArithmeticOperator: binary `+ - * / %` (not unary).

use super::{infix_operator_span, push_operator_sites};
use crate::site::Site;
use oxc_ast::ast::{BinaryExpression, Expression};
use oxc_span::GetSpan;
use oxc_syntax::operator::BinaryOperator;

const MUTATOR: &str = "ArithmeticOperator";

pub(crate) fn collect(
    path: &str,
    source: &str,
    expr: &BinaryExpression<'_>,
    sites: &mut Vec<Site>,
) {
    if expr.operator == BinaryOperator::Addition && is_nonempty_string_addition(expr) {
        return;
    }

    let replacements = match expr.operator {
        BinaryOperator::Addition => &["-"][..],
        BinaryOperator::Subtraction => &["+"][..],
        BinaryOperator::Multiplication => &["/"][..],
        BinaryOperator::Division => &["*"][..],
        BinaryOperator::Remainder => &["*"][..],
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

fn is_nonempty_string_addition(expr: &BinaryExpression<'_>) -> bool {
    is_nonempty_stringish(&expr.left) || is_nonempty_stringish(&expr.right)
}

fn is_nonempty_stringish(expr: &Expression<'_>) -> bool {
    match expr.get_inner_expression() {
        Expression::StringLiteral(lit) => !lit.value.is_empty(),
        Expression::TemplateLiteral(_) => true,
        _ => false,
    }
}
