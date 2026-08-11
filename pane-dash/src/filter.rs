use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};

use crate::model::{Model, Row, Status};

pub fn ranked_row_indices(model: &Model, grouped: bool, query: &str) -> Vec<usize> {
    let rows = model.rows(grouped);
    if query.is_empty() {
        return (0..rows.len()).collect();
    }

    let pattern = Pattern::new(
        query,
        CaseMatching::Smart,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut utf32_buf = Vec::new();
    let mut matches = rows
        .iter()
        .enumerate()
        .filter_map(|(row_index, row)| {
            let haystack = match row {
                Row::Pane {
                    session_id,
                    window_id,
                    pane_id,
                    command,
                    path,
                    title,
                    model: model_name,
                    tag,
                    status,
                    ..
                } => {
                    let session = &model.sessions()[session_id];
                    let window = &model.windows()[window_id];
                    let label = if !title.is_empty() {
                        title
                    } else if !tag.is_empty() {
                        tag
                    } else {
                        command
                    };
                    format!(
                        "{} {} {} {} {} {} {}",
                        session.name,
                        window.name,
                        label,
                        path,
                        model_name,
                        status_text(*status),
                        pane_id.0
                    )
                }
                Row::Headless {
                    session_id,
                    title,
                    directory,
                    model,
                    status,
                    ..
                } => format!(
                    "kimaki {} {} {} {} {}",
                    session_id.0,
                    title,
                    directory,
                    model,
                    status_text(*status)
                ),
                Row::SessionHeader { .. } | Row::HeadlessHeader { .. } => return None,
            };
            pattern
                .score(Utf32Str::new(&haystack, &mut utf32_buf), &mut matcher)
                .map(|score| (row_index, score, row_index))
        })
        .collect::<Vec<_>>();

    sort_matches(&mut matches);
    if !grouped {
        return matches
            .into_iter()
            .map(|(row_index, _, _)| row_index)
            .collect();
    }

    let mut indices = Vec::new();
    for (header_index, header) in rows.iter().enumerate() {
        let same_group = |row: &Row| match (header, row) {
            (
                Row::SessionHeader { session_id, .. },
                Row::Pane {
                    session_id: pane_session_id,
                    ..
                },
            ) => pane_session_id == session_id,
            (Row::HeadlessHeader { .. }, Row::Headless { .. }) => true,
            _ => false,
        };
        // `matches` is globally sorted by descending score and native row order, and filtering
        // preserves that order for each session's subset.
        let session_matches = matches
            .iter()
            .copied()
            .filter(|(row_index, _, _)| same_group(&rows[*row_index]))
            .collect::<Vec<_>>();
        if session_matches.is_empty() {
            continue;
        }
        indices.push(header_index);
        indices.extend(
            session_matches
                .into_iter()
                .map(|(row_index, _, _)| row_index),
        );
    }
    indices
}

fn sort_matches(matches: &mut [(usize, u32, usize)]) {
    matches.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.2.cmp(&right.2)));
}

fn status_text(status: Status) -> &'static str {
    match status {
        Status::Working => "working",
        Status::NeedsInput => "needs_input",
        Status::Idle => "idle",
        Status::Error => "error",
        Status::Unknown => "unknown",
        Status::Stale => "stale",
    }
}

#[cfg(test)]
mod tests {
    use super::ranked_row_indices;
    use crate::{
        model::{HeadlessRecord, HeadlessSessionId, Model, ModelConfig, Row, Status},
        snapshot::RawRecord,
    };

