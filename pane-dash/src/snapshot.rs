use std::collections::HashSet;

const RS: u8 = 0x1e;
const US: u8 = 0x1f;
const FIELD_COUNT: usize = 18;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRecord {
    pub session_id: String,
    pub session_name: String,
    pub window_id: String,
    pub window_index: u32,
    pub window_name: String,
    pub pane_id: String,
    pub pane_index: u32,
    pub pane_active: bool,
    pub pane_current_command: String,
    pub pane_current_path: String,
    pub pane_dead: bool,
    pub status: String,
    pub status_since: Option<u64>,
    pub heartbeat: Option<u64>,
    pub title: String,
    pub model: String,
    pub tag: String,
    pub group: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParseOutcome {
    pub records: Vec<RawRecord>,
    pub raw_panes: HashSet<String>,
    pub ambiguous_panes: HashSet<String>,
    pub dropped: usize,
    pub unattributable_dropped: usize,
}

pub fn parse(bytes: &[u8]) -> ParseOutcome {
    let mut outcome = ParseOutcome::default();
    let mut open_record = None;
    let response = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    for line in response.split(|byte| *byte == b'\n') {
        if line.starts_with(&[RS]) {
            for record in line[1..].split(|byte| *byte == RS) {
                flush_record(&mut outcome, open_record.take());
                open_record = Some((record, false));
            }
        } else if let Some((_, invalid)) = open_record.as_mut() {
            *invalid = true;
        }
    }
    flush_record(&mut outcome, open_record);

    outcome
}

fn flush_record(outcome: &mut ParseOutcome, record: Option<(&[u8], bool)>) {
    let Some((record, invalid)) = record else {
        return;
    };

    if invalid {
        record_drop(outcome, record);
    } else if let Some(record) = parse_record(record) {
        outcome.raw_panes.insert(record.pane_id.clone());
        outcome.records.push(record);
    } else {
        record_drop(outcome, record);
    }
}

fn record_drop(outcome: &mut ParseOutcome, record: &[u8]) {
    outcome.dropped += 1;
    let fields: Vec<_> = record.split(|byte| *byte == US).collect();
    if let Some(pane_id) = attributable_pane_id(&fields) {
        outcome.ambiguous_panes.insert(decode(pane_id));
    } else {
        outcome.unattributable_dropped += 1;
    }
}

fn attributable_pane_id<'a>(fields: &[&'a [u8]]) -> Option<&'a [u8]> {
    if fields.len() != FIELD_COUNT
        || !is_numeric_machine_id(fields[0], b'$')
        || !is_numeric_machine_id(fields[2], b'@')
        || !is_numeric_pane_id(fields[5])
        || parse_u32(fields[3]).is_none()
        || parse_u32(fields[6]).is_none()
        || parse_bool(fields[7]).is_none()
        || parse_bool(fields[10]).is_none()
    {
        return None;
    }
    Some(fields[5])
}

fn is_numeric_machine_id(value: &[u8], prefix: u8) -> bool {
    value
        .strip_prefix(&[prefix])
        .is_some_and(|digits| !digits.is_empty() && digits.iter().all(u8::is_ascii_digit))
}

fn is_numeric_pane_id(value: &[u8]) -> bool {
    is_numeric_machine_id(value, b'%')
}

