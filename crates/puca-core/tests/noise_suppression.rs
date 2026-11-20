//! Behavioral tests for Phase 3.5 discovery noise suppression (SC-401..404, SC-407).

use puca_core::{discover, discover_outcome};

#[test]
fn sc403_console_and_logger_arg_subtrees_emit_no_sites() {
    // Given
    let source = "console.log(a + b);\nlogger.info(x === 1);\nconst n = a + b;\n";

    // When
    let outcome = discover_outcome("sc403.ts", source).expect("discover");

    // Then — no sites on diagnostic-arg lines; free `a + b` remains
    assert!(
        outcome.sites.iter().all(|s| s.start_line == 3),
        "SC-403: only line-3 free `a + b` should remain, got {:?}",
        outcome.sites
    );
    assert_eq!(
        outcome
            .sites
            .iter()
            .filter(|s| s.mutator_name == "ArithmeticOperator")
            .count(),
        1,
        "SC-403: exactly one free arithmetic site expected"
    );
    assert!(
        outcome
            .sites
            .iter()
            .all(|s| s.mutator_name != "EqualityOperator"),
        "SC-403: logger.info equality arg must be omitted"
    );
    assert!(
        outcome.skipped_by_heuristic >= 2,
        "SC-403: console/logger arg sites must count as skipped_by_heuristic, got {}",
        outcome.skipped_by_heuristic
    );
}

#[test]
fn sc404_closed_tce_omitted_negatives_remain() {
    // Given — closed TCE set + negatives `0 - x` and `x + ""`
    let source = r#"
const a = x + 0;
const b = 0 + x;
const c = x - 0;
const d = x * 1;
const e = 1 * x;
const f = x / 1;
const g = 0 - x;
const h = x + "";
"#;

    // When
    let outcome = discover_outcome("sc404.ts", source).expect("discover");

    // Then
    let arithmetic: Vec<_> = outcome
        .sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator")
        .collect();

    assert_eq!(
        arithmetic.len(),
        2,
        "SC-404: only `0 - x` and `x + \"\"` should remain, got {arithmetic:?}"
    );
    assert!(
        outcome.skipped_by_heuristic >= 6,
        "SC-404: six TCE shapes must be skipped, got {}",
        outcome.skipped_by_heuristic
    );

    let source_slices: Vec<&str> = arithmetic
        .iter()
        .map(|s| &source[s.start_offset as usize..s.end_offset as usize])
        .collect();
    assert!(
        source_slices.contains(&"-") && source_slices.contains(&"+"),
        "SC-404: remaining ops should be `-` and `+`, got {source_slices:?}"
    );
}

#[test]
fn sc401_bare_next_line_omits_all_mutators_on_line() {
    // Given
    let source = "// puca-disable-next-line\nconst v = a + b && c;\nconst keep = x - y;\n";

    // When
    let outcome = discover_outcome("sc401.ts", source).expect("discover");

    // Then — line 2 fully suppressed; line 3 arithmetic remains
    assert!(
        outcome.sites.iter().all(|s| s.start_line != 2),
        "SC-401: bare next-line must omit all mutators on line 2, got {:?}",
        outcome.sites
    );
    assert!(
        outcome
            .sites
            .iter()
            .any(|s| s.mutator_name == "ArithmeticOperator" && s.start_line == 3),
        "SC-401: later arithmetic must remain"
    );
    assert!(
        outcome.disabled_by_directive >= 2,
        "SC-401: disabled_by_directive should count omitted sites, got {}",
        outcome.disabled_by_directive
    );
}

#[test]
fn sc401_named_next_line_omits_only_listed_operator() {
    // Given — Equality + Arithmetic on same line
    let source = "// puca-disable-next-line EqualityOperator\nconst v = a + b === c;\n";

    // When
    let outcome = discover_outcome("sc401b.ts", source).expect("discover");

    // Then
    assert!(
        outcome
            .sites
            .iter()
            .all(|s| s.mutator_name != "EqualityOperator"),
        "SC-401 named: EqualityOperator must be omitted, got {:?}",
        outcome.sites
    );
    assert!(
        outcome
            .sites
            .iter()
            .any(|s| s.mutator_name == "ArithmeticOperator"),
        "SC-401 named: ArithmeticOperator must remain, got {:?}",
        outcome.sites
    );
}

#[test]
fn sc402_unknown_token_warns_known_still_applies() {
    // Given
    let source = "// puca-disable-next-line NoSuchOp, ArithmeticOperator\nconst v = a + b === c;\n";

    // When
    let outcome = discover_outcome("sc402.ts", source).expect("discover");

    // Then
    assert!(
        outcome.warnings.iter().any(|w| w.contains("NoSuchOp")),
        "SC-402: warnings must mention unknown token, got {:?}",
        outcome.warnings
    );
    assert!(
        outcome
            .sites
            .iter()
            .all(|s| s.mutator_name != "ArithmeticOperator"),
        "SC-402: known ArithmeticOperator must still be omitted"
    );
    assert!(
        outcome
            .sites
            .iter()
            .any(|s| s.mutator_name == "EqualityOperator"),
        "SC-402: EqualityOperator must remain"
    );
}

#[test]
fn sc407_block_comment_disable_is_ignored() {
    // Given
    let source = "/* puca-disable */\nconst v = a + b;\n";

    // When
    let sites = discover("sc407.ts", source).expect("discover");

    // Then
    assert!(
        sites.iter().any(|s| s.mutator_name == "ArithmeticOperator"),
        "SC-407: block comments must not suppress sites, got {sites:?}"
    );
}
