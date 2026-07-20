use std::hint::black_box;

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use pane_dash::{
    model::{Model, ModelConfig},
    snapshot::parse,
};

fn snapshot(panes: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(panes * 180);
    for index in 0..panes {
        let session = index % 5;
        let window = index / 4;
        let status = match index % 4 {
            0 => "working",
            1 => "needs_input",
            _ => "",
        };
        let command = if index % 4 == 2 { "opencode" } else { "zsh" };
        let tag = if index % 11 == 0 { "investigate" } else { "" };
        let group = if index % 3 == 0 { "1" } else { "" };
        let record = format!(
            "\x1e${session}\x1fsession-{session}\x1f@{window}\x1f{}\x1fwork-{window}\x1f%{}\x1f{}\x1f{}\x1f{command}\x1f/Users/example/project-{session}\x1f0\x1f{status}\x1f{}\x1f{}\x1fTask {index}\x1fclaude-sonnet\x1f{tag}\x1f{group}\n",
            window % 12,
            index + 1,
            index % 4,
            u8::from(index % 4 == 0),
            1_700_000_000_u64 + index as u64,
            1_700_000_010_u64 + index as u64,
        );
        output.extend_from_slice(record.as_bytes());
    }
    output
}

fn benches(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("core");
    for panes in [100_usize, 500, 1_000] {
        let bytes = snapshot(panes);
        group.throughput(Throughput::Elements(panes as u64));
        group.bench_with_input(BenchmarkId::new("parse", panes), &bytes, |bench, bytes| {
            bench.iter(|| parse(black_box(bytes)));
        });
        group.bench_with_input(
            BenchmarkId::new("parse_model_rows", panes),
            &bytes,
            |bench, bytes| {
                bench.iter(|| {
                    let outcome = parse(black_box(bytes));
                    let model =
                        Model::build(&outcome.records, &ModelConfig::default(), 1_700_000_100);
                    black_box(model.rows(true));
                });
            },
        );
    }
    group.finish();
}

criterion_group!(core_benches, benches);
criterion_main!(core_benches);