    #[test]
    fn searches_every_normative_membership_field() {
        let model = model(vec![
            record(
                "alpha",
                "frontend",
                "%1",
                "Fix login",
                "",
                "opencode",
                "/work/auth",
                "sonnet",
                "working",
            ),
            record(
                "beta",
                "worker",
                "%2",
                "",
                "urgent",
                "bash",
                "/srv/jobs",
                "fable",
                "error",
            ),
        ]);

        for query in [
            "alpha",
            "frontend",
            "Fix login",
            "/work/auth",
            "sonnet",
            "working",
            "%1",
        ] {
            assert_eq!(
                pane_ids(&model, &ranked_row_indices(&model, false, query)),
                vec!["%1"],
                "query: {query}"
            );
        }
        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "urgent")),
            vec!["%2"]
        );
        assert!(ranked_row_indices(&model, false, "opencode").is_empty());
    }

    #[test]
    fn title_hides_tag_and_command_in_label_fallback() {
        let model = model(vec![record(
            "alpha", "one", "%1", "title", "!tag", "!command", "/a", "model", "working",
        )]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "title")),
            vec!["%1"]
        );
        assert!(ranked_row_indices(&model, false, "!tag").is_empty());
        assert!(ranked_row_indices(&model, false, "!command").is_empty());
    }

    #[test]
    fn tag_hides_command_in_label_fallback() {
        let model = model(vec![record(
            "alpha", "one", "%1", "", "tag", "!command", "/a", "model", "working",
        )]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "tag")),
            vec!["%1"]
        );
        assert!(ranked_row_indices(&model, false, "!command").is_empty());
    }

    #[test]
    fn grouped_results_keep_session_order_and_rank_within_each_group() {
        let mut alpha_long = record(
            "alpha",
            "one",
            "%1",
            "a---u---t---h",
            "",
            "opencode",
            "/a",
            "sonnet",
            "working",
        );
        alpha_long.pane_index = 0;
        let mut alpha_exact = record(
            "alpha", "one", "%2", "auth", "", "opencode", "/b", "sonnet", "working",
        );
        alpha_exact.pane_index = 1;
        let mut beta_long = record(
            "beta",
            "two",
            "%3",
            "a---u---t---h",
            "",
            "opencode",
            "/c",
            "fable",
            "idle",
        );
        beta_long.pane_index = 0;
        let mut beta_exact = record(
            "beta", "two", "%4", "auth", "", "opencode", "/d", "fable", "idle",
        );
        beta_exact.pane_index = 1;
        let model = model(vec![alpha_exact, alpha_long, beta_exact, beta_long]);

        let indices = ranked_row_indices(&model, true, "auth");
        assert!(
            matches!(model.rows(true)[indices[0]], Row::SessionHeader { ref name, .. } if name == "alpha")
        );
        assert!(
            matches!(model.rows(true)[indices[3]], Row::SessionHeader { ref name, .. } if name == "beta")
        );
        assert_eq!(
            grouped_pane_ids(&model, &indices),
            vec!["%2", "%1", "%4", "%3"]
        );
    }

    #[test]
    fn flat_results_rank_all_matches_globally() {
        let mut long = record(
            "alpha",
            "one",
            "%1",
            "a---u---t---h",
            "",
            "opencode",
            "/a",
            "sonnet",
            "working",
        );
        long.pane_index = 0;
        let mut exact = record(
            "alpha", "one", "%2", "auth", "", "opencode", "/b", "fable", "working",
        );
        exact.pane_index = 1;
        let model = model(vec![exact, long]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "auth")),
            vec!["%2", "%1"]
        );
    }

    #[test]
    fn empty_query_returns_native_row_order() {
        let model = model(vec![
            record(
                "beta", "two", "%2", "Second", "", "opencode", "/b", "fable", "idle",
            ),
            record(
                "alpha", "one", "%1", "First", "", "opencode", "/a", "sonnet", "working",
            ),
        ]);

        assert_eq!(
            ranked_row_indices(&model, true, ""),
            (0..model.rows(true).len()).collect::<Vec<_>>()
        );
        assert_eq!(
            ranked_row_indices(&model, false, ""),
            (0..model.rows(false).len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_scores_retain_native_row_order() {
        let model = model(vec![
            record(
                "alpha", "one", "%1", "match", "", "opencode", "/a", "sonnet", "working",
            ),
            record(
                "beta", "two", "%2", "match", "", "opencode", "/b", "fable", "idle",
            ),
        ]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "match")),
            pane_ids(&model, &(0..model.rows(false).len()).collect::<Vec<_>>())
        );
    }

    #[test]
    fn smart_case_and_unicode_are_supported() {
        let model = model(vec![record(
            "alpha", "one", "%1", "Résumé", "", "opencode", "/a", "model", "working",
        )]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "résumé")),
            vec!["%1"]
        );
        assert!(ranked_row_indices(&model, false, "RÉSUMÉ").is_empty());
    }

    #[test]
    fn operator_like_characters_are_literal_fuzzy_text() {
        let model = model(vec![record(
            "alpha",
            "one",
            "%1",
            "cost$ !bang ^caret 'quote",
            "",
            "opencode",
            "/a",
            "sonnet",
            "working",
        )]);

        for query in ["$", "!bang", "^caret", "'quote"] {
            assert_eq!(
                pane_ids(&model, &ranked_row_indices(&model, false, query)),
                vec!["%1"],
                "query: {query}"
            );
        }
    }

    #[test]
    fn linked_panes_match_each_membership_haystack_independently() {
        let mut alpha = record(
            "alpha", "frontend", "%1", "Work", "", "opencode", "/shared", "sonnet", "working",
        );
        alpha.window_id = "@shared".into();
        let mut beta = alpha.clone();
        beta.session_id = "$beta".into();
        beta.session_name = "beta".into();
        beta.window_id = "@worker".into();
        beta.window_name = "worker".into();
        let model = model(vec![alpha, beta]);

        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "alpha frontend")),
            vec!["%1"]
        );
        assert_eq!(
            pane_ids(&model, &ranked_row_indices(&model, false, "beta worker")),
            vec!["%1"]
        );
    }

    #[test]
    fn headless_rows_filter_by_exact_api_metadata_and_keep_kimaki_header() {
        let model = model(vec![]).replace_headless(&[HeadlessRecord {
            source_url: "http://127.0.0.1:53550".into(),
            session_id: HeadlessSessionId::from("ses_exact"),
            title: "Deploy worker".into(),
            directory: "/work/backend".into(),
            model: "gpt-test".into(),
            status: Status::NeedsInput,
            status_since: Some(1),
        }]);

        for query in [
            "kimaki",
            "ses_exact",
            "Deploy",
            "backend",
            "gpt-test",
            "needs_input",
        ] {
            let indices = ranked_row_indices(&model, true, query);
            assert_eq!(indices, vec![0, 1], "query: {query}");
        }
        assert!(ranked_row_indices(&model, true, "missing").is_empty());
    }

    fn model(records: Vec<RawRecord>) -> Model {
        Model::build(&records, &ModelConfig::default(), 1_000)
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        session_name: &str,
        window_name: &str,
        pane_id: &str,
        title: &str,
        tag: &str,
        command: &str,
        path: &str,
        model: &str,
        status: &str,
    ) -> RawRecord {
        RawRecord {
            session_id: format!("${session_name}"),
            session_name: session_name.into(),
            window_id: format!("@{window_name}"),
            window_index: 0,
            window_name: window_name.into(),
            pane_id: pane_id.into(),
            pane_index: 0,
            pane_active: false,
            pane_current_command: command.into(),
            pane_current_path: path.into(),
            pane_dead: false,
            status: status.into(),
            status_since: Some(999),
            heartbeat: Some(1_000),
            title: title.into(),
            model: model.into(),
            opencode_session: String::new(),
            tag: tag.into(),
            group: "0".into(),
        }
    }

    fn pane_ids<'a>(model: &'a Model, indices: &[usize]) -> Vec<&'a str> {
        pane_ids_for_rows(model.rows(false), indices)
    }

    fn grouped_pane_ids<'a>(model: &'a Model, indices: &[usize]) -> Vec<&'a str> {
        pane_ids_for_rows(model.rows(true), indices)
    }

    fn pane_ids_for_rows<'a>(rows: &'a [Row], indices: &[usize]) -> Vec<&'a str> {
        indices
            .iter()
            .filter_map(|&index| match &rows[index] {
                Row::Pane { pane_id, .. } => Some(pane_id.0.as_str()),
                Row::SessionHeader { .. } | Row::HeadlessHeader { .. } | Row::Headless { .. } => {
                    None
                }
            })
            .collect()
    }
}
