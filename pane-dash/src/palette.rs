use ratatui::style::{Color, Modifier, Style};

pub const SLOT_NAMES: [&str; 15] = [
    "text",
    "dim",
    "accent",
    "needs_input",
    "working",
    "idle",
    "error",
    "unknown",
    "stale",
    "warning",
    "degrade",
    "border",
    "status_bar",
    "selection_fg",
    "selection_bg",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaletteSlot {
    Text,
    Dim,
    Accent,
    NeedsInput,
    Working,
    Idle,
    Error,
    Unknown,
    Stale,
    Warning,
    Degrade,
    Border,
    StatusBar,
    SelectionFg,
    SelectionBg,
}

impl PaletteSlot {
    pub const ALL: [Self; 15] = [
        Self::Text,
        Self::Dim,
        Self::Accent,
        Self::NeedsInput,
        Self::Working,
        Self::Idle,
        Self::Error,
        Self::Unknown,
        Self::Stale,
        Self::Warning,
        Self::Degrade,
        Self::Border,
        Self::StatusBar,
        Self::SelectionFg,
        Self::SelectionBg,
    ];

    pub const fn name(self) -> &'static str {
        SLOT_NAMES[self as usize]
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|slot| slot.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub text: Color,
    pub dim: Color,
    pub accent: Color,
    pub needs_input: Color,
    pub working: Color,
    pub idle: Color,
    pub error: Color,
    pub unknown: Color,
    pub stale: Color,
    pub warning: Color,
    pub degrade: Color,
    pub border: Color,
    pub status_bar: Color,
    pub selection_fg: Color,
    pub selection_bg: Color,
}

impl Palette {
    pub const fn dark() -> Self {
        Self {
            text: Color::Gray,
            dim: Color::DarkGray,
            accent: Color::Cyan,
            needs_input: Color::Red,
            working: Color::Yellow,
            idle: Color::Green,
            error: Color::Red,
            unknown: Color::DarkGray,
            stale: Color::DarkGray,
            warning: Color::Yellow,
            degrade: Color::Red,
            border: Color::DarkGray,
            status_bar: Color::DarkGray,
            selection_fg: Color::Black,
            selection_bg: Color::Cyan,
        }
    }

    pub const fn light() -> Self {
        Self {
            text: Color::Black,
            dim: Color::DarkGray,
            accent: Color::Blue,
            needs_input: Color::Red,
            working: Color::Magenta,
            idle: Color::Green,
            error: Color::Red,
            unknown: Color::DarkGray,
            stale: Color::DarkGray,
            warning: Color::Magenta,
            degrade: Color::Red,
            border: Color::DarkGray,
            status_bar: Color::DarkGray,
            selection_fg: Color::White,
            selection_bg: Color::Blue,
        }
    }

    pub const fn terminal_native() -> Self {
        Self {
            text: Color::Reset,
            dim: Color::DarkGray,
            accent: Color::Cyan,
            needs_input: Color::Red,
            working: Color::Yellow,
            idle: Color::Green,
            error: Color::LightRed,
            unknown: Color::Gray,
            stale: Color::DarkGray,
            warning: Color::Yellow,
            degrade: Color::LightRed,
            border: Color::DarkGray,
            status_bar: Color::DarkGray,
            selection_fg: Color::Reset,
            selection_bg: Color::Reset,
        }
    }

    pub fn builtin(name: &str) -> Option<Self> {
        match name {
            "dark" => Some(Self::dark()),
            "light" => Some(Self::light()),
            "terminal-native" => Some(Self::terminal_native()),
            _ => None,
        }
    }

    pub const fn get(self, slot: PaletteSlot) -> Color {
        match slot {
            PaletteSlot::Text => self.text,
            PaletteSlot::Dim => self.dim,
            PaletteSlot::Accent => self.accent,
            PaletteSlot::NeedsInput => self.needs_input,
            PaletteSlot::Working => self.working,
            PaletteSlot::Idle => self.idle,
            PaletteSlot::Error => self.error,
            PaletteSlot::Unknown => self.unknown,
            PaletteSlot::Stale => self.stale,
            PaletteSlot::Warning => self.warning,
            PaletteSlot::Degrade => self.degrade,
            PaletteSlot::Border => self.border,
            PaletteSlot::StatusBar => self.status_bar,
            PaletteSlot::SelectionFg => self.selection_fg,
            PaletteSlot::SelectionBg => self.selection_bg,
        }
    }

    pub fn apply(&mut self, slot: PaletteSlot, color: Color) {
        match slot {
            PaletteSlot::Text => self.text = color,
            PaletteSlot::Dim => self.dim = color,
            PaletteSlot::Accent => self.accent = color,
            PaletteSlot::NeedsInput => self.needs_input = color,
            PaletteSlot::Working => self.working = color,
            PaletteSlot::Idle => self.idle = color,
            PaletteSlot::Error => self.error = color,
            PaletteSlot::Unknown => self.unknown = color,
            PaletteSlot::Stale => self.stale = color,
            PaletteSlot::Warning => self.warning = color,
            PaletteSlot::Degrade => self.degrade = color,
            PaletteSlot::Border => self.border = color,
            PaletteSlot::StatusBar => self.status_bar = color,
            PaletteSlot::SelectionFg => self.selection_fg = color,
            PaletteSlot::SelectionBg => self.selection_bg = color,
        }
    }
}

pub fn parse_color(value: &str) -> Option<Color> {
    let named = match value {
        "reset" => Some(Color::Reset),
        "black" => Some(Color::Black),
        "red" => Some(Color::Red),
        "green" => Some(Color::Green),
        "yellow" => Some(Color::Yellow),
        "blue" => Some(Color::Blue),
        "magenta" => Some(Color::Magenta),
        "cyan" => Some(Color::Cyan),
        "gray" => Some(Color::Gray),
        "dark_gray" => Some(Color::DarkGray),
        "light_red" => Some(Color::LightRed),
        "light_green" => Some(Color::LightGreen),
        "light_yellow" => Some(Color::LightYellow),
        "light_blue" => Some(Color::LightBlue),
        "light_magenta" => Some(Color::LightMagenta),
        "light_cyan" => Some(Color::LightCyan),
        "white" => Some(Color::White),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Some(Color::Rgb(
            u8::from_str_radix(&value[1..3], 16).ok()?,
            u8::from_str_radix(&value[3..5], 16).ok()?,
            u8::from_str_radix(&value[5..7], 16).ok()?,
        ));
    }
    let index = value.strip_prefix("ansi:")?;
    if !(1..=3).contains(&index.len()) || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    index.parse().ok().map(Color::Indexed)
}

pub fn selection_style(palette: Palette) -> Style {
    if palette.selection_fg == Color::Reset && palette.selection_bg == Color::Reset {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
            .fg(palette.selection_fg)
            .bg(palette.selection_bg)
    }
}

#[cfg(test)]
mod tests {
    use ratatui::style::{Color, Modifier, Style};

    use super::{Palette, PaletteSlot, SLOT_NAMES, parse_color, selection_style};

    #[test]
    fn builtins_have_the_exact_documented_slot_values() {
        let expected = [
            (
                "dark",
                [
                    Color::Gray,
                    Color::DarkGray,
                    Color::Cyan,
                    Color::Red,
                    Color::Yellow,
                    Color::Green,
                    Color::Red,
                    Color::DarkGray,
                    Color::DarkGray,
                    Color::Yellow,
                    Color::Red,
                    Color::DarkGray,
                    Color::DarkGray,
                    Color::Black,
                    Color::Cyan,
                ],
            ),
            (
                "light",
                [
                    Color::Black,
                    Color::DarkGray,
                    Color::Blue,
                    Color::Red,
                    Color::Magenta,
                    Color::Green,
                    Color::Red,
                    Color::DarkGray,
                    Color::DarkGray,
                    Color::Magenta,
                    Color::Red,
                    Color::DarkGray,
                    Color::DarkGray,
                    Color::White,
                    Color::Blue,
                ],
            ),
            (
                "terminal-native",
                [
                    Color::Reset,
                    Color::DarkGray,
                    Color::Cyan,
                    Color::Red,
                    Color::Yellow,
                    Color::Green,
                    Color::LightRed,
                    Color::Gray,
                    Color::DarkGray,
                    Color::Yellow,
                    Color::LightRed,
                    Color::DarkGray,
                    Color::DarkGray,
                    Color::Reset,
                    Color::Reset,
                ],
            ),
        ];

        for (name, values) in expected {
            let palette = Palette::builtin(name).unwrap();
            for (slot, color) in PaletteSlot::ALL.into_iter().zip(values) {
                assert_eq!(palette.get(slot), color, "{name}: {}", slot.name());
            }
        }
    }

    #[test]
    fn builtin_names_are_exact_and_case_sensitive() {
        for name in ["", "Dark", "dark ", " dark", "native", "terminal_native"] {
            assert_eq!(Palette::builtin(name), None, "{name:?}");
        }
    }

    #[test]
    fn slot_names_and_typed_slots_follow_the_documented_order() {
        assert_eq!(
            SLOT_NAMES,
            [
                "text",
                "dim",
                "accent",
                "needs_input",
                "working",
                "idle",
                "error",
                "unknown",
                "stale",
                "warning",
                "degrade",
                "border",
                "status_bar",
                "selection_fg",
                "selection_bg",
            ]
        );
        assert_eq!(PaletteSlot::ALL.map(PaletteSlot::name), SLOT_NAMES);
        for slot in PaletteSlot::ALL {
            assert_eq!(PaletteSlot::from_name(slot.name()), Some(slot));
        }
        assert_eq!(PaletteSlot::from_name("Text"), None);
    }

    #[test]
    fn every_typed_slot_override_changes_only_its_slot() {
        let base = Palette::dark();
        for slot in PaletteSlot::ALL {
            let mut palette = base;
            palette.apply(slot, Color::White);
            for other in PaletteSlot::ALL {
                let expected = if other == slot {
                    Color::White
                } else {
                    base.get(other)
                };
                assert_eq!(palette.get(other), expected, "{}", slot.name());
            }
        }
    }

    #[test]
    fn parser_accepts_only_canonical_names_hex_and_ansi_indexes() {
        let names = [
            ("reset", Color::Reset),
            ("black", Color::Black),
            ("red", Color::Red),
            ("green", Color::Green),
            ("yellow", Color::Yellow),
            ("blue", Color::Blue),
            ("magenta", Color::Magenta),
            ("cyan", Color::Cyan),
            ("gray", Color::Gray),
            ("dark_gray", Color::DarkGray),
            ("light_red", Color::LightRed),
            ("light_green", Color::LightGreen),
            ("light_yellow", Color::LightYellow),
            ("light_blue", Color::LightBlue),
            ("light_magenta", Color::LightMagenta),
            ("light_cyan", Color::LightCyan),
            ("white", Color::White),
        ];
        for (input, color) in names {
            assert_eq!(parse_color(input), Some(color), "{input}");
        }
        assert_eq!(parse_color("#00aF7c"), Some(Color::Rgb(0, 0xaf, 0x7c)));
        assert_eq!(parse_color("#ABCDEF"), Some(Color::Rgb(0xab, 0xcd, 0xef)));
        assert_eq!(parse_color("ansi:0"), Some(Color::Indexed(0)));
        assert_eq!(parse_color("ansi:255"), Some(Color::Indexed(255)));
        assert_eq!(parse_color("ansi:007"), Some(Color::Indexed(7)));
    }

    #[test]
    fn parser_rejects_every_noncanonical_form() {
        for input in [
            "",
            " white",
            "white ",
            "White",
            "RESET",
            "grey",
            "silver",
            "bright-red",
            "dark-gray",
            "1",
            "#fff",
            "#ffffffff",
            "#12xz56",
            "00aF7c",
            "rgb(0,0,0)",
            "ansi:",
            "ansi:-1",
            "ansi:+1",
            "ansi:256",
            "ansi:0000",
            "ansi:1x",
            "ANSI:1",
            "ansi :1",
        ] {
            assert_eq!(parse_color(input), None, "{input}");
        }
    }

    #[test]
    fn selection_is_reverse_only_when_both_final_slots_are_reset() {
        let palette = Palette::builtin("terminal-native").unwrap();
        assert_eq!(
            selection_style(palette),
            Style::default().add_modifier(Modifier::REVERSED)
        );
    }

    #[test]
    fn selection_explicitly_sets_both_colors_after_either_override() {
        let mut palette = Palette::builtin("terminal-native").unwrap();
        palette.apply(PaletteSlot::SelectionFg, Color::White);
        assert_eq!(
            selection_style(palette),
            Style::default().fg(Color::White).bg(Color::Reset)
        );

        let mut palette = Palette::builtin("terminal-native").unwrap();
        palette.apply(PaletteSlot::SelectionBg, Color::Blue);
        assert_eq!(
            selection_style(palette),
            Style::default().fg(Color::Reset).bg(Color::Blue)
        );

        let mut palette = Palette::builtin("terminal-native").unwrap();
        palette.apply(PaletteSlot::SelectionFg, Color::White);
        palette.apply(PaletteSlot::SelectionBg, Color::Blue);
        assert_eq!(
            selection_style(palette),
            Style::default().fg(Color::White).bg(Color::Blue)
        );
    }

    #[test]
    fn explicit_selection_style_patches_over_semantic_span_colors() {
        let palette = Palette::dark();
        let semantic = Style::default().fg(Color::Red).bg(Color::Green);
        assert_eq!(
            semantic.patch(selection_style(palette)),
            Style::default().fg(Color::Black).bg(Color::Cyan)
        );
    }
}
