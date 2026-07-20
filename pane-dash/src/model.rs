#[cfg(test)]
mod tests {
    use super::{Model, ModelConfig, Row, Status};
    use crate::snapshot::RawRecord;

    fn record() -> RawRecord {
        RawRecord {
            session_id: "$1".into(),
            session_name: "alpha".into(),
            window_id: "@1".into(),
            window_index: 0,
            window_name: "main".into(),
            pane_id: "%1".into(),
            pane_index: 0,
            pane_active: true,
            pane_current_command: "shell".into(),
            pane_current_path: "/tmp".into(),
            pane_dead: false,
            status: String::new(),
            status_since: None,
            heartbeat: None,
            title: String::new(),
            model: String::new(),
            tag: String::new(),
            group: String::new(),
        }
    }

    fn model(records: &[RawRecord]) -> Model {
        Model::build(records, &ModelConfig::default(), 1_000)
    }

    #[test]
    fn discovers_status_command_or_tagged_records_only() {
        let mut status_only = record();
        status_only.status = "idle".into();
        let mut command_only = record();
        command_only.pane_id = "%2".into();
        command_only.pane_current_command = "opencode".into();
        let mut tag_only = record();
        tag_only.pane_id = "%3".into();
        tag_only.tag = "keep".into();
        let none = record();

        let built = model(&[status_only, command_only, tag_only, none]);

        assert_eq!(built.memberships.len(), 3);
        assert!(built.panes.contains_key(&"%1".into()));
        assert!(built.panes.contains_key(&"%2".into()));
        assert!(built.panes.contains_key(&"%3".into()));
    }

    #[test]
    fn preserves_linked_pane_memberships_and_last_canonical_facts() {
        let mut first = record();
        first.status = "working".into();
        let mut linked = first.clone();
        linked.session_id = "$2".into();
        linked.session_name = "beta".into();
        linked.window_id = "@2".into();
        linked.window_index = 4;
        linked.title = "newest".into();

        let built = model(&[first, linked]);

        assert_eq!(built.panes.len(), 1);
        assert_eq!(built.memberships.len(), 2);
        assert_eq!(built.panes[&"%1".into()].title, "newest");
    }

    #[test]
    fn produces_grouped_session_rows_in_name_and_pane_order() {
        let mut beta = record();
        beta.session_name = "beta".into();
        beta.session_id = "$2".into();
        beta.status = "working".into();
        beta.window_index = 2;
        let mut alpha_later = beta.clone();
        alpha_later.session_name = "alpha".into();
        alpha_later.session_id = "$1".into();
        alpha_later.pane_id = "%2".into();
        alpha_later.window_index = 1;
        alpha_later.pane_index = 1;
        let mut alpha_first = alpha_later.clone();
        alpha_first.pane_id = "%3".into();
        alpha_first.pane_index = 0;

        let rows = model(&[beta, alpha_later, alpha_first]).rows(true);
        assert!(
            matches!(&rows[0], Row::SessionHeader { name, pane_count: 2, working_count: 2, .. } if name == "alpha")
        );
        assert!(matches!(&rows[1], Row::Pane { pane_id, .. } if pane_id.0 == "%3"));
        assert!(matches!(&rows[2], Row::Pane { pane_id, .. } if pane_id.0 == "%2"));
        assert!(matches!(&rows[3], Row::SessionHeader { name, .. } if name == "beta"));
    }

    #[test]
    fn derives_status_and_staleness_at_the_strict_boundary() {
        let mut threshold = record();
        threshold.status = "working".into();
        threshold.heartbeat = Some(940);
        let mut stale = threshold.clone();
        stale.pane_id = "%2".into();
        stale.heartbeat = Some(939);
        let mut garbage = threshold.clone();
        garbage.pane_id = "%3".into();
        garbage.status = "unrecognized".into();
        let mut command = threshold.clone();
        command.pane_id = "%4".into();
        command.status.clear();
        command.heartbeat = None;
        command.pane_current_command = "opencode".into();

        let built = model(&[threshold, stale, garbage, command]);
        assert_eq!(built.panes[&"%1".into()].status, Status::Working);
        assert_eq!(built.panes[&"%2".into()].status, Status::Stale);
        assert_eq!(built.panes[&"%3".into()].status, Status::Unknown);
        assert_eq!(built.panes[&"%4".into()].status, Status::Unknown);
    }

    #[test]
    fn derives_grouping_from_snapshot_option() {
        for (value, expected) in [("", true), ("0", false), ("1", true), ("other", true)] {
            let mut item = record();
            item.status = "idle".into();
            item.group = value.into();
            assert_eq!(model(&[item]).grouped, expected, "{value:?}");
        }
    }

