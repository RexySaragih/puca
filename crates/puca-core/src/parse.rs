//! Oxc-backed TypeScript / TSX parsing (no mutant serialization).

use oxc_allocator::Allocator;
use oxc_parser::{Parser, ParserReturn};
use oxc_span::SourceType;
use std::path::Path;

/// Errors from determining source type or running the parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Filename extension is not a supported JS/TS type.
    UnknownExtension(String),
    /// Parser reported one or more diagnostics.
    Syntax(Vec<String>),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::UnknownExtension(ext) => {
                write!(f, "unknown or unsupported source extension: {ext}")
            }
            ParseError::Syntax(errors) => {
                write!(f, "parse failed with {} error(s)", errors.len())?;
                if let Some(first) = errors.first() {
                    write!(f, ": {first}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ParseError {}

/// Resolve [`SourceType`] from a filename extension (`.ts` → TS, `.tsx` → TSX).
pub fn source_type_from_filename(filename: &str) -> Result<SourceType, ParseError> {
    SourceType::from_path(Path::new(filename)).map_err(|_| {
        let ext = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();
        ParseError::UnknownExtension(ext)
    })
}

/// Parse `source` with oxc using a source type derived from `filename`.
///
/// Returns the arena-backed [`ParserReturn`]. Callers must keep `allocator`
/// alive for as long as the returned AST is used.
pub fn parse<'a>(
    allocator: &'a Allocator,
    filename: &str,
    source: &'a str,
) -> Result<ParserReturn<'a>, ParseError> {
    let source_type = source_type_from_filename(filename)?;
    let ret = Parser::new(allocator, source, source_type).parse();
    if !ret.diagnostics.is_empty() {
        let messages = ret
            .diagnostics
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>();
        return Err(ParseError::Syntax(messages));
    }
    Ok(ret)
}

/// Parse and drop the AST, verifying only that the file is syntactically valid.
pub fn parse_ok(filename: &str, source: &str) -> Result<(), ParseError> {
    let allocator = Allocator::new();
    let _ = parse(&allocator, filename, source)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_extension_is_typescript_not_jsx() {
        let st = source_type_from_filename("calc.ts").expect("ts");
        assert!(st.is_typescript());
        assert!(!st.is_jsx());
    }

    #[test]
    fn tsx_extension_is_typescript_with_jsx() {
        let st = source_type_from_filename("Button.tsx").expect("tsx");
        assert!(st.is_typescript());
        assert!(st.is_jsx());
    }
}
