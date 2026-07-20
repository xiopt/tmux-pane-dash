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
    let (value, reject_unescaped_quote) = match value.first() {
        Some(b'\'') => (unwrap_single_quotes(value)?, false),
        Some(b'"') => (unwrap_double_quotes(value)?, true),
        _ => (value, false),
    };

    String::from_utf8(decode_escapes(value, reject_unescaped_quote)?).ok()
}

fn unwrap_single_quotes(value: &[u8]) -> Option<&[u8]> {
    (value.len() >= 2
        && value.last() == Some(&b'\'')
        && !value[1..value.len() - 1].contains(&b'\''))
    .then(|| &value[1..value.len() - 1])
}

fn unwrap_double_quotes(value: &[u8]) -> Option<&[u8]> {
    if value.len() < 2 || value.last() != Some(&b'"') {
        return None;
    }

    Some(&value[1..value.len() - 1])
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
            b'a' => 0x07,
            b'b' => 0x08,
            b'f' => 0x0c,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => 0x0b,
            // Fail closed for \400 through \777: they cannot encode a byte,
            // so the option is ignored rather than truncated or panicking.
            b'4'..=b'7' => return None,
            b'0'..=b'3' => {
                let mut octal = u16::from(escaped - b'0');
                for _ in 0..2 {
                    let Some(next) = value.get(index + 1) else {
                        break;
                    };
                    if !matches!(next, b'0'..=b'7') {
                        break;
                    }
                    octal = octal * 8 + u16::from(*next - b'0');
                    index += 1;
                }
                u8::try_from(octal).ok()?
            }
            _ => escaped,
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
    fn unescapes_single_quoted_protected_and_c_style_forms() {
        let config = parse_show_options(
            b"@pane-dash-match 'path\\\\to\\#tag\\;\\%\\~'\n@pane-dash-new-command \\a\\b\\f\\v\n@pane-dash-theme \\q\n",
        );

        assert_eq!(config.match_pattern, "path\\to#tag;%~");
        assert_eq!(config.new_command, "\x07\x08\x0c\x0b");
        assert_eq!(config.theme, "q");
    }

    #[test]
    fn ignores_overflowing_octal_escapes_without_panicking() {
        let result = std::panic::catch_unwind(|| {
            for escaped in [b"\\400".as_slice(), b"\\777".as_slice()] {
                assert_eq!(
                    parse_show_options(&[b"@pane-dash-match ".as_slice(), escaped, b"\n"].concat()),
                    DashConfig::default()
                );
            }
        });

        result.expect("overflowing octal must not panic");
    }

    #[test]
    fn ignores_unclosed_dash_options_and_invalid_stale_secs() {
        let config = parse_show_options(
            br#"@pane-dash-match "unterminated
@pane-dash-stale-secs garbage
@pane_dash_group 2
@pane-dash-new-command "unterminated
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