    #[test]
    fn flat_rows_follow_status_priority_and_documented_ties() {
        let mut needs_old = record();
        needs_old.status = "needs_input".into();
        needs_old.status_since = Some(10);
        let mut needs_new = needs_old.clone();
        needs_new.pane_id = "%2".into();
        needs_new.status_since = Some(20);
        let mut error = needs_old.clone();
        error.pane_id = "%3".into();
        error.status = "error".into();
        let mut working = error.clone();
        working.pane_id = "%4".into();
        working.status = "working".into();
        let mut stale = error.clone();
        stale.pane_id = "%5".into();
        stale.status = "idle".into();
        stale.heartbeat = Some(1);
        let mut idle = error.clone();
        idle.pane_id = "%6".into();
        idle.status = "idle".into();
        let mut unknown = error.clone();
        unknown.pane_id = "%7".into();
        unknown.status = "garbage".into();

        let ids: Vec<_> = model(&[unknown, idle, stale, working, error, needs_new, needs_old])
            .rows(false)
            .into_iter()
            .map(|row| match row {
                Row::Pane { pane_id, .. } => pane_id.0,
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(ids, ["%1", "%2", "%3", "%4", "%5", "%6", "%7"]);
    }

    #[test]
    fn content_hash_is_stable_and_reflects_status_changes() {
        let mut item = record();
        item.status = "idle".into();
        let same = model(&[item.clone()]);
        let identical = model(&[item.clone()]);
        let mut changed = item;
        changed.status = "working".into();

        assert_eq!(same.content_hash, identical.content_hash);
        assert_ne!(same.content_hash, model(&[changed]).content_hash);
    }
}
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::snapshot::RawRecord;

macro_rules! id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub String);

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }
    };
}

