use std::hint::black_box;

use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pane_dash::{
    app::{AppState, Event, reduce},
    config::LoadedUiConfig,
    filter::ranked_row_indices,
    model::{Model, ModelConfig},
    options::DashConfig,
    snapshot::parse,
    ui,
};
use ratatui::{Terminal, backend::TestBackend};

const NOW: u64 = 1_700_000_100;

fn snapshot(panes: usize, grouped: bool) -> Vec<u8> {
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
        let tag = if index % 11 == 0 {
            "investigate"
        } else if status.is_empty() && command != "opencode" {
            "benchmark"
        } else {
            ""
        };
        let group = if grouped { "1" } else { "0" };
        let record = format!(
            "\x1e${session}\x1fsession-{session}\x1f@{window}\x1f{}\x1fwork-{window}\x1f%{}\x1f{}\x1f{}\x1f{command}\x1f/Users/example/project-{session}\x1f0\x1f{status}\x1f{}\x1f{}\x1fauth Task {index}\x1fclaude-sonnet-{}\x1f\x1f{tag}\x1f{group}\n",
            window % 12,
            index + 1,
            index % 4,
            u8::from(index % 4 == 0),
            1_700_000_000_u64 + index as u64,
            1_700_000_050_u64 + index as u64,
            index % 7,
        );
        output.extend_from_slice(record.as_bytes());
    }
    output
}

fn model(panes: usize, grouped: bool) -> Model {
    let outcome = parse(&snapshot(panes, grouped));
    Model::build(&outcome.records, &ModelConfig::default(), NOW)
}

fn prepared_filter_bench(model: Model) -> (AppState, Terminal<TestBackend>) {
    let mut app = AppState::new(model, DashConfig::default(), LoadedUiConfig::default());
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    reduce(
        &mut app,
        Event::Key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
    );
    for character in "aut".chars() {
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)),
        );
    }
    app.prepare_render(NOW);
    terminal.draw(|frame| ui::render(frame, &app, NOW)).unwrap();
    (app, terminal)
}

fn bench_filter_keystroke_to_frame(criterion: &mut Criterion, name: &str, model: Model) {
    criterion.bench_function(name, |bench| {
        bench.iter_batched(
            || prepared_filter_bench(model.clone()),
            |(mut app, mut terminal)| {
                let result = reduce(
                    &mut app,
                    Event::Key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE)),
                );
                app.prepare_render(NOW);
                terminal.draw(|frame| ui::render(frame, &app, NOW)).unwrap();
                black_box(result);
                black_box(terminal.backend().buffer());
            },
            BatchSize::SmallInput,
        );
    });
}

fn benches(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("core");
    for panes in [100_usize, 500, 1_000] {
        let bytes = snapshot(panes, true);
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
                    let model = Model::build(&outcome.records, &ModelConfig::default(), NOW);
                    black_box(model.rows(true));
                });
            },
        );
    }
    group.finish();

    let grouped_model = model(500, true);
    assert_eq!(grouped_model.memberships().len(), 500);
    let flat_model = model(500, false);
    assert_eq!(flat_model.memberships().len(), 500);
    criterion.bench_function("filter/matcher_only/500/grouped", |bench| {
        bench.iter(|| ranked_row_indices(black_box(&grouped_model), true, black_box("auth")));
    });
    criterion.bench_function("filter/matcher_only/500/flat", |bench| {
        bench.iter(|| ranked_row_indices(black_box(&flat_model), false, black_box("auth")));
    });
    bench_filter_keystroke_to_frame(
        criterion,
        "filter_keystroke_to_frame/500/grouped",
        grouped_model,
    );
    bench_filter_keystroke_to_frame(criterion, "filter_keystroke_to_frame/500/flat", flat_model);
}

criterion_group!(core_benches, benches);
criterion_main!(core_benches);
