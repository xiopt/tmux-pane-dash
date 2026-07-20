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
    pub dropped: usize,
}

pub fn parse(bytes: &[u8]) -> ParseOutcome {
    let Some(first_record) = bytes.iter().position(|byte| *byte == RS) else {
        return ParseOutcome::default();
    };

    let mut outcome = ParseOutcome::default();
    for record in bytes[first_record + 1..].split(|byte| *byte == RS) {
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        match parse_record(record) {
            Some(record) => outcome.records.push(record),
            None => outcome.dropped += 1,
        }
    }

    outcome
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
    fn keeps_newlines_as_field_data() {
        let mut values = fields("alpha\nbeta");
        values[14] = b"title\ncontinued".to_vec();

        let outcome = parse(&record(&values));

        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.records[0].session_name, "alpha\nbeta");
        assert_eq!(outcome.records[0].title, "title\ncontinued");
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
