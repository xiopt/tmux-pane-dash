#[derive(Debug, Clone, Copy)]
pub enum Field {
    Expanded,
    Plain,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum EncodeError {
    #[error("expanded tmux fields cannot contain #[ style markers")]
    ContainsStyleMarker,
    #[error("expanded tmux fields cannot contain backslashes")]
    ContainsBackslash,
    #[error("expanded tmux fields cannot contain control bytes")]
    ContainsControlByte,
    #[error("tmux argv fields cannot contain NUL bytes")]
    ContainsNul,
}

pub fn encode(value: &str, field: Field) -> Result<String, EncodeError> {
    if value.contains('\0') {
        return Err(EncodeError::ContainsNul);
    }

    let mut encoded = match field {
        Field::Expanded => {
            if value.contains("#[") {
                return Err(EncodeError::ContainsStyleMarker);
            }
            if value.contains('\\') {
                return Err(EncodeError::ContainsBackslash);
            }
            if value.bytes().any(|byte| (0x01..=0x1f).contains(&byte)) {
                return Err(EncodeError::ContainsControlByte);
            }

            value.replace('#', "##")
        }
        Field::Plain => value.to_owned(),
    };

    if encoded.ends_with(';') {
        encoded.pop();
        encoded.push_str(r"\;");
    }

    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::{EncodeError, Field, encode};

    macro_rules! assert_encoded {
        ($name:ident, $value:expr, $field:expr, $expected:expr) => {
            #[test]
            fn $name() {
                assert_eq!(encode($value, $field), Ok($expected.to_owned()));
            }
        };
    }

    macro_rules! assert_rejected {
        ($name:ident, $value:expr, $field:expr, $error:expr) => {
            #[test]
            fn $name() {
                assert_eq!(encode($value, $field), Err($error));
            }
        };
    }

    assert_encoded!(expanded_plain, "hello", Field::Expanded, "hello");
    assert_encoded!(plain_plain, "hello", Field::Plain, "hello");
    assert_encoded!(expanded_interior_semi, "a;b", Field::Expanded, "a;b");
    assert_encoded!(plain_interior_semi, "a;b", Field::Plain, "a;b");
    assert_encoded!(expanded_trailing_semi, "a;", Field::Expanded, "a\\;");
    assert_encoded!(plain_trailing_semi, "a;", Field::Plain, "a\\;");
    assert_encoded!(expanded_double_trailing, "a;;", Field::Expanded, "a;\\;");
    assert_encoded!(plain_double_trailing, "a;;", Field::Plain, "a;\\;");
    assert_encoded!(expanded_hash, "a#b", Field::Expanded, "a##b");
    assert_encoded!(plain_hash, "a#b", Field::Plain, "a#b");
    assert_encoded!(expanded_hash_brace, "a#{x}b", Field::Expanded, "a##{x}b");
    assert_encoded!(plain_hash_brace, "a#{x}b", Field::Plain, "a#{x}b");
    assert_encoded!(expanded_unmatched_open, "a#{b", Field::Expanded, "a##{b");
    assert_encoded!(plain_unmatched_open, "a#{b", Field::Plain, "a#{b");
    assert_encoded!(expanded_raw_close, "a}b", Field::Expanded, "a}b");
    assert_encoded!(plain_raw_close, "a}b", Field::Plain, "a}b");
    assert_encoded!(expanded_hash_close, "a#}b", Field::Expanded, "a##}b");
    assert_encoded!(plain_hash_close, "a#}b", Field::Plain, "a#}b");
    assert_encoded!(
        expanded_hash_paren,
        "a#(echo hi)b",
        Field::Expanded,
        "a##(echo hi)b"
    );
    assert_encoded!(
        plain_hash_paren,
        "a#(echo hi)b",
        Field::Plain,
        "a#(echo hi)b"
    );
    assert_encoded!(
        expanded_hash_trailing_semi,
        "a#b;",
        Field::Expanded,
        "a##b\\;"
    );
    assert_encoded!(plain_hash_trailing_semi, "a#b;", Field::Plain, "a#b\\;");
    assert_encoded!(expanded_unicode, "ünïcödé—π", Field::Expanded, "ünïcödé—π");
    assert_encoded!(plain_unicode, "ünïcödé—π", Field::Plain, "ünïcödé—π");
    assert_encoded!(expanded_leading_dash, "-foo", Field::Expanded, "-foo");
    assert_encoded!(plain_leading_dash, "-foo", Field::Plain, "-foo");
    assert_encoded!(expanded_spaces, "a space b", Field::Expanded, "a space b");
    assert_encoded!(plain_spaces, "a space b", Field::Plain, "a space b");
    assert_encoded!(
        expanded_quotes,
        "a\"quote\"b",
        Field::Expanded,
        "a\"quote\"b"
    );
    assert_encoded!(plain_quotes, "a\"quote\"b", Field::Plain, "a\"quote\"b");

    assert_rejected!(
        expanded_prebackslashed,
        "a\\;",
        Field::Expanded,
        EncodeError::ContainsBackslash
    );
    assert_encoded!(plain_prebackslashed, "a\\;", Field::Plain, "a\\\\;");
    assert_rejected!(
        expanded_lone_backslash,
        "a\\",
        Field::Expanded,
        EncodeError::ContainsBackslash
    );
    assert_encoded!(plain_lone_backslash, "a\\", Field::Plain, "a\\");
    assert_rejected!(
        expanded_double_backslash_semi,
        "a\\\\;",
        Field::Expanded,
        EncodeError::ContainsBackslash
    );
    assert_encoded!(
        plain_double_backslash_semi,
        "a\\\\;",
        Field::Plain,
        "a\\\\\\;"
    );
    assert_rejected!(
        expanded_interior_backslash,
        "a\\b;",
        Field::Expanded,
        EncodeError::ContainsBackslash
    );
    assert_encoded!(plain_interior_backslash, "a\\b;", Field::Plain, "a\\b\\;");

    assert_rejected!(
        expanded_style_marker,
        "#[fg=red]x",
        Field::Expanded,
        EncodeError::ContainsStyleMarker
    );
    assert_encoded!(plain_style_marker, "#[fg=red]x", Field::Plain, "#[fg=red]x");
    assert_encoded!(
        expanded_injection_sentinel,
        "x; new-window",
        Field::Expanded,
        "x; new-window"
    );
    assert_encoded!(
        plain_injection_sentinel,
        "x; new-window",
        Field::Plain,
        "x; new-window"
    );

    assert_rejected!(
        expanded_nul_takes_precedence,
        "\0#[\\\u{1}",
        Field::Expanded,
        EncodeError::ContainsNul
    );
    assert_rejected!(plain_nul, "\0", Field::Plain, EncodeError::ContainsNul);
    assert_rejected!(
        expanded_newline,
        "a\nb",
        Field::Expanded,
        EncodeError::ContainsControlByte
    );
    assert_encoded!(plain_newline, "a\nb", Field::Plain, "a\nb");
    assert_rejected!(
        expanded_start_of_heading,
        "a\u{1}b",
        Field::Expanded,
        EncodeError::ContainsControlByte
    );
    assert_encoded!(plain_start_of_heading, "a\u{1}b", Field::Plain, "a\u{1}b");
    assert_rejected!(
        expanded_unit_separator,
        "a\u{1f}b",
        Field::Expanded,
        EncodeError::ContainsControlByte
    );
    assert_encoded!(plain_unit_separator, "a\u{1f}b", Field::Plain, "a\u{1f}b");
}
