#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashConfig {
    pub match_pattern: String,
    pub stale_secs: u64,
    pub group_default: bool,
    pub new_command: String,
    pub theme: String,
}

impl Default for DashConfig {
    fn default() -> Self {
        Self {
            match_pattern: "opencode".into(),
            stale_secs: 60,
            group_default: true,
            new_command: "opencode".into(),
            theme: "dark".into(),
        }
    }
}

pub fn parse_show_options(bytes: &[u8]) -> DashConfig {
    let mut config = DashConfig::default();

    for line in bytes.split(|byte| *byte == b'\n') {
        let Some(separator) = line.iter().position(|byte| *byte == b' ') else {
            continue;
        };
        let (name, value) = (&line[..separator], &line[separator + 1..]);

        if !name.starts_with(b"@pane-dash-") && !name.starts_with(b"@pane_dash_") {
            continue;
        }

        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        let Some(value) = decode_args_escape(value) else {
            continue;
        };

        match name {
            "@pane-dash-match" => config.match_pattern = value,
            "@pane-dash-stale-secs" => {
                if let Ok(stale_secs) = value.parse::<u64>()
                    && stale_secs > 0
                {
                    config.stale_secs = stale_secs;
                }
            }
            "@pane_dash_group" => match value.as_str() {
                "0" => config.group_default = false,
                "1" => config.group_default = true,
                _ => {}
            },
            "@pane-dash-new-command" => config.new_command = value,
            "@pane-dash-theme" => config.theme = value,
            _ => {}
        }
    }

    config
}

fn decode_args_escape(value: &[u8]) -> Option<String> {
    let decoded = match value.first() {
        Some(b'\'') => decode_single_quoted(value)?,
        Some(b'"') => decode_double_quoted(value)?,
        _ => decode_escapes(value, false)?,
    };

    String::from_utf8(decoded).ok()
}

fn decode_single_quoted(value: &[u8]) -> Option<Vec<u8>> {
    (value.len() >= 2
        && value.last() == Some(&b'\'')
        && !value[1..value.len() - 1].contains(&b'\''))
    .then(|| value[1..value.len() - 1].to_vec())
}

fn decode_double_quoted(value: &[u8]) -> Option<Vec<u8>> {
    if value.len() < 2 || value.last() != Some(&b'"') {
        return None;
    }

    decode_escapes(&value[1..value.len() - 1], true)
}

fn decode_escapes(value: &[u8], reject_unescaped_quote: bool) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        let byte = value[index];
        if reject_unescaped_quote && byte == b'"' {
            return None;
        }
        if byte != b'\\' {
            decoded.push(byte);
            index += 1;
            continue;
        }

        index += 1;
        let escaped = *value.get(index)?;
        let decoded_byte = match escaped {
            b'\\' | b'"' | b'$' => escaped,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'0'..=b'7' => {
                let second = *value.get(index + 1)?;
                let third = *value.get(index + 2)?;
                if !matches!(second, b'0'..=b'7') || !matches!(third, b'0'..=b'7') {
                    return None;
                }
                index += 2;
                (escaped - b'0') * 64 + (second - b'0') * 8 + (third - b'0')
            }
            _ => return None,
        };
        decoded.push(decoded_byte);
        index += 1;
    }

    Some(decoded)
}

#[cfg(test)]
mod tests {
    use super::{DashConfig, parse_show_options};

    #[test]
    fn extracts_bare_and_escaped_global_options() {
        let config = parse_show_options(
            r#"status on
@pane-dash-match "open\"code\\cli\$"
@pane-dash-stale-secs 90
@pane_dash_group 0
@pane-dash-new-command 'opencode --model "π"'
@pane-dash-theme solarized
"#
            .as_bytes(),
        );

        assert_eq!(
            config,
            DashConfig {
                match_pattern: "open\"code\\cli$".into(),
                stale_secs: 90,
                group_default: false,
                new_command: "opencode --model \"π\"".into(),
                theme: "solarized".into(),
            }
        );
    }

    #[test]
    fn decodes_quoted_empties_control_escapes_and_unicode() {
        let config = parse_show_options(
            "@pane-dash-match ''\n@pane-dash-new-command \"\"\n@pane-dash-theme \"line\\n\\036\\037 π\"\n"
                .as_bytes(),
        );

        assert_eq!(config.match_pattern, "");
        assert_eq!(config.new_command, "");
        assert_eq!(config.theme, "line\n\x1e\x1f π");
    }

    #[test]
    fn decodes_args_escape_sequences_in_bare_values() {
        let config = parse_show_options(b"@pane-dash-new-command line\\n\\036\\037\\\\\\\"\\$\n");

        assert_eq!(config.new_command, "line\n\x1e\x1f\\\"$");
    }

    #[test]
    fn ignores_malformed_or_unclosed_dash_options_and_invalid_stale_secs() {
        let config = parse_show_options(
            br#"@pane-dash-match "unterminated
@pane-dash-stale-secs garbage
@pane_dash_group 2
@pane-dash-new-command "bad\q"
@pane-dash-theme "bad\12"
@other-option "ignored"
"#,
        );

        assert_eq!(config, DashConfig::default());
    }

    #[test]
    fn ignores_quotes_that_close_before_the_end_of_a_value() {
        let config = parse_show_options(
            b"@pane-dash-match 'not'quoted'\n@pane-dash-theme \"not\"quoted\"\n",
        );

        assert_eq!(config, DashConfig::default());
    }
}