id!(SessionId);
id!(WindowId);
id!(PaneId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Status {
    Working,
    NeedsInput,
    Idle,
    Error,
    Unknown,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pane {
    pub command: String,
    pub path: String,
    pub dead: bool,
    pub title: String,
    pub model: String,
    pub tag: String,
    pub status: Status,
    pub status_since: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub name: String,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Membership {
    pub session_id: SessionId,
    pub window_id: WindowId,
    pub pane_id: PaneId,
    pub window_index: u32,
    pub pane_index: u32,
    pub pane_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelConfig {
    pub match_pattern: String,
    pub stale_secs: u64,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            match_pattern: "opencode".to_owned(),
            stale_secs: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub panes: HashMap<PaneId, Pane>,
    pub sessions: HashMap<SessionId, Session>,
    pub windows: HashMap<WindowId, Window>,
    pub memberships: Vec<Membership>,
    pub grouped: bool,
    pub content_hash: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    SessionHeader {
        session_id: SessionId,
        name: String,
        pane_count: usize,
        working_count: usize,
        collapsed: bool,
    },
    Pane {
        session_id: SessionId,
        window_id: WindowId,
        pane_id: PaneId,
        window_index: u32,
        pane_index: u32,
        pane_active: bool,
        command: String,
        path: String,
        dead: bool,
        title: String,
        model: String,
        tag: String,
        status: Status,
        status_since: Option<u64>,
    },
}

impl Model {
    pub fn build(records: &[RawRecord], cfg: &ModelConfig, now: u64) -> Self {
        let grouped = !records.iter().any(|record| record.group == "0");
        let mut panes = HashMap::new();
        let mut sessions = HashMap::new();
        let mut windows = HashMap::new();
        let mut memberships = Vec::new();

        for record in records.iter().filter(|record| is_discovered(record, cfg)) {
            let session_id = SessionId(record.session_id.clone());
            let window_id = WindowId(record.window_id.clone());
            let pane_id = PaneId(record.pane_id.clone());
            let status = derive_status(record, cfg.stale_secs, now);

            sessions.insert(
                session_id.clone(),
                Session {
                    name: record.session_name.clone(),
                },
            );
            windows.insert(
                window_id.clone(),
                Window {
                    name: record.window_name.clone(),
                    index: record.window_index,
                },
            );
            panes.insert(
                pane_id.clone(),
                Pane {
                    command: record.pane_current_command.clone(),
                    path: record.pane_current_path.clone(),
                    dead: record.pane_dead,
                    title: record.title.clone(),
                    model: record.model.clone(),
                    tag: record.tag.clone(),
                    status,
                    status_since: record.status_since,
                },
            );
            memberships.push(Membership {
                session_id,
                window_id,
                pane_id,
                window_index: record.window_index,
                pane_index: record.pane_index,
                pane_active: record.pane_active,
            });
        }

        let content_hash = hash_content(&memberships, &panes, &sessions, &windows, grouped);
        Self {
            panes,
            sessions,
            windows,
            memberships,
            grouped,
            content_hash,
        }
    }

    pub fn rows(&self, grouped: bool) -> Vec<Row> {
        if grouped {
            self.grouped_rows()
        } else {
            self.flat_rows()
        }
    }

    fn grouped_rows(&self) -> Vec<Row> {
        let mut sessions: Vec<_> = self.sessions.iter().collect();
        sessions.sort_by(|(left_id, left), (right_id, right)| {
            left.name
                .cmp(&right.name)
                .then_with(|| left_id.cmp(right_id))
        });

        let mut rows = Vec::new();
        for (session_id, session) in sessions {
            let mut memberships: Vec<_> = self
                .memberships
                .iter()
                .filter(|membership| membership.session_id == *session_id)
                .collect();
            memberships.sort_by_key(|membership| (membership.window_index, membership.pane_index));
            let working_count = memberships
                .iter()
                .filter(|membership| self.panes[&membership.pane_id].status == Status::Working)
                .count();
            rows.push(Row::SessionHeader {
                session_id: session_id.clone(),
                name: session.name.clone(),
                pane_count: memberships.len(),
                working_count,
                collapsed: false,
            });
            rows.extend(
                memberships
                    .into_iter()
                    .map(|membership| self.pane_row(membership)),
            );
        }
        rows
    }

    fn flat_rows(&self) -> Vec<Row> {
        let mut memberships: Vec<_> = self.memberships.iter().collect();
        memberships.sort_by(|left, right| self.flat_order(left, right));
        memberships
            .into_iter()
            .map(|membership| self.pane_row(membership))
            .collect()
    }

    fn flat_order(&self, left: &Membership, right: &Membership) -> std::cmp::Ordering {
        let left_pane = &self.panes[&left.pane_id];
        let right_pane = &self.panes[&right.pane_id];
        let status_order =
            status_priority(left_pane.status).cmp(&status_priority(right_pane.status));
        if status_order != std::cmp::Ordering::Equal {
            return status_order;
        }

        // v1 treats needs-input age as urgency: older requests sort first.
        // Other equal-status rows retain deterministic topology order rather
        // than pretending absent status timestamps carry an age ordering.
        if left_pane.status == Status::NeedsInput {
            return left_pane
                .status_since
                .cmp(&right_pane.status_since)
                .then_with(|| topology_order(left, right));
        }
        topology_order(left, right)
    }

    fn pane_row(&self, membership: &Membership) -> Row {
        let pane = &self.panes[&membership.pane_id];
        Row::Pane {
            session_id: membership.session_id.clone(),
            window_id: membership.window_id.clone(),
            pane_id: membership.pane_id.clone(),
            window_index: membership.window_index,
            pane_index: membership.pane_index,
            pane_active: membership.pane_active,
            command: pane.command.clone(),
            path: pane.path.clone(),
            dead: pane.dead,
            title: pane.title.clone(),
            model: pane.model.clone(),
            tag: pane.tag.clone(),
            status: pane.status,
            status_since: pane.status_since,
        }
    }
}

fn is_discovered(record: &RawRecord, cfg: &ModelConfig) -> bool {
    !record.status.is_empty()
        || record.pane_current_command.contains(&cfg.match_pattern)
        || !record.tag.is_empty()
}

fn derive_status(record: &RawRecord, stale_secs: u64, now: u64) -> Status {
    let status = match record.status.as_str() {
        "working" => Status::Working,
        "needs_input" => Status::NeedsInput,
        "idle" => Status::Idle,
        "error" => Status::Error,
        "unknown" => Status::Unknown,
        _ => Status::Unknown,
    };
    if record
        .heartbeat
        .is_some_and(|heartbeat| now.saturating_sub(heartbeat) > stale_secs)
    {
        Status::Stale
    } else {
        status
    }
}

fn status_priority(status: Status) -> u8 {
    match status {
        Status::NeedsInput => 0,
        Status::Error => 1,
        Status::Working => 2,
        Status::Stale => 3,
        Status::Idle => 4,
        Status::Unknown => 5,
    }
}

fn topology_order(left: &Membership, right: &Membership) -> std::cmp::Ordering {
    left.session_id
        .cmp(&right.session_id)
        .then_with(|| left.window_index.cmp(&right.window_index))
        .then_with(|| left.pane_index.cmp(&right.pane_index))
        .then_with(|| left.window_id.cmp(&right.window_id))
        .then_with(|| left.pane_id.cmp(&right.pane_id))
}

fn hash_content(
    memberships: &[Membership],
    panes: &HashMap<PaneId, Pane>,
    sessions: &HashMap<SessionId, Session>,
    windows: &HashMap<WindowId, Window>,
    grouped: bool,
) -> u64 {
    let mut entries: Vec<_> = memberships
        .iter()
        .map(|membership| {
            let pane = &panes[&membership.pane_id];
            (
                membership,
                pane.status,
                pane.status_since,
                &pane.command,
                &pane.path,
                pane.dead,
                &pane.title,
                &pane.model,
                &pane.tag,
            )
        })
        .collect();
    entries.sort_by(|left, right| left.0.cmp(right.0));

    let mut hasher = DefaultHasher::new();
    grouped.hash(&mut hasher);
    let mut session_entries: Vec<_> = sessions.iter().collect();
    session_entries.sort_by(|left, right| left.0.cmp(right.0));
    for (id, session) in session_entries {
        id.hash(&mut hasher);
        session.name.hash(&mut hasher);
    }
    let mut window_entries: Vec<_> = windows.iter().collect();
    window_entries.sort_by(|left, right| left.0.cmp(right.0));
    for (id, window) in window_entries {
        id.hash(&mut hasher);
        window.name.hash(&mut hasher);
        window.index.hash(&mut hasher);
    }
    for entry in entries {
        entry.hash(&mut hasher);
    }
    hasher.finish()
}
