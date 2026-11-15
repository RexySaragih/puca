//! Behavioral tests for core operators (§4.4 / AC1–AC3).

use puca_core::{discover, Site};

fn replacements_named<'a>(sites: &'a [Site], mutator: &str) -> Vec<&'a str> {
    sites
        .iter()
        .filter(|s| s.mutator_name == mutator)
        .map(|s| s.replacement.as_str())
        .collect()
}

fn all_replacements(sites: &[Site]) -> Vec<&str> {
    sites.iter().map(|s| s.replacement.as_str()).collect()
}

#[test]
fn ac1_core_operators_emit_expected_replacements() {
    // Given snippets covering each family
    let source = "a + b; a === b; true; a && b; if (a) {}";

    // When
    let sites = discover("ac1.ts", source).expect("discover");

    // Then
    let arithmetic = replacements_named(&sites, "ArithmeticOperator");
    assert!(
        arithmetic.contains(&"-"),
        "ArithmeticOperator on `+` should yield `-`, got {arithmetic:?}"
    );

    let equality = replacements_named(&sites, "EqualityOperator");
    assert!(
        equality.contains(&"!=="),
        "EqualityOperator on `===` should yield `!==`, got {equality:?}"
    );

    let boolean = replacements_named(&sites, "BooleanLiteral");
    assert!(
        boolean.contains(&"false"),
        "BooleanLiteral on `true` should yield `false`, got {boolean:?}"
    );

    let logical = replacements_named(&sites, "LogicalOperator");
    assert!(
        logical.contains(&"||"),
        "LogicalOperator on `&&` should yield `||`, got {logical:?}"
    );

    let conditional = replacements_named(&sites, "ConditionalExpression");
    assert!(
        conditional.contains(&"true") && conditional.contains(&"false"),
        "ConditionalExpression on `if (a)` should yield true and false, got {conditional:?}"
    );

    let all = all_replacements(&sites);
    for expected in ["-", "!==", "false", "||", "true"] {
        assert!(
            all.contains(&expected),
            "AC1: replacements should include `{expected}`, got {all:?}"
        );
    }
}

#[test]
fn ac2_for_header_is_not_conditional_expression() {
    // Given
    let source = "for (let i = 0; i < n; i++) {}";

    // When
    let sites = discover("ac2.ts", source).expect("discover");

    // Then — no ConditionalExpression on the for test (equality on `i < n` may still emit)
    let conditional = sites
        .iter()
        .filter(|s| s.mutator_name == "ConditionalExpression")
        .collect::<Vec<_>>();
    assert!(
        conditional.is_empty(),
        "AC2: for header must not emit ConditionalExpression sites, got {conditional:?}"
    );

    let equality = replacements_named(&sites, "EqualityOperator");
    assert!(
        !equality.is_empty(),
        "AC2: EqualityOperator on `i < n` may still emit; expected at least one site"
    );
}

#[test]
fn ac3_string_literal_addition_is_still_a_site() {
    // Given — string operands; no type pruning
    let source = r#""a" + "b""#;

    // When
    let sites = discover("ac3.ts", source).expect("discover");

    // Then
    let arithmetic = sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator")
        .collect::<Vec<_>>();
    assert_eq!(
        arithmetic.len(),
        1,
        "AC3: string `+` must still be an ArithmeticOperator site"
    );
    assert_eq!(arithmetic[0].replacement, "-");
    let start = arithmetic[0].start_offset as usize;
    let end = arithmetic[0].end_offset as usize;
    assert_eq!(&source[start..end], "+");
}

#[test]
fn untagged_template_interpolation_emits_no_sites() {
    // Given — untagged template with arithmetic and boolean interpolations (SC-321)
    let source = "const s = `x ${a + b}`; const t = `${flag}`;";

    // When
    let sites = discover("tpl.ts", source).expect("discover");

    // Then — no sites from expressions inside `${…}`
    assert!(
        sites.is_empty(),
        "SC-321: untagged template interpolations must yield 0 sites, got {sites:?}"
    );
}

#[test]
fn tagged_template_interpolation_emits_no_sites() {
    // Given — tagged template shares the same TemplateLiteral visitor (SC-322)
    let source = "tag`${a + b}`";

    // When
    let sites = discover("tagged.ts", source).expect("discover");

    // Then
    assert!(
        sites.is_empty(),
        "SC-322: tagged template inner expressions must yield 0 sites, got {sites:?}"
    );
}

#[test]
fn non_template_addition_still_discovers_beside_template() {
    // Given — template junk next to a real non-template `+` (SC-323 / A10)
    let source = "const s = `x ${a + b}`; const n = a + b; const lit = \"a\" + \"b\";";

    // When
    let sites = discover("mixed.ts", source).expect("discover");

    // Then — only the two non-template ArithmeticOperator sites
    let arithmetic: Vec<&Site> = sites
        .iter()
        .filter(|s| s.mutator_name == "ArithmeticOperator")
        .collect();
    assert_eq!(
        arithmetic.len(),
        2,
        "SC-323: non-template `a + b` and string `+` must still discover, got {sites:?}"
    );
    for site in &arithmetic {
        let sliced = &source[site.start_offset as usize..site.end_offset as usize];
        assert_eq!(sliced, "+");
        assert_eq!(site.replacement, "-");
    }
}

#[test]
fn unary_plus_minus_are_not_arithmetic_sites() {
    let sites = discover("unary.ts", "+a; -b;").expect("discover");
    assert!(
        replacements_named(&sites, "ArithmeticOperator").is_empty(),
        "unary +/- must not be mutated"
    );
}

#[test]
fn relational_equality_emits_two_replacements() {
    let sites = discover("rel.ts", "a < b").expect("discover");
    let eq = replacements_named(&sites, "EqualityOperator");
    assert_eq!(eq, vec!["<=", ">="]);
}

#[test]
fn ternary_conditional_replaces_predicate_only() {
    // Given — toggleLabel-style ternary; whole expr must stay a string
    let source = "export function toggleLabel(on: boolean): string {\n  return on ? \"on\" : \"off\";\n}\n";

    // When
    let sites = discover("flagMatrix.ts", source).expect("discover");

    // Then
    let conditional: Vec<&Site> = sites
        .iter()
        .filter(|s| s.mutator_name == "ConditionalExpression")
        .collect();
    assert_eq!(
        conditional.len(),
        2,
        "ternary should emit true and false predicate sites, got {conditional:?}"
    );
    let mut replacements: Vec<&str> = conditional
        .iter()
        .map(|s| s.replacement.as_str())
        .collect();
    replacements.sort();
    assert_eq!(replacements, vec!["false", "true"]);
    for site in conditional {
        let sliced = &source[site.start_offset as usize..site.end_offset as usize];
        assert_eq!(
            sliced, "on",
            "ConditionalExpression must splice the test node only, not `on ? \"on\" : \"off\"`, got {sliced:?}"
        );
    }
}
