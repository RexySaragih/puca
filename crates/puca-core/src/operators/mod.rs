//! Core mutation operators (§4.4): walk an oxc AST and emit [`Site`]s.

mod arithmetic;
mod boolean;
mod conditional;
mod equality;
mod logical;

use crate::site::Site;
use oxc_ast::ast::{
    BinaryExpression, BooleanLiteral, ConditionalExpression, DoWhileStatement, IfStatement,
    LogicalExpression, Program, TemplateLiteral, WhileStatement,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;

/// Collect mutation sites for `program` under `path` / `source`.
pub fn collect_sites(path: &str, source: &str, program: &Program<'_>) -> Vec<Site> {
    let mut visitor = OperatorVisitor {
        path,
        source,
        sites: Vec::new(),
    };
    visitor.visit_program(program);
    visitor.sites
}

struct OperatorVisitor<'s> {
    path: &'s str,
    source: &'s str,
    sites: Vec<Site>,
}

impl<'a> Visit<'a> for OperatorVisitor<'_> {
    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        arithmetic::collect(self.path, self.source, it, &mut self.sites);
        equality::collect(self.path, self.source, it, &mut self.sites);
        walk::walk_binary_expression(self, it);
    }

    fn visit_logical_expression(&mut self, it: &LogicalExpression<'a>) {
        logical::collect(self.path, self.source, it, &mut self.sites);
        walk::walk_logical_expression(self, it);
    }

    fn visit_boolean_literal(&mut self, it: &BooleanLiteral) {
        boolean::collect(self.path, self.source, it, &mut self.sites);
        walk::walk_boolean_literal(self, it);
    }

    fn visit_conditional_expression(&mut self, it: &ConditionalExpression<'a>) {
        conditional::collect_predicate(
            self.path,
            self.source,
            it.test.span(),
            &mut self.sites,
        );
        walk::walk_conditional_expression(self, it);
    }

    fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
        conditional::collect_predicate(self.path, self.source, it.test.span(), &mut self.sites);
        walk::walk_if_statement(self, it);
    }

    fn visit_while_statement(&mut self, it: &WhileStatement<'a>) {
        conditional::collect_predicate(self.path, self.source, it.test.span(), &mut self.sites);
        walk::walk_while_statement(self, it);
    }

    fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'a>) {
        conditional::collect_predicate(self.path, self.source, it.test.span(), &mut self.sites);
        walk::walk_do_while_statement(self, it);
    }

    /// ADR-029: do not walk `${…}` expressions inside any TemplateLiteral
    /// (tagged or untagged). Default `walk_template_literal` visits expressions;
    /// skipping that walk drops junk arithmetic/equality/boolean/logical sites
    /// from interpolations while leaving non-template operators untouched.
    fn visit_template_literal(&mut self, _it: &TemplateLiteral<'a>) {
        // Intentionally empty — do not call walk::walk_template_literal.
    }
}

/// Locate the infix operator token between `left_end` and `right_start`.
pub(crate) fn infix_operator_span(
    source: &str,
    left_end: u32,
    right_start: u32,
    op: &str,
) -> Option<(u32, u32)> {
    if left_end > right_start || (right_start as usize) > source.len() {
        return None;
    }
    let mid = &source[left_end as usize..right_start as usize];
    let rel = mid.find(|c: char| !c.is_whitespace())?;
    let start = left_end + rel as u32;
    let end = start + op.len() as u32;
    if (end as usize) > source.len() || &source[start as usize..end as usize] != op {
        return None;
    }
    Some((start, end))
}

pub(crate) fn push_operator_sites(
    path: &str,
    source: &str,
    start: u32,
    end: u32,
    mutator_name: &str,
    replacements: &[&str],
    sites: &mut Vec<Site>,
) {
    for replacement in replacements {
        sites.push(Site::at(
            path,
            source,
            start,
            end,
            mutator_name,
            *replacement,
        ));
    }
}
