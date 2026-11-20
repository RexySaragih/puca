//! Mutation site discovery over an oxc AST.

use crate::disable::scan_disables;
use crate::heuristics::filter_heuristics;
use crate::operators::collect_sites;
use crate::parse::{parse, ParseError};
use crate::site::Site;
use oxc_allocator::Allocator;

/// Sites kept after heuristic + directive filters, plus omit counters and warnings.
pub struct DiscoverOutcome {
    pub sites: Vec<Site>,
    /// Sites omitted by `// puca-disable*` directives (Stage-2).
    pub disabled_by_directive: usize,
    /// Sites omitted by Stage-1 heuristics (console/logger args + TCE).
    pub skipped_by_heuristic: usize,
    /// Non-fatal notices (e.g. unknown mutator tokens in directives).
    pub warnings: Vec<String>,
}

/// Discover mutation sites in `source` for `filename`.
///
/// Parses with oxc ([`crate::parse`]) and walks the AST with core operators.
/// Stage-1 heuristics then Stage-2 disable directives omit noise sites.
/// Never writes files or stringifies mutants — sites carry offsets only.
pub fn discover(filename: &str, source: &str) -> Result<Vec<Site>, ParseError> {
    Ok(discover_outcome(filename, source)?.sites)
}

/// Same as [`discover`], also reporting heuristic/directive omit counts and warnings.
pub fn discover_outcome(filename: &str, source: &str) -> Result<DiscoverOutcome, ParseError> {
    let allocator = Allocator::new();
    let parsed = parse(&allocator, filename, source)?;
    let all = collect_sites(filename, source, &parsed.program);

    let (after_heuristics, skipped_by_heuristic) = filter_heuristics(source, &parsed.program, all);

    let scan = scan_disables(source);
    let disabled_by_directive = after_heuristics
        .iter()
        .filter(|site| scan.map.is_disabled(site.start_line, &site.mutator_name))
        .count();
    let sites = after_heuristics
        .into_iter()
        .filter(|site| !scan.map.is_disabled(site.start_line, &site.mutator_name))
        .collect();

    Ok(DiscoverOutcome {
        sites,
        disabled_by_directive,
        skipped_by_heuristic,
        warnings: scan.warnings,
    })
}
