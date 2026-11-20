//! UnaryOperator: boolean inversion of `!` only (Stryker-style).

use super::push_operator_sites;
use crate::site::Site;
use oxc_ast::ast::UnaryExpression;
use oxc_span::GetSpan;
use oxc_syntax::operator::UnaryOperator;

const MUTATOR: &str = "UnaryOperator";

pub(crate) fn collect(path: &str, source: &str, expr: &UnaryExpression<'_>, sites: &mut Vec<Site>) {
    if expr.operator != UnaryOperator::LogicalNot {
        return;
    }
    let Some((start, end)) = bang_span(source, expr.span()) else {
        return;
    };
    push_operator_sites(path, source, start, end, MUTATOR, &[""], sites);
}

fn bang_span(source: &str, span: oxc_span::Span) -> Option<(u32, u32)> {
    let start = span.start as usize;
    let end = (span.end as usize).min(source.len());
    if start >= end {
        return None;
    }
    let rel = source[start..end].find('!')?;
    let bang_start = span.start + rel as u32;
    Some((bang_start, bang_start + 1))
}
