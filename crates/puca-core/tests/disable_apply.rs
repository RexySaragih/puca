//! Behavioral tests for disable comments and lazy apply (po_1a0203 AC1–AC4).

use puca_core::{apply, discover, Site};

fn arithmetic_plus_to_minus(sites: &[Site]) -> Vec<&Site> {
    sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator" && s.replacement == "-")
        .collect()
}

#[test]
fn ac1_puca_disable_next_line_omits_arithmetic_on_following_plus() {
    // Given — directive immediately above the `+` line (inside a function for parse)
    let source = "function f(a: number, b: number) {\n  // puca-disable-next-line\n  return a + b;\n}\n";

    // When
    let sites = discover("ac1.ts", source).expect("discover");

    // Then — no ArithmeticOperator site whose span starts on the `return a + b` line
    let plus_line = 3_u32;
    let plus_sites: Vec<_> = sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator")
        .filter(|s| s.start_line == plus_line)
        .collect();
    assert!(
        plus_sites.is_empty(),
        "AC1: `// puca-disable-next-line` must omit ArithmeticOperator on next-line `+`, got {plus_sites:?}"
    );
}

#[test]
fn ac2_puca_disable_omits_later_operators_keeps_earlier() {
    // Given — earlier `+`, mid-file disable, later `-`
    let source = "const early = a + b;\n// puca-disable\nconst late = c - d;\n";

    // When
    let sites = discover("ac2.ts", source).expect("discover");

    // Then
    let early: Vec<_> = sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator" && s.start_line == 1)
        .collect();
    let late: Vec<_> = sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator" && s.start_line == 3)
        .collect();

    assert!(
        !early.is_empty(),
        "AC2: operators before `// puca-disable` must remain, got sites {sites:?}"
    );
    assert!(
        late.is_empty(),
        "AC2: operators after `// puca-disable` must be omitted, got {late:?}"
    );
}

#[test]
fn ac3_apply_splices_replacement_original_unchanged() {
    // Given
    let source = String::from("const x = a + b;");
    let sites = discover("ac3.ts", &source).expect("discover");
    let site = sites
        .iter()
        .find(|s| s.mutator_name == "ArithmeticOperator" && s.replacement == "-")
        .expect("expected ArithmeticOperator +→- site");

    // When
    let mutated = apply(&source, site);

    // Then
    assert_eq!(&source[site.start_offset as usize..site.end_offset as usize], "+");
    assert_eq!(
        &mutated[site.start_offset as usize..site.start_offset as usize + site.replacement.len()],
        "-"
    );
    assert_eq!(mutated, "const x = a - b;");
    assert_eq!(source, "const x = a + b;", "AC3: original string must be unchanged");
}

#[test]
fn ac4_stryker_disable_does_not_suppress_sites() {
    // Given
    let source = "function f(a: number, b: number) {\n  // Stryker disable\n  return a + b;\n}\n";

    // When
    let sites = discover("ac4.ts", source).expect("discover");

    // Then
    let arithmetic = arithmetic_plus_to_minus(&sites);
    assert!(
        !arithmetic.is_empty(),
        "AC4: `// Stryker disable` must not suppress next-line operators, got {sites:?}"
    );
    assert!(
        arithmetic.iter().any(|s| s.start_line == 3),
        "AC4: expected ArithmeticOperator on the return line, got {arithmetic:?}"
    );
}
