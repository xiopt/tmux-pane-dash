use std::path::PathBuf;

use tokio::sync::mpsc;

use crate::control::{ControlEvent, ControlHandle, connect_control};

#[derive(Debug)]
pub enum ConnectionMessage {
    Connected {
        generation: u64,
        handle: ControlHandle,
    },
    Failed {
        generation: u64,
        error: String,
    },
    Event {
        generation: u64,
        event: ControlEvent,
    },
}

pub fn spawn_connection_attempt(
    tmux_bin: PathBuf,
    session_id: String,
    generation: u64,
    tx: mpsc::UnboundedSender<ConnectionMessage>,
) {
    tokio::spawn(async move {
        match connect_control(tmux_bin, &session_id).await {
            Ok((handle, mut events)) => {
                if tx
                    .send(ConnectionMessage::Connected { handle, generation })
                    .is_err()
                {
                    return;
                }
                tokio::spawn(async move {
                    while let Some(event) = events.recv().await {
                        if tx
                            .send(ConnectionMessage::Event { generation, event })
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
            Err(error) => {
                let _ = tx.send(ConnectionMessage::Failed {
                    generation,
                    error: error.to_string(),
                });
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportMode {
    Connecting,
    Healthy,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportInput {
    FallbackTick,
    RefreshNow,
    TopologyChanged,
    DebounceElapsed,
    Connected,
    ConnectionFailed,
    ChannelEnded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportDirective {
    Connect,
    ChannelSnapshot,
    OneShotSnapshot,
    StartDebounce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotCompletion {
    Valid,
    Failed,
    MalformedPayload,
}

#[derive(Debug)]
pub struct TransportCoordinator {
    mode: TransportMode,
    connection_attempts: u8,
    reconnect_consumed: bool,
    snapshot_in_flight: bool,
    follow_up_snapshot: bool,
    debounce_armed: bool,
    malformed_streak: u8,
}

impl TransportCoordinator {
    pub fn new() -> (Self, Vec<TransportDirective>) {
        (
            Self {
                mode: TransportMode::Connecting,
                connection_attempts: 1,
                reconnect_consumed: false,
                snapshot_in_flight: false,
                follow_up_snapshot: false,
                debounce_armed: false,
                malformed_streak: 0,
            },
            vec![TransportDirective::Connect],
        )
    }

    pub fn input(&mut self, input: TransportInput) -> Vec<TransportDirective> {
        match input {
            TransportInput::FallbackTick | TransportInput::RefreshNow => self.request_snapshot(),
            TransportInput::TopologyChanged => {
                if self.mode == TransportMode::Healthy && !self.debounce_armed {
                    self.debounce_armed = true;
                    vec![TransportDirective::StartDebounce]
                } else {
                    Vec::new()
                }
            }
            TransportInput::DebounceElapsed => {
                if self.mode == TransportMode::Healthy && self.debounce_armed {
                    self.debounce_armed = false;
                    self.request_snapshot()
                } else {
                    Vec::new()
                }
            }
            TransportInput::Connected => {
                if self.mode == TransportMode::Connecting {
                    self.mode = TransportMode::Healthy;
                    self.connection_attempts = 0;
                }
                Vec::new()
            }
            TransportInput::ConnectionFailed => {
                if self.mode != TransportMode::Connecting {
                    return Vec::new();
                }
                self.connection_failed()
            }
            TransportInput::ChannelEnded => {
                if self.mode != TransportMode::Healthy {
                    return Vec::new();
                }
                self.clear_transient_state();
                self.start_reconnect_or_degrade()
            }
        }
    }

    pub fn snapshot_completed(
        &mut self,
        completion: SnapshotCompletion,
    ) -> Vec<TransportDirective> {
        if !self.snapshot_in_flight {
            return Vec::new();
        }

        self.snapshot_in_flight = false;
        let immediate_retry = match completion {
            SnapshotCompletion::Valid => {
                self.malformed_streak = 0;
                false
            }
            SnapshotCompletion::Failed => false,
            SnapshotCompletion::MalformedPayload => {
                let first_malformed = self.malformed_streak == 0;
                self.malformed_streak = self.malformed_streak.saturating_add(1);
                self.mode == TransportMode::Healthy && first_malformed
            }
        };

        let follow_up = self.follow_up_snapshot || immediate_retry;
        self.follow_up_snapshot = false;
        if follow_up {
            self.request_snapshot()
        } else {
            Vec::new()
        }
    }

    pub fn mode(&self) -> TransportMode {
        self.mode
    }

    fn connection_failed(&mut self) -> Vec<TransportDirective> {
        if self.reconnect_consumed {
            self.mode = TransportMode::Degraded;
            Vec::new()
        } else if self.connection_attempts < 2 {
            self.connection_attempts = self.connection_attempts.saturating_add(1);
            vec![TransportDirective::Connect]
        } else {
            self.mode = TransportMode::Degraded;
            Vec::new()
        }
    }

    fn start_reconnect_or_degrade(&mut self) -> Vec<TransportDirective> {
        if self.reconnect_consumed {
            self.mode = TransportMode::Degraded;
            Vec::new()
        } else {
            self.reconnect_consumed = true;
            self.mode = TransportMode::Connecting;
            vec![TransportDirective::Connect]
        }
    }

    fn clear_transient_state(&mut self) {
        self.snapshot_in_flight = false;
        self.follow_up_snapshot = false;
        self.debounce_armed = false;
        self.malformed_streak = 0;
    }

    fn request_snapshot(&mut self) -> Vec<TransportDirective> {
        if self.snapshot_in_flight {
            self.follow_up_snapshot = true;
            return Vec::new();
        }

        self.snapshot_in_flight = true;
        vec![match self.mode {
            TransportMode::Healthy => TransportDirective::ChannelSnapshot,
            TransportMode::Connecting | TransportMode::Degraded => {
                TransportDirective::OneShotSnapshot
            }
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod connection_tests {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;
        use tokio::sync::mpsc;
        use tokio::time::{Duration, timeout};

        use super::super::{ConnectionMessage, spawn_connection_attempt};
        use crate::control::ControlEvent;

        fn fake_tmux(dir: &TempDir, body: &str) -> std::path::PathBuf {
            let path = dir.path().join("fake-tmux");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).unwrap();
            path
        }

        #[tokio::test]
        async fn success_hands_off_connected_before_an_immediate_eof_event() {
            let dir = TempDir::new().unwrap();
            let fake = fake_tmux(
                &dir,
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nsleep 0.05",
            );
            let (tx, mut rx) = mpsc::unbounded_channel();

            spawn_connection_attempt(fake, "$7".into(), 4, tx);

            let Some(ConnectionMessage::Connected {
                generation: 4,
                handle: _handle,
            }) = timeout(Duration::from_secs(1), rx.recv()).await.unwrap()
            else {
                panic!("expected generation 4 connection handoff");
            };
            assert!(matches!(
                timeout(Duration::from_secs(1), rx.recv()).await.unwrap(),
                Some(ConnectionMessage::Event {
                    generation: 4,
                    event: ControlEvent::Terminated(_),
                })
            ));
        }

        #[tokio::test]
        async fn failed_handshake_hands_off_the_attempt_generation() {
            let dir = TempDir::new().unwrap();
            let fake = fake_tmux(&dir, "printf '%s\\n' '%begin 1 1 1' '%error 1 1 1'");
            let (tx, mut rx) = mpsc::unbounded_channel();

            spawn_connection_attempt(fake, "$7".into(), 8, tx);

            assert!(matches!(
                timeout(Duration::from_secs(1), rx.recv()).await.unwrap(),
                Some(ConnectionMessage::Failed { generation: 8, .. })
            ));
        }

        #[tokio::test]
        async fn late_events_keep_the_generation_of_the_connection_that_emitted_them() {
            let dir = TempDir::new().unwrap();
            let fake = fake_tmux(
                &dir,
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nsleep 0.05",
            );
            let (tx, mut rx) = mpsc::unbounded_channel();

            spawn_connection_attempt(fake, "$7".into(), 3, tx);
            let Some(ConnectionMessage::Connected {
                handle: _handle, ..
            }) = rx.recv().await
            else {
                panic!("expected connection handoff");
            };

            assert!(matches!(
                timeout(Duration::from_secs(1), rx.recv()).await.unwrap(),
                Some(ConnectionMessage::Event {
                    generation: 3,
                    event: ControlEvent::Terminated(_),
                })
            ));
        }
    }

    fn directives(
        coordinator: &mut TransportCoordinator,
        input: TransportInput,
    ) -> Vec<TransportDirective> {
        coordinator.input(input)
    }

    fn complete(
        coordinator: &mut TransportCoordinator,
        completion: SnapshotCompletion,
    ) -> Vec<TransportDirective> {
        coordinator.snapshot_completed(completion)
    }

    #[test]
    fn starts_connecting_with_one_connect_directive() {
        let (coordinator, directives) = TransportCoordinator::new();

        assert_eq!(coordinator.mode(), TransportMode::Connecting);
        assert_eq!(directives, vec![TransportDirective::Connect]);
    }

    #[test]
    fn initial_connection_failure_gets_one_final_attempt_then_degrades() {
        let (mut coordinator, _) = TransportCoordinator::new();

        assert_eq!(
            directives(&mut coordinator, TransportInput::ConnectionFailed),
            vec![TransportDirective::Connect]
        );
        assert_eq!(coordinator.mode(), TransportMode::Connecting);
        assert!(directives(&mut coordinator, TransportInput::ConnectionFailed).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
    }

    #[test]
    fn successful_startup_retry_preserves_the_post_healthy_reconnect_allowance() {
        let (mut reconnect_fails, _) = TransportCoordinator::new();
        assert_eq!(
            directives(&mut reconnect_fails, TransportInput::ConnectionFailed),
            vec![TransportDirective::Connect]
        );
        directives(&mut reconnect_fails, TransportInput::Connected);
        assert_eq!(
            directives(&mut reconnect_fails, TransportInput::ChannelEnded),
            vec![TransportDirective::Connect]
        );
        assert!(directives(&mut reconnect_fails, TransportInput::ConnectionFailed).is_empty());
        assert_eq!(reconnect_fails.mode(), TransportMode::Degraded);

        let (mut reconnect_succeeds, _) = TransportCoordinator::new();
        assert_eq!(
            directives(&mut reconnect_succeeds, TransportInput::ConnectionFailed),
            vec![TransportDirective::Connect]
        );
        directives(&mut reconnect_succeeds, TransportInput::Connected);
        assert_eq!(
            directives(&mut reconnect_succeeds, TransportInput::ChannelEnded),
            vec![TransportDirective::Connect]
        );
        directives(&mut reconnect_succeeds, TransportInput::Connected);
        assert!(directives(&mut reconnect_succeeds, TransportInput::ChannelEnded).is_empty());
        assert_eq!(reconnect_succeeds.mode(), TransportMode::Degraded);

        let (mut startup_fails_twice, _) = TransportCoordinator::new();
        assert_eq!(
            directives(&mut startup_fails_twice, TransportInput::ConnectionFailed),
            vec![TransportDirective::Connect]
        );
        assert!(directives(&mut startup_fails_twice, TransportInput::ConnectionFailed).is_empty());
        assert_eq!(startup_fails_twice.mode(), TransportMode::Degraded);
    }

    #[test]
    fn initial_success_can_reconnect_once_then_second_eof_degrades() {
        let (mut coordinator, _) = TransportCoordinator::new();

        assert!(directives(&mut coordinator, TransportInput::Connected).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Healthy);
        assert_eq!(
            directives(&mut coordinator, TransportInput::ChannelEnded),
            vec![TransportDirective::Connect]
        );
        assert_eq!(coordinator.mode(), TransportMode::Connecting);
        assert!(directives(&mut coordinator, TransportInput::Connected).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Healthy);
        assert!(directives(&mut coordinator, TransportInput::ChannelEnded).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
    }

    #[test]
    fn reconnect_failure_after_a_successful_initial_connection_degrades() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::ChannelEnded);

        assert!(directives(&mut coordinator, TransportInput::ConnectionFailed).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
        assert!(directives(&mut coordinator, TransportInput::Connected).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
    }

    #[test]
    fn degraded_state_ignores_late_connected_events() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::ConnectionFailed);
        directives(&mut coordinator, TransportInput::ConnectionFailed);

        assert!(directives(&mut coordinator, TransportInput::Connected).is_empty());
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
    }

    #[test]
    fn fallback_and_manual_refresh_select_snapshot_source_by_mode() {
        for (setup, expected) in [
            (vec![], TransportDirective::OneShotSnapshot),
            (
                vec![TransportInput::Connected],
                TransportDirective::ChannelSnapshot,
            ),
            (
                vec![
                    TransportInput::ConnectionFailed,
                    TransportInput::ConnectionFailed,
                ],
                TransportDirective::OneShotSnapshot,
            ),
        ] {
            for request in [TransportInput::FallbackTick, TransportInput::RefreshNow] {
                let (mut coordinator, _) = TransportCoordinator::new();
                for input in &setup {
                    directives(&mut coordinator, *input);
                }

                assert_eq!(directives(&mut coordinator, request), vec![expected]);
            }
        }
    }

    #[test]
    fn snapshot_requests_coalesce_while_one_is_in_flight() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);

        assert_eq!(
            directives(&mut coordinator, TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(directives(&mut coordinator, TransportInput::RefreshNow).is_empty());
        assert!(directives(&mut coordinator, TransportInput::FallbackTick).is_empty());
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::Valid),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn topology_storms_arm_one_debounce_and_elapsed_requests_one_snapshot() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);

        assert_eq!(
            directives(&mut coordinator, TransportInput::TopologyChanged),
            vec![TransportDirective::StartDebounce]
        );
        assert!(directives(&mut coordinator, TransportInput::TopologyChanged).is_empty());
        assert_eq!(
            directives(&mut coordinator, TransportInput::DebounceElapsed),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(directives(&mut coordinator, TransportInput::DebounceElapsed).is_empty());
    }

    #[test]
    fn connecting_and_degraded_ignore_topology_notifications_and_debounce_expiry() {
        for setup in [
            vec![],
            vec![
                TransportInput::ConnectionFailed,
                TransportInput::ConnectionFailed,
            ],
        ] {
            let (mut coordinator, _) = TransportCoordinator::new();
            for input in setup {
                directives(&mut coordinator, input);
            }

            assert!(directives(&mut coordinator, TransportInput::TopologyChanged).is_empty());
            assert!(directives(&mut coordinator, TransportInput::DebounceElapsed).is_empty());
        }
    }

    #[test]
    fn debounce_elapsed_coalesces_with_an_in_flight_snapshot() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::TopologyChanged);
        directives(&mut coordinator, TransportInput::FallbackTick);

        assert!(directives(&mut coordinator, TransportInput::DebounceElapsed).is_empty());
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::Valid),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn channel_end_clears_debounce_snapshot_and_follow_up_state() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::TopologyChanged);
        directives(&mut coordinator, TransportInput::FallbackTick);
        directives(&mut coordinator, TransportInput::RefreshNow);

        assert_eq!(
            directives(&mut coordinator, TransportInput::ChannelEnded),
            vec![TransportDirective::Connect]
        );
        assert!(complete(&mut coordinator, SnapshotCompletion::Valid).is_empty());
        assert!(directives(&mut coordinator, TransportInput::DebounceElapsed).is_empty());
    }

    #[test]
    fn channel_end_resets_the_malformed_streak() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::FallbackTick);
        complete(&mut coordinator, SnapshotCompletion::MalformedPayload);

        directives(&mut coordinator, TransportInput::ChannelEnded);
        directives(&mut coordinator, TransportInput::Connected);
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            Vec::<TransportDirective>::new()
        );
        assert_eq!(
            directives(&mut coordinator, TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn malformed_payload_retries_once_then_waits_until_valid_resets_streak() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);

        directives(&mut coordinator, TransportInput::FallbackTick);
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(complete(&mut coordinator, SnapshotCompletion::MalformedPayload).is_empty());
        assert_eq!(
            directives(&mut coordinator, TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(complete(&mut coordinator, SnapshotCompletion::Valid).is_empty());
        assert_eq!(
            directives(&mut coordinator, TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn failed_snapshot_does_not_retry_or_reset_malformed_streak() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);

        directives(&mut coordinator, TransportInput::FallbackTick);
        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(complete(&mut coordinator, SnapshotCompletion::Failed).is_empty());
        assert_eq!(
            directives(&mut coordinator, TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
        assert!(complete(&mut coordinator, SnapshotCompletion::MalformedPayload).is_empty());
    }

    #[test]
    fn malformed_completion_with_a_follow_up_emits_one_snapshot() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::FallbackTick);
        directives(&mut coordinator, TransportInput::RefreshNow);

        assert_eq!(
            complete(&mut coordinator, SnapshotCompletion::MalformedPayload),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn completion_without_an_in_flight_snapshot_is_a_no_op() {
        let (mut coordinator, _) = TransportCoordinator::new();

        for completion in [
            SnapshotCompletion::Valid,
            SnapshotCompletion::Failed,
            SnapshotCompletion::MalformedPayload,
        ] {
            assert!(complete(&mut coordinator, completion).is_empty());
        }
    }

    #[test]
    fn connecting_and_degraded_snapshot_failures_wait_for_next_tick() {
        for setup in [
            vec![],
            vec![
                TransportInput::ConnectionFailed,
                TransportInput::ConnectionFailed,
            ],
        ] {
            for completion in [
                SnapshotCompletion::Failed,
                SnapshotCompletion::MalformedPayload,
            ] {
                let (mut coordinator, _) = TransportCoordinator::new();
                for input in &setup {
                    directives(&mut coordinator, *input);
                }

                assert_eq!(
                    directives(&mut coordinator, TransportInput::FallbackTick),
                    vec![TransportDirective::OneShotSnapshot]
                );
                assert!(complete(&mut coordinator, completion).is_empty());
            }
        }
    }

    #[test]
    fn malformed_payload_streak_saturates() {
        let (mut coordinator, _) = TransportCoordinator::new();
        directives(&mut coordinator, TransportInput::Connected);
        directives(&mut coordinator, TransportInput::FallbackTick);
        complete(&mut coordinator, SnapshotCompletion::MalformedPayload);

        for _ in 0..usize::from(u8::MAX) + 1 {
            assert!(complete(&mut coordinator, SnapshotCompletion::MalformedPayload).is_empty());
            assert_eq!(
                directives(&mut coordinator, TransportInput::FallbackTick),
                vec![TransportDirective::ChannelSnapshot]
            );
        }
    }
}
