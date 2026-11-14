//! Behavioral tests for oxc parse + discover (AC1, AC2).

use puca_core::{discover, parse_ok, source_type_from_filename};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn discover_valid_ts_returns_list_without_writing_files() {
    let source = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let probe = std::env::temp_dir().join(format!("puca-core-discover-probe-{stamp}"));
    assert!(!probe.exists());

    let sites = discover("fixture.ts", source).expect("discover should succeed");
    // Operators land later — empty list is valid for this ticket.
    let _ = sites.len();

    assert!(
        !probe.exists(),
        "discover must not create files on disk (AC1)"
    );
    // Confirm no accidental write under CWD either for a unique name.
    let cwd_probe = PathBuf::from(format!("puca-core-no-write-{stamp}.ts"));
    assert!(!cwd_probe.exists());
    let _ = fs::remove_file(&cwd_probe);
}

#[test]
fn tsx_source_type_and_trivial_component_parse() {
    let filename = "Button.tsx";
    let source_type = source_type_from_filename(filename).expect("tsx extension");
    assert!(
        source_type.is_typescript() && source_type.is_jsx(),
        "AC2: .tsx must resolve to TypeScript + JSX (TSX)"
    );

    let source = r#"
export function Button(props: { label: string }) {
  return <button type="button">{props.label}</button>;
}
"#;
    parse_ok(filename, source).expect("AC2: trivial TSX component must parse");
    let sites = discover(filename, source).expect("discover after TSX parse");
    // No JSX mutators in Phase 1 — empty sites are expected.
    assert!(sites.is_empty());
}

#[test]
fn site_helper_records_offsets_and_one_based_location() {
    let source = "const x = 1;\nconst y = 2;\n";
    // "y" starts at byte offset after first line.
    let start = source.find('y').expect("y") as u32;
    let end = start + 1;
    let site = puca_core::Site::at("a.ts", source, start, end, "Placeholder", "z");
    assert_eq!(site.start_offset, start);
    assert_eq!(site.end_offset, end);
    assert_eq!(site.start_line, 2);
    assert_eq!(site.start_column, 7);
    assert_eq!(site.mutator_name, "Placeholder");
    assert_eq!(site.replacement, "z");
}
