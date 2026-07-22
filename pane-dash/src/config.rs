use crate::palette::{Palette, PaletteSlot, parse_color};
use serde::Deserialize;
use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Read},
    ops::Range,
    path::{Path, PathBuf},
};

const MAX_CONFIG_BYTES: usize = 1024;
const CONFIG_FILE: &str = "tmux-pane-dash/config.toml";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigWarning {
    text: Box<str>,
}

impl ConfigWarning {
    fn new(text: String) -> Self {
        Self {
            text: cap_scalars(text, 160).into_boxed_str(),
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    #[cfg(test)]
    pub(crate) fn for_test(text: &str) -> Self {
        Self::new(text.to_owned())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedUiConfig {
    pub palette: Palette,
    warnings: Box<[ConfigWarning]>,
}

impl LoadedUiConfig {
    pub fn with_palette(palette: Palette) -> Self {
        Self {
            palette,
            warnings: Box::new([]),
        }
    }

    pub fn warnings(&self) -> &[ConfigWarning] {
        &self.warnings
    }

    pub fn warning_texts(&self) -> Vec<&str> {
        self.warnings.iter().map(ConfigWarning::text).collect()
    }

    #[cfg(test)]
    pub(crate) fn with_test_warnings(palette: Palette, warnings: &[&str]) -> Self {
        Self {
            palette,
            warnings: warnings
                .iter()
                .map(|warning| ConfigWarning::for_test(warning))
                .collect(),
        }
    }
}

impl Default for LoadedUiConfig {
    fn default() -> Self {
        Self::with_palette(Palette::dark())
    }
}

pub fn load_ui_config(tmux_theme: &str) -> LoadedUiConfig {
    load_ui_config_impl(tmux_theme, &SystemIo)
}

trait ConfigIo {
    fn var_os(&self, name: &'static str) -> Option<OsString>;
    fn metadata(&self, path: &Path) -> io::Result<FileMetadata>;
    fn read_bounded(&self, path: &Path) -> io::Result<Vec<u8>>;
}

#[derive(Clone, Copy)]
struct FileMetadata {
    is_file: bool,
    len: u64,
}

struct SystemIo;

impl ConfigIo for SystemIo {
    fn var_os(&self, name: &'static str) -> Option<OsString> {
        env::var_os(name)
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        let metadata = fs::metadata(path)?;
        Ok(FileMetadata {
            is_file: metadata.is_file(),
            len: metadata.len(),
        })
    }

    fn read_bounded(&self, path: &Path) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(MAX_CONFIG_BYTES + 1);
        fs::File::open(path)?
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

#[derive(Deserialize)]
struct FileConfig {
    theme: Option<String>,
    text: Option<String>,
    dim: Option<String>,
    accent: Option<String>,
    needs_input: Option<String>,
    working: Option<String>,
    idle: Option<String>,
    error: Option<String>,
    unknown: Option<String>,
    stale: Option<String>,
    warning: Option<String>,
    degrade: Option<String>,
    border: Option<String>,
    status_bar: Option<String>,
    selection_fg: Option<String>,
    selection_bg: Option<String>,
}

impl FileConfig {
    fn slot_value(&self, slot: PaletteSlot) -> Option<&str> {
        match slot {
            PaletteSlot::Text => self.text.as_deref(),
            PaletteSlot::Dim => self.dim.as_deref(),
            PaletteSlot::Accent => self.accent.as_deref(),
            PaletteSlot::NeedsInput => self.needs_input.as_deref(),
            PaletteSlot::Working => self.working.as_deref(),
            PaletteSlot::Idle => self.idle.as_deref(),
            PaletteSlot::Error => self.error.as_deref(),
            PaletteSlot::Unknown => self.unknown.as_deref(),
            PaletteSlot::Stale => self.stale.as_deref(),
            PaletteSlot::Warning => self.warning.as_deref(),
            PaletteSlot::Degrade => self.degrade.as_deref(),
            PaletteSlot::Border => self.border.as_deref(),
            PaletteSlot::StatusBar => self.status_bar.as_deref(),
            PaletteSlot::SelectionFg => self.selection_fg.as_deref(),
            PaletteSlot::SelectionBg => self.selection_bg.as_deref(),
        }
    }
}

fn load_ui_config_impl(tmux_theme: &str, io: &impl ConfigIo) -> LoadedUiConfig {
    let mut warnings = Vec::new();
    let mut palette = match Palette::builtin(tmux_theme) {
        Some(palette) => palette,
        None => {
            warnings.push(format!(
                "theme: unknown tmux theme '{}'; using dark",
                safe_display(tmux_theme)
            ));
            Palette::dark()
        }
    };

    let Some(path) = resolve_config_path(io) else {
        return finish(palette, warnings);
    };
    let metadata = match io.metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return finish(palette, warnings),
        Err(error) => {
            warnings.push(format!(
                "config: cannot inspect '{}' ({}); ignored",
                safe_path(&path),
                stable_error_kind(&error)
            ));
            return finish(palette, warnings);
        }
    };
    if !metadata.is_file {
        warnings.push(format!(
            "config: '{}' is not a regular file; ignored",
            safe_path(&path)
        ));
        return finish(palette, warnings);
    }
    if metadata.len > MAX_CONFIG_BYTES as u64 {
        warnings.push(format!(
            "config: '{}' exceeds 1024 bytes; ignored",
            safe_path(&path)
        ));
        return finish(palette, warnings);
    }
    let bytes = match io.read_bounded(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return finish(palette, warnings),
        Err(error) => {
            warnings.push(format!(
                "config: cannot read '{}' ({}); ignored",
                safe_path(&path),
                stable_error_kind(&error)
            ));
            return finish(palette, warnings);
        }
    };
    if bytes.len() > MAX_CONFIG_BYTES {
        warnings.push(format!(
            "config: '{}' exceeds 1024 bytes; ignored",
            safe_path(&path)
        ));
        return finish(palette, warnings);
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(_) => {
            warnings.push(format!(
                "config: '{}' is not valid UTF-8; ignored",
                safe_path(&path)
            ));
            return finish(palette, warnings);
        }
    };
    let table = match text.parse::<toml::Table>() {
        Ok(table) => table,
        Err(error) => {
            warnings.push(toml_parse_warning(text, error.span()));
            return finish(palette, warnings);
        }
    };
    if let Some(key) = first_nested_key(&table) {
        warnings.push(format!(
            "config: nested table or array at '{}'; ignored",
            safe_display(key)
        ));
        return finish(palette, warnings);
    }
    if let Some(key) = first_recognized_nonstring(&table) {
        warnings.push(format!(
            "config: '{}' must be a string; ignored",
            safe_display(key)
        ));
        return finish(palette, warnings);
    }
    let config: FileConfig = match table.clone().try_into() {
        Ok(config) => config,
        Err(_) => unreachable!("validated TOML table must deserialize"),
    };
    if let Some(theme) = config.theme.as_deref() {
        if let Some(theme_palette) = Palette::builtin(theme) {
            palette = theme_palette;
        } else {
            warnings.push(format!(
                "config: unknown theme '{}'; keeping {}",
                safe_display(theme),
                palette_name(palette)
            ));
        }
    }
    let mut unknown_keys: Vec<_> = table
        .keys()
        .filter(|key| !is_known_key(key))
        .map(String::as_str)
        .collect();
    unknown_keys.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    for key in unknown_keys {
        if key.is_ascii()
            && let Some(known) = nearest_known_key(key)
        {
            warnings.push(format!(
                "config: unknown key '{}'; did you mean '{}'?",
                safe_display(key),
                known
            ));
        }
    }
    for slot in PaletteSlot::ALL {
        if let Some(value) = config.slot_value(slot) {
            if let Some(color) = parse_color(value) {
                palette.apply(slot, color);
            } else {
                warnings.push(format!(
                    "config: invalid color '{}' for '{}'; keeping previous value",
                    safe_display(value),
                    slot.name()
                ));
            }
        }
    }
    finish(palette, warnings)
}

fn finish(palette: Palette, warnings: Vec<String>) -> LoadedUiConfig {
    let mut unique = Vec::new();
    for warning in warnings {
        let warning = ConfigWarning::new(warning);
        if !unique
            .iter()
            .any(|existing: &ConfigWarning| existing == &warning)
        {
            unique.push(warning);
        }
    }
    if unique.len() > 4 {
        let suppressed = unique.len() - 3;
        unique.truncate(3);
        unique.push(ConfigWarning::new(format!(
            "config: {suppressed} additional warnings suppressed"
        )));
    }
    LoadedUiConfig {
        palette,
        warnings: unique.into(),
    }
}

fn resolve_config_path(io: &impl ConfigIo) -> Option<PathBuf> {
    let xdg = io
        .var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty());
    let home = io.var_os("HOME").filter(|value| !value.is_empty());
    xdg.map(|base| Path::new(&base).join(CONFIG_FILE))
        .or_else(|| home.map(|base| Path::new(&base).join(".config").join(CONFIG_FILE)))
}

fn is_known_key(key: &str) -> bool {
    key == "theme" || PaletteSlot::from_name(key).is_some()
}

fn first_nested_key(table: &toml::Table) -> Option<&str> {
    let mut entries: Vec<_> = table.iter().collect();
    entries.sort_unstable_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
    entries.into_iter().find_map(|(key, value)| match value {
        toml::Value::Array(_) | toml::Value::Table(_) => Some(key.as_str()),
        _ => None,
    })
}

fn first_recognized_nonstring(table: &toml::Table) -> Option<&str> {
    std::iter::once("theme")
        .chain(PaletteSlot::ALL.map(PaletteSlot::name))
        .find(|key| table.get(*key).is_some_and(|value| !value.is_str()))
}

fn nearest_known_key(key: &str) -> Option<&'static str> {
    std::iter::once("theme")
        .chain(PaletteSlot::ALL.map(PaletteSlot::name))
        .filter(|known| optimal_damerau_levenshtein_distance_one(key, known))
        .min()
}

fn optimal_damerau_levenshtein_distance_one(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left == right || left.len().abs_diff(right.len()) > 1 {
        return false;
    }
    if left.len() == right.len() {
        let differences: Vec<_> = left
            .iter()
            .zip(right)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .collect();
        return differences.len() == 1
            || (differences.len() == 2
                && differences[1].0 == differences[0].0 + 1
                && differences[0].1.0 == differences[1].1.1
                && differences[0].1.1 == differences[1].1.0);
    }
    let (shorter, longer) = if left.len() < right.len() {
        (left, right)
    } else {
        (right, left)
    };
    let mut short = 0;
    let mut long = 0;
    while short < shorter.len() && shorter[short] == longer[long] {
        short += 1;
        long += 1;
    }
    shorter[short..] == longer[long + 1..]
}

fn palette_name(palette: Palette) -> &'static str {
    if palette == Palette::dark() {
        "dark"
    } else if palette == Palette::light() {
        "light"
    } else {
        "terminal-native"
    }
}

fn stable_error_kind(error: &io::Error) -> String {
    format!("{:?}", error.kind())
}

fn safe_path(path: &Path) -> String {
    safe_display(&path.to_string_lossy())
}

fn safe_display(value: &str) -> String {
    let mut output = String::new();
    let mut boundaries = Vec::new();
    for character in value.chars() {
        let escaped = match character {
            '\\' => "\\\\".to_owned(),
            '\'' => "\\'".to_owned(),
            character if character.is_control() || character == '\u{7f}' => {
                format!("\\u{{{:X}}}", character as u32)
            }
            character => character.to_string(),
        };
        if output.chars().count() + escaped.chars().count() > 48 {
            while output.chars().count() > 47 {
                output.truncate(boundaries.pop().expect("nonempty escaped output"));
            }
            output.push('…');
            return output;
        }
        boundaries.push(output.len());
        output.push_str(&escaped);
    }
    output
}

fn cap_scalars(value: String, max: usize) -> String {
    if value.chars().count() <= max {
        value
    } else {
        let mut capped: String = value.chars().take(max - 1).collect();
        capped.push('…');
        capped
    }
}

fn toml_parse_warning(source: &str, span: Option<Range<usize>>) -> String {
    let Some(span) = span else {
        return "config: TOML parse error; ignored".to_owned();
    };
    let prefix = &source[..span.start.min(source.len())];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix.rsplit('\n').next().map_or(0, str::len) + 1;
    format!("config: TOML parse error at line {line}, column {column}; ignored")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palette::{Palette, PaletteSlot};
    use std::{
        collections::BTreeMap,
        ffi::{OsStr, OsString},
        io::ErrorKind,
        path::{Path, PathBuf},
    };

    #[derive(Default)]
    struct FakeIo {
        env: BTreeMap<&'static str, OsString>,
        metadata: BTreeMap<PathBuf, Result<FakeMetadata, ErrorKind>>,
        reads: BTreeMap<PathBuf, Result<Vec<u8>, ErrorKind>>,
    }

    #[derive(Clone, Copy)]
    struct FakeMetadata {
        is_file: bool,
        len: u64,
    }

    impl ConfigIo for FakeIo {
        fn var_os(&self, name: &'static str) -> Option<OsString> {
            self.env.get(name).cloned()
        }

        fn metadata(&self, path: &Path) -> std::io::Result<FileMetadata> {
            self.metadata
                .get(path)
                .cloned()
                .unwrap_or(Err(ErrorKind::NotFound))
                .map(|metadata| FileMetadata {
                    is_file: metadata.is_file,
                    len: metadata.len,
                })
                .map_err(std::io::Error::from)
        }

        fn read_bounded(&self, path: &Path) -> std::io::Result<Vec<u8>> {
            self.reads
                .get(path)
                .cloned()
                .unwrap_or(Err(ErrorKind::NotFound))
                .map_err(std::io::Error::from)
        }
    }

    impl FakeIo {
        fn with_file(mut self, path: impl Into<PathBuf>, contents: impl Into<Vec<u8>>) -> Self {
            let path = path.into();
            let bytes = contents.into();
            self.metadata.insert(
                path.clone(),
                Ok(FakeMetadata {
                    is_file: true,
                    len: bytes.len() as u64,
                }),
            );
            self.reads.insert(path, Ok(bytes));
            self
        }
    }

    fn load(tmux_theme: &str, io: FakeIo) -> LoadedUiConfig {
        load_ui_config_impl(tmux_theme, &io)
    }

    fn xdg_path(value: &OsStr) -> PathBuf {
        Path::new(value).join("tmux-pane-dash/config.toml")
    }

    fn home_path(value: &OsStr) -> PathBuf {
        Path::new(value).join(".config/tmux-pane-dash/config.toml")
    }

    #[test]
    fn xdg_nonempty_wins_and_does_not_fall_back_to_home() {
        let xdg = OsString::from("/xdg");
        let home = OsString::from("/home");
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", xdg.clone()), ("HOME", home.clone())]),
            ..FakeIo::default()
        }
        .with_file(home_path(&home), b"theme = 'light'".to_vec());

        let loaded = load("dark", io);
        assert_eq!(loaded.palette, Palette::dark());
        assert!(loaded.warning_texts().is_empty());
        let env = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", xdg), ("HOME", home)]),
            ..FakeIo::default()
        };
        assert_eq!(
            resolve_config_path(&env),
            Some(xdg_path(OsStr::new("/xdg")))
        );
    }

