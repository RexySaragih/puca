//! Mutation site discovery over an oxc AST.

use crate::disable::scan_disables;
use crate::operators::collect_sites;
use crate::parse::{parse, ParseError};
use crate::site::Site;
use oxc_allocator::Allocator;

/// Sites kept after disable-comment filtering, plus how many were omitted.
pub struct DiscoverOutcome {
    pub sites: Vec<Site>,
    pub disabled_count: usize,
}

/// Discover mutation sites in `source` for `filename`.
///
/// Parses with oxc ([`crate::parse`]) and walks the AST with core operators.
/// Sites covered by `// puca-disable*` line comments are omitted.
/// Never writes files or stringifies mutants — sites carry offsets only.
pub fn discover(filename: &str, source: &str) -> Result<Vec<Site>, ParseError> {
    Ok(discover_outcome(filename, source)?.sites)
}

/// Same as [`discover`], also reporting how many operator sites disable comments omitted.
pub fn discover_outcome(filename: &str, source: &str) -> Result<DiscoverOutcome, ParseError> {
    let allocator = Allocator::new();
    let parsed = parse(&allocator, filename, source)?;
    let all = collect_sites(filename, source, &parsed.program);
    let disables = scan_disables(source);
    let disabled_count = all
        .iter()
        .filter(|site| disables.is_disabled(site.start_line))
        .count();
    let sites = all
        .into_iter()
        .filter(|site| !disables.is_disabled(site.start_line))
        .collect();
    Ok(DiscoverOutcome {
        sites,
        disabled_count,
    })
}
