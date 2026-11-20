//! Púca core mutator library: parse TypeScript/TSX, discover and apply sites.
//!
//! Phase 1 records UTF-8 byte offsets and locations; mutants are applied lazily
//! by splicing replacements into the original source. Disable comments omit
//! sites at discovery time.

pub mod apply;
pub mod disable;
pub mod discover;
pub mod heuristics;
pub mod operators;
pub mod parse;
pub mod site;

pub use apply::apply;
pub use disable::{filter_disabled, scan_disables, DisableMap, DisableScan};
pub use discover::{discover, discover_outcome, DiscoverOutcome};
pub use parse::{parse, parse_ok, source_type_from_filename, ParseError};
pub use site::{offset_to_line_column, Site};
