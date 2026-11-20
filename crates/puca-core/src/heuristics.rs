//! Stage-1 discovery heuristics: diagnostic call args and trivial constant expressions.

use crate::operators::infix_operator_span;
use crate::site::Site;
use oxc_ast::ast::{
    Argument, BinaryExpression, CallExpression, Expression, Program, StaticMemberExpression,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::BinaryOperator;

const ARITHMETIC: &str = "ArithmeticOperator";

const DIAGNOSTIC_OBJECTS: &[&str] = &["console", "logger"];
const DIAGNOSTIC_METHODS: &[&str] = &["log", "info", "warn", "error", "debug", "trace"];

/// Spans collected for Stage-1 omit matching.
#[derive(Debug, Default)]
struct HeuristicSpans {
    /// Argument ranges of matched `console.*` / `logger.*` calls.
    diagnostic_args: Vec<Span>,
    /// Arithmetic operator token spans that match closed TCE shapes.
    tce_ops: Vec<(u32, u32)>,
}

/// Remove heuristic noise sites; return kept sites and how many were skipped.
pub fn filter_heuristics(
    source: &str,
    program: &Program<'_>,
    sites: Vec<Site>,
) -> (Vec<Site>, usize) {
    let spans = collect_heuristic_spans(source, program);
    let before = sites.len();
    let kept: Vec<Site> = sites
        .into_iter()
        .filter(|site| !is_heuristic_skip(site, &spans))
        .collect();
    let skipped = before - kept.len();
    (kept, skipped)
}

fn collect_heuristic_spans(source: &str, program: &Program<'_>) -> HeuristicSpans {
    let mut visitor = HeuristicVisitor {
        source,
        spans: HeuristicSpans::default(),
    };
    visitor.visit_program(program);
    visitor.spans
}

fn is_heuristic_skip(site: &Site, spans: &HeuristicSpans) -> bool {
    if spans.diagnostic_args.iter().any(|arg| {
        site.start_offset >= arg.start && site.end_offset <= arg.end
    }) {
        return true;
    }
    if site.mutator_name == ARITHMETIC
        && spans
            .tce_ops
            .iter()
            .any(|&(start, end)| site.start_offset == start && site.end_offset == end)
    {
        return true;
    }
    false
}

struct HeuristicVisitor<'s> {
    source: &'s str,
    spans: HeuristicSpans,
}

impl<'a> Visit<'a> for HeuristicVisitor<'_> {
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if is_diagnostic_callee(&it.callee) {
            for arg in &it.arguments {
                self.spans.diagnostic_args.push(argument_span(arg));
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        if let Some(op_span) = tce_operator_span(self.source, it) {
            self.spans.tce_ops.push(op_span);
        }
        walk::walk_binary_expression(self, it);
    }
}

fn argument_span(arg: &Argument<'_>) -> Span {
    match arg {
        Argument::SpreadElement(spread) => spread.span(),
        other => other.span(),
    }
}

fn is_diagnostic_callee(callee: &Expression<'_>) -> bool {
    let Expression::StaticMemberExpression(member) = callee else {
        return false;
    };
    is_diagnostic_member(member)
}

fn is_diagnostic_member(member: &StaticMemberExpression<'_>) -> bool {
    let Expression::Identifier(object) = &member.object else {
        return false;
    };
    let object_name = object.name.as_str();
    let method_name = member.property.name.as_str();
    DIAGNOSTIC_OBJECTS.contains(&object_name) && DIAGNOSTIC_METHODS.contains(&method_name)
}

/// Closed TCE set (A51): plain NumericLiteral 0/1 identities only; never `0 - x` or `+ ""`.
fn tce_operator_span(source: &str, expr: &BinaryExpression<'_>) -> Option<(u32, u32)> {
    let op = expr.operator;
    let left_zero = is_numeric_literal(&expr.left, 0.0);
    let right_zero = is_numeric_literal(&expr.right, 0.0);
    let left_one = is_numeric_literal(&expr.left, 1.0);
    let right_one = is_numeric_literal(&expr.right, 1.0);

    let matches = match op {
        BinaryOperator::Addition => right_zero || left_zero,
        BinaryOperator::Subtraction => right_zero && !left_zero,
        BinaryOperator::Multiplication => left_one || right_one,
        BinaryOperator::Division => right_one,
        _ => false,
    };
    if !matches {
        return None;
    }

    let op_str = op.as_str();
    infix_operator_span(
        source,
        expr.left.span().end,
        expr.right.span().start,
        op_str,
    )
}

fn is_numeric_literal(expr: &Expression<'_>, value: f64) -> bool {
    matches!(
        expr,
        Expression::NumericLiteral(lit) if (lit.value - value).abs() < f64::EPSILON
    )
}
