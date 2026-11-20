//! napi-rs bindings: expose puca-core discover + apply to Node.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use puca_core::Site;

/// NAPI DTO mirroring [`puca_core::Site`] field names for round-trip apply.
#[napi(object)]
pub struct SiteDto {
    pub path: String,
    pub start_offset: u32,
    pub end_offset: u32,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub mutator_name: String,
    pub replacement: String,
}

impl From<Site> for SiteDto {
    fn from(site: Site) -> Self {
        Self {
            path: site.path,
            start_offset: site.start_offset,
            end_offset: site.end_offset,
            start_line: site.start_line,
            start_column: site.start_column,
            end_line: site.end_line,
            end_column: site.end_column,
            mutator_name: site.mutator_name,
            replacement: site.replacement,
        }
    }
}

impl From<SiteDto> for Site {
    fn from(dto: SiteDto) -> Self {
        Self {
            path: dto.path,
            start_offset: dto.start_offset,
            end_offset: dto.end_offset,
            start_line: dto.start_line,
            start_column: dto.start_column,
            end_line: dto.end_line,
            end_column: dto.end_column,
            mutator_name: dto.mutator_name,
            replacement: dto.replacement,
        }
    }
}

/// Discover mutation sites for `source` identified by `filename`.
///
/// Does not write files — returns site DTOs with offsets only.
#[napi]
pub fn discover(filename: String, source: String) -> Result<Vec<SiteDto>> {
    puca_core::discover(&filename, &source)
        .map(|sites| sites.into_iter().map(SiteDto::from).collect())
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Discover sites plus directive/heuristic omit counts and warnings (ADR-039).
#[napi(object)]
pub struct DiscoverOutcomeDto {
    pub sites: Vec<SiteDto>,
    pub disabled_by_directive: u32,
    pub skipped_by_heuristic: u32,
    pub warnings: Vec<String>,
}

#[napi]
pub fn discover_outcome(filename: String, source: String) -> Result<DiscoverOutcomeDto> {
    puca_core::discover_outcome(&filename, &source)
        .map(|outcome| DiscoverOutcomeDto {
            sites: outcome.sites.into_iter().map(SiteDto::from).collect(),
            disabled_by_directive: outcome.disabled_by_directive as u32,
            skipped_by_heuristic: outcome.skipped_by_heuristic as u32,
            warnings: outcome.warnings,
        })
        .map_err(|err| Error::from_reason(err.to_string()))
}

/// Lazily splice `site.replacement` over `[start_offset, end_offset)` in `source`.
///
/// Returns a new string; does not write paths.
#[napi]
pub fn apply(source: String, site: SiteDto) -> String {
    puca_core::apply(&source, &Site::from(site))
}