    #[test]
    fn empty_environment_values_are_skipped_and_missing_config_is_silent() {
        let io = FakeIo {
            env: BTreeMap::from([
                ("XDG_CONFIG_HOME", OsString::new()),
                ("HOME", OsString::new()),
            ]),
            ..FakeIo::default()
        };
        let loaded = load("dark", io);
        assert_eq!(loaded.palette, Palette::dark());
        assert!(loaded.warning_texts().is_empty());
    }

    #[test]
    fn empty_tmux_theme_warns_and_uses_dark() {
        let loaded = load("", FakeIo::default());
        assert_eq!(loaded.palette, Palette::dark());
        assert_eq!(
            loaded.warning_texts(),
            ["theme: unknown tmux theme ''; using dark"]
        );
    }

    #[test]
    fn file_fatal_errors_are_atomic_and_use_stable_messages() {
        let path = PathBuf::from("/xdg/tmux-pane-dash/config.toml");
        let mut io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..FakeIo::default()
        };
        io.metadata
            .insert(path.clone(), Err(ErrorKind::PermissionDenied));
        let loaded = load("light", io);
        assert_eq!(loaded.palette, Palette::light());
        assert_eq!(
            loaded.warning_texts(),
            [
                "config: cannot inspect '/xdg/tmux-pane-dash/config.toml' (PermissionDenied); ignored"
            ]
        );