fn parse_record(record: &[u8]) -> Option<RawRecord> {
    let fields: Vec<_> = record.split(|byte| *byte == US).collect();
    if fields.len() != FIELD_COUNT {
        return None;
    }

    if !fields[0].starts_with(b"$") || !fields[2].starts_with(b"@") || !fields[5].starts_with(b"%")
    {
        return None;
    }

    Some(RawRecord {
        session_id: decode(fields[0]),
        session_name: decode(fields[1]),
        window_id: decode(fields[2]),
        window_index: parse_u32(fields[3])?,
        window_name: decode(fields[4]),
        pane_id: decode(fields[5]),
        pane_index: parse_u32(fields[6])?,
        pane_active: parse_bool(fields[7])?,
        pane_current_command: decode(fields[8]),
        pane_current_path: decode(fields[9]),
        pane_dead: parse_bool(fields[10])?,
        status: decode(fields[11]),
        status_since: parse_optional_u64(fields[12])?,
        heartbeat: parse_optional_u64(fields[13])?,
        title: decode(fields[14]),
        model: decode(fields[15]),
        tag: decode(fields[16]),
        group: decode(fields[17]),
    })
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_u32(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

fn parse_bool(bytes: &[u8]) -> Option<bool> {
    match parse_u32(bytes)? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn parse_optional_u64(bytes: &[u8]) -> Option<Option<u64>> {
    if bytes.is_empty() {
        Some(None)
    } else {
        std::str::from_utf8(bytes).ok()?.parse().ok().map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    const RS: u8 = 0x1e;
    const US: u8 = 0x1f;

    fn fields(name: &str) -> Vec<Vec<u8>> {
        [
            "$1",
            name,
            "@2",
            "3",
            "window",
            "%4",
            "5",
            "1",
            "opencode",
            "/tmp/project",
            "0",
            "working",
            "1700000000",
            "1700000001",
            "Task title",
            "model",
            "tag",
            "1",
        ]
        .into_iter()
        .map(|field| field.as_bytes().to_vec())
        .collect()
    }

    fn record(fields: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = vec![RS];
        for (index, field) in fields.iter().enumerate() {
            if index != 0 {
                bytes.push(US);
            }
            bytes.extend(field);
        }
        bytes
    }

    #[test]
    fn parses_three_valid_records() {
        let mut bytes = record(&fields("alpha"));
        bytes.extend(record(&fields("beta")));
        bytes.extend(record(&fields("gamma")));

        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records.len(), 3);
        assert_eq!(outcome.records[0].session_name, "alpha");
        assert_eq!(outcome.records[1].window_index, 3);
        assert!(outcome.records[2].pane_active);
        assert!(!outcome.records[2].pane_dead);
        assert_eq!(outcome.records[2].status_since, Some(1_700_000_000));
        assert_eq!(outcome.records[2].heartbeat, Some(1_700_000_001));
    }

    #[test]
    fn tracks_every_semantically_valid_raw_pane_before_discovery_filtering() {
        let mut undiscovered = fields("undiscovered");
        undiscovered[5] = b"%undiscovered".to_vec();
        undiscovered[8] = b"shell".to_vec();
        for field in &mut undiscovered[11..17] {
            field.clear();
        }
        let mut linked = undiscovered.clone();
        linked[0] = b"$linked".to_vec();
        linked[2] = b"@linked".to_vec();
        let mut malformed = fields("malformed");
        malformed[5] = b"not-a-pane".to_vec();

        let mut bytes = record(&undiscovered);
        bytes.extend(record(&linked));
        bytes.extend(record(&malformed));
        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 1);
        assert_eq!(outcome.records.len(), 2);
        assert!(outcome.raw_panes.contains("%undiscovered"));
        assert_eq!(outcome.raw_panes.len(), 1);
        assert!(!outcome.raw_panes.contains("not-a-pane"));
    }

    #[test]
    fn attributes_malformed_records_only_to_syntactically_valid_numeric_pane_ids() {
        let mut target = fields("target");
        target[5] = b"%42".to_vec();
        target[12] = b"not-a-number".to_vec();
        let mut unrelated = fields("unrelated");
        unrelated[5] = b"%7".to_vec();
        unrelated[12] = b"not-a-number".to_vec();
        let mut unattributable = fields("unattributable");
        unattributable[5] = b"%not-numeric".to_vec();
        unattributable[12] = b"not-a-number".to_vec();

        let mut bytes = record(&target);
        bytes.extend(record(&target));
        bytes.extend(record(&unrelated));
        bytes.extend(record(&unattributable));
        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 4);
        assert_eq!(outcome.ambiguous_panes.len(), 2);
        assert!(outcome.ambiguous_panes.contains("%42"));
        assert!(outcome.ambiguous_panes.contains("%7"));
        assert_eq!(outcome.unattributable_dropped, 1);
    }

    #[test]
    fn structural_or_framing_damage_never_attributes_a_crafted_pane_id() {
        let mut hostile_us = fields("hostile-us");
        hostile_us.insert(5, b"shifted".to_vec());
        hostile_us[6] = b"%42".to_vec();
        let truncated = fields("truncated")[..12].to_vec();
        let mut invalid_structural_number = fields("bad-index");
        invalid_structural_number[3] = b"not-an-index".to_vec();
        invalid_structural_number[5] = b"%42".to_vec();

        let mut bytes = record(&hostile_us);
        bytes.extend(record(&truncated));
        bytes.extend(record(&invalid_structural_number));
        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 3);
        assert!(outcome.ambiguous_panes.is_empty());
        assert_eq!(outcome.unattributable_dropped, 3);
    }

    #[test]
    fn strips_tmux_row_lf_without_changing_empty_final_fields() {
        let mut empty_group = fields("empty-group");
        empty_group[17].clear();
        let mut zero_group = fields("zero-group");
        zero_group[17] = b"0".to_vec();

        let mut bytes = record(&empty_group);
        bytes.push(b'\n');
        bytes.extend(record(&zero_group));
        bytes.push(b'\n');

        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records.len(), 2);
        assert_eq!(outcome.records[0].group, "");
        assert_eq!(outcome.records[1].group, "0");
    }

    #[test]
    fn drops_records_with_newline_continuations_in_any_field() {
        let mut bytes = Vec::new();
        for field_index in [0, 8, 17] {
            let mut values = fields("valid");
            values[field_index].extend(b"\ncontinuation");
            bytes.extend(record(&values));
            bytes.push(b'\n');
        }

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 3);
    }

    #[test]
    fn drops_notification_looking_continuation_lines() {
        let mut values = fields("valid");
        values[8] = b"command\n%window-add @9".to_vec();

        let outcome = parse(&record(&values));

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 1);
    }

    #[test]
    fn drops_records_with_us_in_first_middle_or_final_field() {
        let mut bytes = Vec::new();
        for field_index in [0, 8, 17] {
            let mut values = fields("valid");
            values[field_index].extend([US, b'x']);
            bytes.extend(record(&values));
        }

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 3);
    }

    #[test]
    fn hostile_rs_splits_and_drops_semantically_invalid_synthetic_record() {
        let prefix = fields("valid");
        let mut invalid_synthetic = fields("synthetic");
        invalid_synthetic[5] = b"pane-without-percent-prefix".to_vec();

        let mut bytes = record(&prefix[..8]);
        bytes.push(US);
        bytes.extend(b"command");
        bytes.push(RS);
        let synthetic = record(&invalid_synthetic);
        bytes.extend(&synthetic[1..]);

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 2);
    }

    #[test]
    fn hostile_rs_can_form_a_separately_valid_synthetic_record() {
        let prefix = fields("original");
        let synthetic = record(&fields("synthetic"));
        let mut bytes = record(&prefix[..9]);
        bytes.push(RS);
        bytes.extend(&synthetic[1..]);

        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 1);
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.records[0].session_name, "synthetic");
    }

    #[test]
    fn accepts_command_matched_pane_with_empty_option_fields() {
        let mut values = fields("command-only");
        for field in &mut values[11..] {
            field.clear();
        }

        let outcome = parse(&record(&values));

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.records[0].status, "");
        assert_eq!(outcome.records[0].status_since, None);
        assert_eq!(outcome.records[0].heartbeat, None);
    }

    #[test]
    fn parses_truncated_final_record_without_a_trailing_rs() {
        let bytes = record(&fields("tail"));

        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.records[0].session_name, "tail");
    }

    #[test]
    fn ignores_noise_before_the_first_record() {
        let mut bytes = b"tmux chatter\n".to_vec();
        bytes.extend(record(&fields("valid")));

        let outcome = parse(&bytes);

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records.len(), 1);
    }

    #[test]
    fn ignores_valid_record_embedded_in_non_prefixed_preamble_line() {
        let mut bytes = b"tmux chatter ".to_vec();
        bytes.extend(record(&fields("embedded")));

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 0);
    }

    #[test]
    fn empty_input_has_no_records_or_drops() {
        let outcome = parse(b"");

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 0);
    }

    #[test]
    fn drops_wrong_required_id_prefixes() {
        let mut bytes = Vec::new();
        for (field_index, wrong_id) in [(0, "session"), (2, "window"), (5, "pane")] {
            let mut values = fields("invalid-id");
            values[field_index] = wrong_id.as_bytes().to_vec();
            bytes.extend(record(&values));
        }

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 3);
    }

    #[test]
    fn drops_unparseable_required_and_optional_numerics() {
        let mut bytes = Vec::new();
        for field_index in [3, 6, 7, 10, 12, 13] {
            let mut values = fields("invalid-number");
            values[field_index] = b"not-a-number".to_vec();
            bytes.extend(record(&values));
        }

        let outcome = parse(&bytes);

        assert!(outcome.records.is_empty());
        assert_eq!(outcome.dropped, 6);
    }

    #[test]
    fn keeps_non_utf8_field_data_lossily() {
        let mut values = fields("valid");
        values[1] = vec![b'a', 0xff, b'b'];

        let outcome = parse(&record(&values));

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records[0].session_name, "a�b");
    }
}
