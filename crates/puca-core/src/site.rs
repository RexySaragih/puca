//! Mutation site records: byte offsets and locations without mutant source text.

/// A single mutation opportunity discovered in source.
///
/// Offsets are UTF-8 byte indices into the original source. Line and column
/// are 1-based. Operators (later tickets) fill `mutator_name` and `replacement`;
/// this ticket only defines the shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    /// Source path used at discovery (typically relative).
    pub path: String,
    /// Inclusive start UTF-8 byte offset of the span to replace.
    pub start_offset: u32,
    /// Exclusive end UTF-8 byte offset of the span to replace.
    pub end_offset: u32,
    /// 1-based line of `start_offset`.
    pub start_line: u32,
    /// 1-based column of `start_offset` (UTF-8 bytes from line start).
    pub start_column: u32,
    /// 1-based line of `end_offset`.
    pub end_line: u32,
    /// 1-based column of `end_offset` (UTF-8 bytes from line start).
    pub end_column: u32,
    /// Operator family name placeholder (e.g. `ArithmeticOperator`).
    pub mutator_name: String,
    /// Replacement text for lazy apply; empty until operators emit sites.
    pub replacement: String,
}

impl Site {
    /// Build a site with location fields derived from `source` and byte offsets.
    pub fn at(
        path: impl Into<String>,
        source: &str,
        start_offset: u32,
        end_offset: u32,
        mutator_name: impl Into<String>,
        replacement: impl Into<String>,
    ) -> Self {
        let (start_line, start_column) = offset_to_line_column(source, start_offset);
        let (end_line, end_column) = offset_to_line_column(source, end_offset);
        Self {
            path: path.into(),
            start_offset,
            end_offset,
            start_line,
            start_column,
            end_line,
            end_column,
            mutator_name: mutator_name.into(),
            replacement: replacement.into(),
        }
    }
}

/// Convert a UTF-8 byte offset to 1-based line and column.
pub fn offset_to_line_column(source: &str, offset: u32) -> (u32, u32) {
    let offset = offset as usize;
    let clamped = offset.min(source.len());
    let mut line = 1_u32;
    let mut column = 1_u32;
    for (idx, ch) in source.char_indices() {
        if idx >= clamped {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += ch.len_utf8() as u32;
        }
    }
    (line, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_maps_first_byte_to_line_one_column_one() {
        assert_eq!(offset_to_line_column("a + b", 0), (1, 1));
    }

    #[test]
    fn offset_maps_after_newline() {
        let source = "a\nb";
        assert_eq!(offset_to_line_column(source, 2), (2, 1));
    }
}