        let directory = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            metadata: BTreeMap::from([(
                path,
                Ok(FakeMetadata {
                    is_file: false,
                    len: 0,
                }),
            )]),
            ..FakeIo::default()
        };
        assert_eq!(
            load("light", directory).warning_texts(),
            ["config: '/xdg/tmux-pane-dash/config.toml' is not a regular file; ignored"]
        );
    }

    #[test]
    fn bounded_read_rejects_metadata_or_growth_over_1024_bytes() {
        let path = PathBuf::from("/xdg/tmux-pane-dash/config.toml");
        let oversized = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            metadata: BTreeMap::from([(
                path.clone(),
                Ok(FakeMetadata {
                    is_file: true,
                    len: 1025,
                }),
            )]),
            ..FakeIo::default()
        };
        assert_eq!(
            load("dark", oversized).warning_texts(),
            ["config: '/xdg/tmux-pane-dash/config.toml' exceeds 1024 bytes; ignored"]
        );

        let growth = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            metadata: BTreeMap::from([(
                path.clone(),
                Ok(FakeMetadata {
                    is_file: true,
                    len: 1,
                }),
            )]),
            reads: BTreeMap::from([(path, Ok(vec![b'x'; 1025]))]),
        };
        assert_eq!(
            load("dark", growth).warning_texts(),
            ["config: '/xdg/tmux-pane-dash/config.toml' exceeds 1024 bytes; ignored"]
        );

        let exact =
            FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", vec![b'#'; 1024]);
        let exact = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..exact
        };
        assert!(load("dark", exact).warning_texts().is_empty());
    }

    #[test]
    fn valid_toml_replaces_base_then_applies_each_valid_override_independently() {
        let io = FakeIo::default().with_file(
            "/xdg/tmux-pane-dash/config.toml",
            b"theme = 'light'\naccent = '#005faf'\nworking = 'not-a-color'\nselection_bg = 'blue'"
                .to_vec(),
        );
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..io
        };
        let loaded = load("terminal-native", io);
        assert_eq!(
            loaded.palette.accent,
            crate::palette::parse_color("#005faf").unwrap()
        );
        assert_eq!(loaded.palette.working, Palette::light().working);
        assert_eq!(
            loaded.palette.selection_bg,
            crate::palette::parse_color("blue").unwrap()
        );
        assert_eq!(
            loaded.warning_texts(),
            ["config: invalid color 'not-a-color' for 'working'; keeping previous value"]
        );
    }

    #[test]
    fn invalid_file_shapes_types_utf8_and_parse_errors_report_only_first_fatal_error() {
        for (document, expected) in [
            (
                b"accent = [1]".as_slice(),
                "config: nested table or array at 'accent'; ignored",
            ),
            (
                b"theme = 1\naccent = 2".as_slice(),
                "config: 'theme' must be a string; ignored",
            ),
            (
                b"[nested]\nx = 1".as_slice(),
                "config: nested table or array at 'nested'; ignored",
            ),
        ] {
            let io =
                FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", document.to_vec());
            let io = FakeIo {
                env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
                ..io
            };
            assert_eq!(load("dark", io).warning_texts(), [expected]);
        }

        let invalid_utf8 =
            FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", vec![0xff]);
        let invalid_utf8 = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..invalid_utf8
        };
        assert_eq!(
            load("dark", invalid_utf8).warning_texts(),
            ["config: '/xdg/tmux-pane-dash/config.toml' is not valid UTF-8; ignored"]
        );

        let syntax =
            FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", b"theme =".to_vec());
        let syntax = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..syntax
        };
        assert_eq!(
            load("dark", syntax).warning_texts(),
            ["config: TOML parse error at line 1, column 8; ignored"]
        );
        assert_eq!(
            toml_parse_warning("", None),
            "config: TOML parse error; ignored"
        );
    }

    #[test]
    fn unknown_scalar_is_ignored_and_distance_one_typos_are_sorted_with_lexical_ties() {
        let io = FakeIo::default().with_file(
            "/xdg/tmux-pane-dash/config.toml",
            b"zz = 1\ntex = 'x'\ndmi = true\n".to_vec(),
        );
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..io
        };
        assert_eq!(
            load("dark", io).warning_texts(),
            [
                "config: unknown key 'dmi'; did you mean 'dim'?",
                "config: unknown key 'tex'; did you mean 'text'?",
            ]
        );
        assert!(optimal_damerau_levenshtein_distance_one("ab", "ba"));

        let tied = FakeIo::default().with_file(
            "/xdg/tmux-pane-dash/config.toml",
            b"selection_xg = 1".to_vec(),
        );
        let tied = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..tied
        };
        assert_eq!(
            load("dark", tied).warning_texts(),
            ["config: unknown key 'selection_xg'; did you mean 'selection_bg'?"]
        );
    }

    #[test]
    fn warnings_are_safely_escaped_deduplicated_and_capped() {
        let io = FakeIo::default().with_file(
            "/xdg/tmux-pane-dash/config.toml",
            b"theme = 'bad\\\\name'\naccent = 'bad'\nneeds_input = 'bad'\nworking = 'bad'\nidle = 'bad'".to_vec(),
        );
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..io
        };
        assert_eq!(
            load("bogus", io).warning_texts(),
            [
                "theme: unknown tmux theme 'bogus'; using dark",
                "config: unknown theme 'bad\\\\\\\\name'; keeping dark",
                "config: invalid color 'bad' for 'accent'; keeping previous value",
                "config: 3 additional warnings suppressed",
            ]
        );
    }

    #[test]
    fn safe_display_caps_escaped_control_values_at_48_scalars() {
        let displayed = safe_display(&"\u{7f}".repeat(48));
        assert!(displayed.chars().count() <= 48);
        assert!(displayed.ends_with('…'));
        assert!(!displayed.contains('\u{7f}'));
    }

    #[test]
    fn safe_display_keeps_an_exact_48_scalar_escaped_value_without_ellipsis() {
        let displayed = safe_display(&"\\".repeat(24));
        assert_eq!(displayed.chars().count(), 48);
        assert!(!displayed.ends_with('…'));
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_environment_path_is_preserved() {
        use std::os::unix::ffi::OsStringExt;
        let xdg = OsString::from_vec(vec![b'/', 0xff]);
        let path = xdg_path(&xdg);
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", xdg.clone())]),
            ..FakeIo::default()
        }
        .with_file(path.clone(), b"theme = 'light'\naccent = 'red'".to_vec());
        let loaded = load("dark", io);
        let mut expected = Palette::light();
        expected.accent = crate::palette::parse_color("red").unwrap();
        assert_eq!(loaded.palette, expected);
        assert_eq!(
            loaded.palette.accent,
            crate::palette::parse_color("red").unwrap()
        );
        assert!(loaded.warning_texts().is_empty());
        assert_eq!(path, xdg_path(&xdg));
    }

    #[test]
    fn fatal_files_ignore_valid_siblings_and_report_one_canonical_warning() {
        for (document, expected_prefix) in [
            (
                "theme = 'light'\naccent = 'red'\ntheme = 'dark'",
                "config: TOML parse error",
            ),
            (
                "theme = 'light'\naccent = 'red'\n[zz]\nx = 1\n[aa]\nx = 1",
                "config: nested table or array at 'aa'; ignored",
            ),
            (
                "theme = 'light'\naccent = 'red'\nzz = []\naa = []",
                "config: nested table or array at 'aa'; ignored",
            ),
            (
                "theme = 'light'\naccent = 'red'\nextra.value = 1",
                "config: nested table or array at 'extra'; ignored",
            ),
            (
                "theme = 'light'\naccent = 'red'\n[[zz]]\nx = 1",
                "config: nested table or array at 'zz'; ignored",
            ),
        ] {
            let io = FakeIo::default().with_file(
                "/xdg/tmux-pane-dash/config.toml",
                document.as_bytes().to_vec(),
            );
            let io = FakeIo {
                env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
                ..io
            };
            let loaded = load("terminal-native", io);
            assert_eq!(loaded.palette, Palette::terminal_native());
            assert_eq!(loaded.warning_texts().len(), 1);
            assert!(loaded.warning_texts()[0].starts_with(expected_prefix));
        }
    }

    #[test]
    fn read_errors_and_not_found_races_have_their_specified_effects() {
        let path = PathBuf::from("/xdg/tmux-pane-dash/config.toml");
        let base = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            metadata: BTreeMap::from([(
                path.clone(),
                Ok(FakeMetadata {
                    is_file: true,
                    len: 1,
                }),
            )]),
            ..FakeIo::default()
        };
        let denied = FakeIo {
            reads: BTreeMap::from([(path.clone(), Err(ErrorKind::PermissionDenied))]),
            ..base
        };
        assert_eq!(
            load("light", denied).warning_texts(),
            ["config: cannot read '/xdg/tmux-pane-dash/config.toml' (PermissionDenied); ignored"]
        );
        let race = FakeIo {
            reads: BTreeMap::from([(path, Err(ErrorKind::NotFound))]),
            ..FakeIo {
                env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
                metadata: BTreeMap::from([(
                    PathBuf::from("/xdg/tmux-pane-dash/config.toml"),
                    Ok(FakeMetadata {
                        is_file: true,
                        len: 1,
                    }),
                )]),
                ..FakeIo::default()
            }
        };
        let loaded = load("light", race);
        assert_eq!(loaded.palette, Palette::light());
        assert!(loaded.warning_texts().is_empty());
    }

    #[test]
    fn warning_deduplication_precedes_the_first_three_plus_summary_cap() {
        let loaded = finish(
            Palette::dark(),
            vec![
                "one".into(),
                "one".into(),
                "two".into(),
                "three".into(),
                "four".into(),
                "five".into(),
            ],
        );
        assert_eq!(
            loaded.warning_texts(),
            [
                "one",
                "two",
                "three",
                "config: 2 additional warnings suppressed"
            ]
        );
    }

    #[test]
    fn invalid_slot_warnings_follow_palette_slot_order_not_toml_source_order() {
        let body = PaletteSlot::ALL
            .into_iter()
            .rev()
            .map(|slot| format!("{} = 'invalid-{}'", slot.name(), slot.name()))
            .collect::<Vec<_>>()
            .join("\n");
        let io = FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", body.into_bytes());
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..io
        };
        let loaded = load("dark", io);
        assert_eq!(
            loaded.warning_texts()[0],
            "config: invalid color 'invalid-text' for 'text'; keeping previous value"
        );
        assert_eq!(
            loaded.warning_texts()[1],
            "config: invalid color 'invalid-dim' for 'dim'; keeping previous value"
        );
        assert_eq!(
            loaded.warning_texts()[2],
            "config: invalid color 'invalid-accent' for 'accent'; keeping previous value"
        );
        assert_eq!(
            loaded.warning_texts()[3],
            "config: 12 additional warnings suppressed"
        );
    }

    #[test]
    fn all_slots_are_accepted_in_declaration_order() {
        let body = PaletteSlot::ALL
            .into_iter()
            .map(|slot| format!("{} = 'red'", slot.name()))
            .collect::<Vec<_>>()
            .join("\n");
        let io = FakeIo::default().with_file("/xdg/tmux-pane-dash/config.toml", body.into_bytes());
        let io = FakeIo {
            env: BTreeMap::from([("XDG_CONFIG_HOME", OsString::from("/xdg"))]),
            ..io
        };
        let loaded = load("dark", io);
        for slot in PaletteSlot::ALL {
            assert_eq!(
                loaded.palette.get(slot),
                crate::palette::parse_color("red").unwrap()
            );
        }
    }
}
