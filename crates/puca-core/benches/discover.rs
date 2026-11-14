//! Criterion bench: parse+discover p95 <1ms on a ≥400 LOC stand-in (NFR-101 / AC3).
//!
//! Hardware under test is documented in the threshold failure message and in
//! the module-level constant below so CI/local regressions are attributable.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use puca_core::discover;
use std::time::Duration;

/// Measured host for AC3 / SC-115 documentation.
const HARDWARE_NOTE: &str =
    "Apple M4 (darwin arm64); NFR-101 target: p95 parse+discover <1ms on ≥400 LOC";

/// Hard ceiling for a single parse+discover call (nanoseconds).
const P95_BUDGET_NS: u64 = 1_000_000; // 1ms

fn stand_in_source(min_lines: usize) -> String {
    let mut out = String::with_capacity(min_lines * 48);
    out.push_str("// puca-core discover bench stand-in (≥400 LOC)\n");
    out.push_str("export type Num = number;\n");
    for i in 0..min_lines {
        out.push_str(&format!(
            "export function f{i}(a: Num, b: Num): Num {{\n  const t = a + b;\n  return t === 0 ? a : b && t;\n}}\n"
        ));
    }
    out
}

fn count_lines(source: &str) -> usize {
    source.lines().count()
}

fn bench_parse_discover(c: &mut Criterion) {
    let source = stand_in_source(100); // 1 header + type + ~400 body lines
    let loc = count_lines(&source);
    assert!(
        loc >= 400,
        "bench stand-in must be ≥400 LOC, got {loc} (hardware: {HARDWARE_NOTE})"
    );

    // Quick gate: measure a handful of iterations and fail if p95 exceeds 1ms.
    // Criterion's --quick path still runs this setup, so CI catches regressions.
    {
        const SAMPLES: usize = 64;
        let mut times = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = std::time::Instant::now();
            let sites = discover("stand_in.ts", &source).expect("discover");
            black_box(sites);
            times.push(start.elapsed().as_nanos() as u64);
        }
        times.sort_unstable();
        let idx = ((SAMPLES as f64) * 0.95).ceil() as usize - 1;
        let p95 = times[idx.min(SAMPLES - 1)];
        assert!(
            p95 < P95_BUDGET_NS,
            "parse+discover p95 {p95}ns exceeds {P95_BUDGET_NS}ns (1ms) on {loc} LOC. Hardware: {HARDWARE_NOTE}"
        );
    }

    let mut group = c.benchmark_group("parse_discover");
    group.warm_up_time(Duration::from_millis(200));
    group.measurement_time(Duration::from_secs(1));
    group.bench_with_input(
        BenchmarkId::new("stand_in_ts", format!("{loc}_loc")),
        &source,
        |b, src| {
            b.iter(|| {
                let sites = discover("stand_in.ts", black_box(src)).expect("discover");
                black_box(sites);
            });
        },
    );
    group.finish();
}

criterion_group!(benches, bench_parse_discover);
criterion_main!(benches);
