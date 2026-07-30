#[cfg(not(unix))]
use anyhow::{Result, bail};

#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::env;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use anyhow::{Context, Result, anyhow, bail};
    use serde::{Deserialize, Serialize};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::time::{Instant, sleep, timeout};

    use crate::actions::execute_jump;
    use crate::control::is_safe_client_tty;
    use crate::model::PaneId;
    use crate::notifications::{
        ActiveClient, ApplyOutcome, ApplyResult, NotificationCommand, NotificationEvent,
        NotificationKind, NotificationState, RouteIntent,
    };
    use crate::tmux_exec::TmuxExec;

    const PROTOCOL_VERSION: u32 = 2;
    const MAX_FRAME_BYTES: usize = 4 * 1024;
    const LIST_PAGE_SIZE: usize = 2;
    const SOCKET_MODE: u32 = 0o600;
    const SOCKET_PREFIX: &str = ".pane-dash-notify-";
    const SOCKET_SUFFIX: &str = ".sock";
    const CLIENT_RETRY: Duration = Duration::from_millis(100);
    const CLIENT_RETRY_STEP: Duration = Duration::from_millis(5);
    const OWNER_RELEASE_TIMEOUT: Duration = Duration::from_millis(500);

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "op", rename_all = "snake_case")]
    enum Request {
        Ping {
            version: u32,
        },
        Publish {
            event_id: String,
            kind: String,
            message: String,
            pane: Option<String>,
        },
        Click {
            range: String,
            client: String,
        },
        List {
            after_sequence: Option<u64>,
        },
        HookFocus {
            client: String,
            pane: String,
            width: usize,
            focused: bool,
        },
        HookPaneExited {
            pane: String,
        },
        SessionClosed,
        Select {
            event_id: String,
            client: String,
        },
        Shutdown,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct Response {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sequence: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        route: Option<RouteResponse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<Vec<SnapshotItem>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        next_after_sequence: Option<u64>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct RouteResponse {
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        window_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SnapshotItem {
        event_id: String,
        kind: String,
        message: String,
        sequence: u64,
        session_id: String,
        window_id: String,
        pane_id: String,
    }

    #[derive(Debug)]
    struct RequestFailure {
        outcome: &'static str,
        message: String,
    }

    impl RequestFailure {
        fn malformed(message: impl Into<String>) -> Self {
            Self {
                outcome: "malformed",
                message: message.into(),
            }
        }

        fn missing_pane(message: impl Into<String>) -> Self {
            Self {
                outcome: "missing_pane",
                message: message.into(),
            }
        }

        fn unavailable(error: impl std::fmt::Display) -> Self {
            Self {
                outcome: "service_unavailable",
                message: error.to_string(),
            }
        }

        fn queue_full() -> Self {
            Self {
                outcome: "queue_full",
                message: "notification queue is full".to_owned(),
            }
        }
    }

    struct HandledRequest {
        response: Response,
        stop: bool,
    }

    struct NotificationService {
        tmux: TmuxExec,
        state: NotificationState,
        active_client: Option<String>,
    }

    pub async fn run_cli(args: &[String]) -> Result<()> {
        match parse_cli(args)? {
            CliCommand::Serve {
                tmux_socket,
                server_pid,
            } => run_server(&tmux_socket, &server_pid).await,
            CliCommand::Client(request) => {
                let socket = client_socket_path()?;
                let response = match &request {
                    Request::List { .. } => list_notifications(&socket).await?,
                    _ => send_request(&socket, &request).await?,
                };
                if !response.ok {
                    bail!(
                        "{}: {}",
                        response.outcome.as_deref().unwrap_or("request_failed"),
                        response
                            .error
                            .as_deref()
                            .unwrap_or("notification request failed")
                    );
                }
                println!("{}", serde_json::to_string(&response)?);
                Ok(())
            }
        }
    }

    #[derive(Debug)]
    enum CliCommand {
        Serve {
            tmux_socket: PathBuf,
            server_pid: String,
        },
        Client(Request),
    }

    fn parse_cli(args: &[String]) -> Result<CliCommand> {
        let Some(command) = args.first().map(String::as_str) else {
            bail!("expected notify command")
        };
        match command {
            "serve" => {
                let values = flags(&args[1..], &["--tmux-socket", "--server-pid"])?;
                let tmux_socket = values
                    .get("--tmux-socket")
                    .map(PathBuf::from)
                    .filter(|path| !path.as_os_str().is_empty())
                    .ok_or_else(|| anyhow!("missing --tmux-socket"))?;
                let server_pid = parse_server_pid(
                    values
                        .get("--server-pid")
                        .ok_or_else(|| anyhow!("missing --server-pid"))?,
                )?;
                Ok(CliCommand::Serve {
                    tmux_socket,
                    server_pid,
                })
            }
            "publish" => {
                let values = flags(&args[1..], &["--event-id", "--kind", "--message", "--pane"])?;
                let event_id = event_id(
                    values
                        .get("--event-id")
                        .ok_or_else(|| anyhow!("missing --event-id"))?,
                )?;
                let kind = parse_kind(
                    values
                        .get("--kind")
                        .ok_or_else(|| anyhow!("missing --kind"))?,
                )?;
                let message = values
                    .get("--message")
                    .ok_or_else(|| anyhow!("missing --message"))?
                    .to_owned();
                let pane = values
                    .get("--pane")
                    .cloned()
                    .or_else(|| env::var("TMUX_PANE").ok());
                if let Some(pane) = &pane {
                    validate_pane(pane)?;
                }
                Ok(CliCommand::Client(Request::Publish {
                    event_id,
                    kind,
                    message,
                    pane,
                }))
            }
            "click" => {
                let values = flags(&args[1..], &["--range", "--client"])?;
                let range = values
                    .get("--range")
                    .ok_or_else(|| anyhow!("missing --range"))?
                    .to_owned();
                validate_range(&range)?;
                let client = values
                    .get("--client")
                    .ok_or_else(|| anyhow!("missing --client"))?
                    .to_owned();
                validate_client(&client)?;
                Ok(CliCommand::Client(Request::Click { range, client }))
            }
            "list" => {
                if args.len() != 1 {
                    bail!("notify list takes no arguments")
                }
                Ok(CliCommand::Client(Request::List {
                    after_sequence: None,
                }))
            }
            "hook" => parse_hook(&args[1..]),
            "select" => {
                let values = flags(&args[1..], &["--event-id", "--client"])?;
                let event_id = event_id(
                    values
                        .get("--event-id")
                        .ok_or_else(|| anyhow!("missing --event-id"))?,
                )?;
                let client = values
                    .get("--client")
                    .ok_or_else(|| anyhow!("missing --client"))?
                    .to_owned();
                validate_client(&client)?;
                Ok(CliCommand::Client(Request::Select { event_id, client }))
            }
            "shutdown" => {
                if args.len() != 1 {
                    bail!("notify shutdown takes no arguments")
                }
                Ok(CliCommand::Client(Request::Shutdown))
            }
            _ => bail!("unknown notify command: {command}"),
        }
    }

    fn parse_hook(args: &[String]) -> Result<CliCommand> {
        let Some(hook) = args.first().map(String::as_str) else {
            bail!("missing notify hook")
        };
        match hook {
            "focus" => {
                let values = flags(&args[1..], &["--client", "--pane", "--width", "--focused"])?;
                let client = values
                    .get("--client")
                    .ok_or_else(|| anyhow!("missing --client"))?
                    .to_owned();
                validate_client(&client)?;
                let pane = values
                    .get("--pane")
                    .ok_or_else(|| anyhow!("missing --pane"))?
                    .to_owned();
                validate_pane(&pane)?;
                let width = values
                    .get("--width")
                    .ok_or_else(|| anyhow!("missing --width"))?
                    .parse::<usize>()
                    .context("invalid --width")?;
                let focused = match values
                    .get("--focused")
                    .ok_or_else(|| anyhow!("missing --focused"))?
                    .as_str()
                {
                    "0" => false,
                    "1" => true,
                    _ => bail!("--focused must be 0 or 1"),
                };
                Ok(CliCommand::Client(Request::HookFocus {
                    client,
                    pane,
                    width,
                    focused,
                }))
            }
            "pane-exited" => {
                let values = flags(&args[1..], &["--pane"])?;
                let pane = values
                    .get("--pane")
                    .ok_or_else(|| anyhow!("missing --pane"))?
                    .to_owned();
                validate_pane(&pane)?;
                Ok(CliCommand::Client(Request::HookPaneExited { pane }))
            }
            "session-closed" => {
                if args.len() != 1 {
                    bail!("notify hook session-closed takes no arguments")
                }
                Ok(CliCommand::Client(Request::SessionClosed))
            }
            _ => bail!("unknown notify hook: {hook}"),
        }
    }

    fn flags(args: &[String], allowed: &[&str]) -> Result<HashMap<String, String>> {
        let mut values = HashMap::new();
        let mut index = 0;
        while index < args.len() {
            let name = &args[index];
            if !allowed.contains(&name.as_str()) {
                bail!("unknown argument: {name}")
            }
            if values.contains_key(name) {
                bail!("duplicate argument: {name}")
            }
            let value = args
                .get(index + 1)
                .ok_or_else(|| anyhow!("missing value for {name}"))?;
            values.insert(name.clone(), value.clone());
            index += 2;
        }
        Ok(values)
    }

    fn parse_server_pid(value: &str) -> Result<String> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            bail!("invalid server pid")
        }
        let value = value.parse::<u64>().context("invalid server pid")?;
        if value == 0 {
            bail!("invalid server pid")
        }
        Ok(value.to_string())
    }

    fn event_id(value: &str) -> Result<String> {
        crate::notifications::EventId::try_from(value)
            .map(|_| value.to_owned())
            .map_err(|error| anyhow!(error.to_string()))
    }

    fn parse_kind(value: &str) -> Result<String> {
        let kind = match value {
            "error" => NotificationKind::Error,
            "permission" => NotificationKind::Permission,
            "question" => NotificationKind::Question,
            "finished" => NotificationKind::Finished,
            _ => bail!("invalid notification kind"),
        };
        Ok(kind_label(kind).to_owned())
    }

    fn validate_pane(value: &str) -> Result<()> {
        if valid_machine_id(value, '%') {
            Ok(())
        } else {
            bail!("invalid pane ID")
        }
    }

    fn validate_client(value: &str) -> Result<()> {
        if is_safe_client_tty(value) {
            Ok(())
        } else {
            bail!("invalid client tty")
        }
    }

    fn validate_range(value: &str) -> Result<()> {
        if value == "pane-dash-more" {
            return Ok(());
        }
        let Some(digits) = value.strip_prefix("pane-dash-visible-") else {
            bail!("invalid notification range")
        };
        if digits.is_empty()
            || (digits.len() > 1 && digits.starts_with('0'))
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            bail!("invalid notification range")
        }
        let sequence = digits
            .parse::<u64>()
            .map_err(|_| anyhow!("invalid notification range"))?;
        if sequence == 0 {
            bail!("invalid notification range")
        }
        Ok(())
    }

    fn valid_machine_id(value: &str, prefix: char) -> bool {
        value
            .strip_prefix(prefix)
            .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()))
    }

    fn client_socket_path() -> Result<PathBuf> {
        let identity = env::var("TMUX").context("TMUX is not set")?;
        let mut fields = identity.rsplitn(3, ',');
        let client_id = fields.next().unwrap_or_default();
        let server_pid = fields.next().unwrap_or_default();
        let tmux_socket = fields.next().unwrap_or_default();
        if client_id.is_empty() || tmux_socket.is_empty() {
            bail!("invalid TMUX identity")
        }
        let server_pid = parse_server_pid(server_pid)?;
        Ok(notification_socket_path(
            Path::new(tmux_socket),
            &server_pid,
        ))
    }

    fn notification_socket_path(tmux_socket: &Path, server_pid: &str) -> PathBuf {
        tmux_socket
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{SOCKET_PREFIX}{server_pid}{SOCKET_SUFFIX}"))
    }

    async fn send_request(path: &Path, request: &Request) -> Result<Response> {
        let mut stream = connect_with_retry(path).await?;
        send_request_on_stream(&mut stream, request).await
    }

    async fn send_request_on_stream(
        stream: &mut UnixStream,
        request: &Request,
    ) -> Result<Response> {
        let request = serde_json::to_vec(request)?;
        write_frame(stream, &request).await?;
        let response = read_frame(stream)
            .await?
            .ok_or_else(|| anyhow!("notification service closed the connection"))?;
        serde_json::from_slice(&response).context("invalid notification service response")
    }

    async fn list_notifications(path: &Path) -> Result<Response> {
        let mut after_sequence = None;
        let mut snapshot = Vec::new();
        loop {
            let response = send_request(path, &Request::List { after_sequence }).await?;
            if !response.ok {
                return Ok(response);
            }
            let next_after_sequence = response.next_after_sequence;
            snapshot.extend(response.snapshot.unwrap_or_default());
            let Some(next) = next_after_sequence else {
                return Ok(Response::success("listed").with_snapshot(snapshot));
            };
            if Some(next) == after_sequence {
                bail!("notification list cursor did not advance")
            }
            after_sequence = Some(next);
        }
    }

    async fn connect_with_retry(path: &Path) -> Result<UnixStream> {
        let deadline = Instant::now() + CLIENT_RETRY;
        loop {
            match UnixStream::connect(path).await {
                Ok(stream) => return Ok(stream),
                Err(error) if Instant::now() < deadline => {
                    sleep(CLIENT_RETRY_STEP).await;
                    let _ = error;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("connect notification service at {}", path.display())
                    });
                }
            }
        }
    }

    async fn run_server(tmux_socket: &Path, server_pid: &str) -> Result<()> {
        let socket = notification_socket_path(tmux_socket, server_pid);
        let Some(listener) = bind_or_join(&socket).await? else {
            return Ok(());
        };
        let owner = socket_identity(&socket)?;
        let mut service = NotificationService {
            tmux: TmuxExec::with_socket("tmux", tmux_socket),
            state: NotificationState::new(),
            active_client: None,
        };
        let result = listen(&listener, &mut service).await;
        remove_socket_if_owned(&socket, owner);
        result
    }

    async fn bind_or_join(path: &Path) -> Result<Option<UnixListener>> {
        match UnixListener::bind(path) {
            Ok(listener) => return Ok(Some(configure_listener(path, listener)?)),
            Err(bind_error) => match connect_with_retry(path).await {
                Ok(mut stream) => {
                    let response = match timeout(
                        OWNER_RELEASE_TIMEOUT,
                        send_request_on_stream(
                            &mut stream,
                            &Request::Ping {
                                version: PROTOCOL_VERSION,
                            },
                        ),
                    )
                    .await
                    {
                        Ok(response) => response?,
                        Err(_) => bail!("existing notification service did not answer ping"),
                    };
                    if response.ok && response.version == Some(PROTOCOL_VERSION) {
                        return Ok(None);
                    }

                    let shutdown = match timeout(
                        OWNER_RELEASE_TIMEOUT,
                        send_request(path, &Request::Shutdown),
                    )
                    .await
                    {
                        Ok(shutdown) => shutdown?,
                        Err(_) => {
                            bail!("existing notification service did not answer shutdown")
                        }
                    };
                    if !shutdown.ok {
                        bail!(
                            "existing notification service rejected shutdown: {}",
                            shutdown.error.as_deref().unwrap_or("unknown error")
                        );
                    }
                    wait_for_socket_release(path).await?;
                }
                Err(_) => {
                    fs::remove_file(path).with_context(|| {
                        format!(
                            "remove stale notification socket {} after bind failure: {bind_error}",
                            path.display()
                        )
                    })?;
                }
            },
        }
        let listener = UnixListener::bind(path)
            .with_context(|| format!("bind notification socket {}", path.display()))?;
        Ok(Some(configure_listener(path, listener)?))
    }

    fn configure_listener(path: &Path, listener: UnixListener) -> Result<UnixListener> {
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE))
            .with_context(|| format!("set notification socket mode on {}", path.display()))?;
        Ok(listener)
    }

    fn socket_identity(path: &Path) -> Result<(u64, u64)> {
        let metadata = fs::metadata(path)
            .with_context(|| format!("read notification socket {}", path.display()))?;
        Ok((metadata.dev(), metadata.ino()))
    }

    fn remove_socket_if_owned(path: &Path, owner: (u64, u64)) {
        if fs::metadata(path)
            .ok()
            .is_some_and(|metadata| (metadata.dev(), metadata.ino()) == owner)
        {
            let _ = fs::remove_file(path);
        }
    }

    async fn wait_for_socket_release(path: &Path) -> Result<()> {
        let deadline = Instant::now() + OWNER_RELEASE_TIMEOUT;
        loop {
            match fs::metadata(path) {
                Ok(_) if Instant::now() < deadline => sleep(CLIENT_RETRY_STEP).await,
                Ok(_) => bail!(
                    "existing notification service did not release {}",
                    path.display()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("check notification socket release {}", path.display())
                    });
                }
            }
        }
    }

    async fn listen(listener: &UnixListener, service: &mut NotificationService) -> Result<()> {
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted?;
                    if handle_connection(&mut stream, service).await? {
                        return Ok(());
                    }
                }
                _ = interrupt.recv() => return Ok(()),
                _ = terminate.recv() => return Ok(()),
                _ = hangup.recv() => return Ok(()),
            }
        }
    }

    async fn handle_connection(
        stream: &mut UnixStream,
        service: &mut NotificationService,
    ) -> Result<bool> {
        let frame = match read_frame(stream).await {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(false),
            Err(error) => {
                write_response(stream, &Response::failure("malformed", error.to_string())).await?;
                return Ok(false);
            }
        };
        let request = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    stream,
                    &Response::failure("malformed", format!("invalid request: {error}")),
                )
                .await?;
                return Ok(false);
            }
        };
        let handled = match service.handle(request).await {
            Ok(handled) => handled,
            Err(error) => HandledRequest {
                response: Response::failure(error.outcome, error.message),
                stop: false,
            },
        };
        write_response(stream, &handled.response).await?;
        Ok(handled.stop)
    }

    impl NotificationService {
        async fn handle(
            &mut self,
            request: Request,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            match request {
                Request::Ping { version } => {
                    if version == PROTOCOL_VERSION {
                        Ok(HandledRequest {
                            response: Response::success("pong").with_version(PROTOCOL_VERSION),
                            stop: false,
                        })
                    } else {
                        Err(RequestFailure::malformed(
                            "notification protocol version mismatch",
                        ))
                    }
                }
                Request::Publish {
                    event_id,
                    kind,
                    message,
                    pane,
                } => self.publish(event_id, kind, message, pane).await,
                Request::Click { range, client } => self.click(range, client).await,
                Request::List { after_sequence } => {
                    let (snapshot, next_after_sequence) = self.snapshot_items(after_sequence);
                    Ok(HandledRequest {
                        response: Response::success("listed")
                            .with_snapshot(snapshot)
                            .with_next_after_sequence(next_after_sequence),
                        stop: false,
                    })
                }
                Request::HookFocus {
                    client,
                    pane,
                    width,
                    focused,
                } => self.focus(client, pane, width, focused).await,
                Request::HookPaneExited { pane } => self.pane_exited(pane).await,
                Request::SessionClosed => self.session_closed().await,
                Request::Select { event_id, client } => self.select(event_id, client).await,
                Request::Shutdown => Ok(HandledRequest {
                    response: Response::success("stopped"),
                    stop: true,
                }),
            }
        }

        async fn publish(
            &mut self,
            event_id: String,
            kind: String,
            message: String,
            pane: Option<String>,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            let event_id = crate::notifications::EventId::try_from(event_id)
                .map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let kind = parse_kind_value(&kind)?;
            let pane = pane
                .or_else(|| env::var("TMUX_PANE").ok())
                .ok_or_else(|| RequestFailure::missing_pane("no pane was supplied"))?;
            validate_pane(&pane).map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let pane_id = PaneId::from(pane);
            let (resolved_pane, session_id, window_id) = self
                .tmux
                .resolve_notification_target(&pane_id)
                .await
                .map_err(|_| RequestFailure::missing_pane("pane could not be resolved"))?;
            if resolved_pane != pane_id {
                return Err(RequestFailure::missing_pane("pane could not be resolved"));
            }
            let result = self
                .state
                .apply(NotificationCommand::Publish(NotificationEvent::new(
                    kind,
                    event_id.as_str(),
                    message,
                    crate::notifications::NotificationTarget::new(session_id, window_id, pane_id),
                )));
            self.finish_state_change(result, None).await
        }

        async fn focus(
            &mut self,
            client: String,
            pane: String,
            width: usize,
            focused: bool,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            validate_client(&client)
                .map_err(|error| RequestFailure::malformed(error.to_string()))?;
            validate_pane(&pane).map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let active_client =
                ActiveClient::new(client.clone(), focused, Some(PaneId::from(pane)));
            let result = self.state.apply(NotificationCommand::UpdateActiveClient {
                client: Some(active_client),
                status_width: width,
            });
            self.active_client = Some(client);
            self.finish_state_change(result, None).await
        }

        async fn pane_exited(
            &mut self,
            pane: String,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            validate_pane(&pane).map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let result =
                self.state
                    .apply(NotificationCommand::RemoveStalePanes(vec![PaneId::from(
                        pane,
                    )]));
            self.finish_state_change(result, None).await
        }

        async fn click(
            &mut self,
            range: String,
            client: String,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            validate_range(&range).map_err(|error| RequestFailure::malformed(error.to_string()))?;
            validate_client(&client)
                .map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let result = self.state.apply(NotificationCommand::Click(range));
            let route = result.route.clone();
            let handled = self.finish_state_change(result, Some(&client)).await?;
            if let Some(RouteIntent::Pane(target)) = route
                && !execute_jump(
                    &self.tmux,
                    None,
                    &client,
                    &crate::app::JumpTarget::Pane(target.pane_id().clone()),
                    false,
                )
                .await
            {
                return Err(RequestFailure::missing_pane("pane could not be selected"));
            }
            Ok(handled)
        }

        async fn select(
            &mut self,
            event_id: String,
            client: String,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            crate::notifications::EventId::try_from(event_id.clone())
                .map_err(|error| RequestFailure::malformed(error.to_string()))?;
            validate_client(&client)
                .map_err(|error| RequestFailure::malformed(error.to_string()))?;
            let result = self.state.apply(NotificationCommand::Select(event_id));
            let route = result.route.clone();
            let handled = self.finish_state_change(result, Some(&client)).await?;
            if let Some(RouteIntent::Pane(target)) = route
                && !execute_jump(
                    &self.tmux,
                    None,
                    &client,
                    &crate::app::JumpTarget::Pane(target.pane_id().clone()),
                    false,
                )
                .await
            {
                return Err(RequestFailure::missing_pane("pane could not be selected"));
            }
            Ok(handled)
        }

        async fn session_closed(&mut self) -> std::result::Result<HandledRequest, RequestFailure> {
            let has_sessions = self.tmux.list_sessions().await.is_ok_and(|sessions| {
                sessions
                    .split(|byte| *byte == b'\n' || *byte == b'\r')
                    .any(|line| !line.is_empty())
            });
            Ok(HandledRequest {
                response: Response::success(if has_sessions {
                    "server_alive"
                } else {
                    "stopped"
                }),
                stop: !has_sessions,
            })
        }

        async fn finish_state_change(
            &self,
            result: ApplyResult,
            refresh_client: Option<&str>,
        ) -> std::result::Result<HandledRequest, RequestFailure> {
            match &result.outcome {
                ApplyOutcome::QueueFull => return Err(RequestFailure::queue_full()),
                ApplyOutcome::Rejected(error) => {
                    return Err(RequestFailure::malformed(error.to_string()));
                }
                _ => {}
            }

            if result.changed && writes_status(&result.outcome) {
                self.tmux
                    .set_notification_status(&result.status_row)
                    .await
                    .map_err(RequestFailure::unavailable)?;
                if let Some(client) = refresh_client.or(self.active_client.as_deref()) {
                    self.tmux
                        .refresh_client_status(client)
                        .await
                        .map_err(RequestFailure::unavailable)?;
                }
            }
            Ok(HandledRequest {
                response: response_for_result(&result),
                stop: false,
            })
        }

        fn snapshot_items(&self, after_sequence: Option<u64>) -> (Vec<SnapshotItem>, Option<u64>) {
            let ordered = self.state.snapshot();
            let items = ordered.items();
            let start = after_sequence
                .and_then(|sequence| {
                    items
                        .iter()
                        .position(|notification| notification.sequence() == sequence)
                })
                .map_or(0, |index| index + 1);
            let end = (start + LIST_PAGE_SIZE).min(items.len());
            let page = items[start..end]
                .iter()
                .map(|notification| SnapshotItem {
                    event_id: notification.event_id().as_str().to_owned(),
                    kind: kind_label(notification.kind()).to_owned(),
                    message: notification.message().to_owned(),
                    sequence: notification.sequence(),
                    session_id: notification.target().session_id().0.clone(),
                    window_id: notification.target().window_id().0.clone(),
                    pane_id: notification.target().pane_id().0.clone(),
                })
                .collect();
            let next_after_sequence = (end < items.len()).then(|| items[end - 1].sequence());
            (page, next_after_sequence)
        }
    }

    fn parse_kind_value(value: &str) -> std::result::Result<NotificationKind, RequestFailure> {
        match value {
            "error" => Ok(NotificationKind::Error),
            "permission" => Ok(NotificationKind::Permission),
            "question" => Ok(NotificationKind::Question),
            "finished" => Ok(NotificationKind::Finished),
            _ => Err(RequestFailure::malformed("invalid notification kind")),
        }
    }

    fn response_for_result(result: &ApplyResult) -> Response {
        let mut response = Response::success(outcome_label(&result.outcome));
        match result.outcome {
            ApplyOutcome::Published { sequence }
            | ApplyOutcome::ClickedVisible { sequence }
            | ApplyOutcome::Selected { sequence } => response.sequence = Some(sequence),
            ApplyOutcome::RemovedStale { count } => response.removed = Some(count),
            _ => {}
        }
        response.route = result.route.as_ref().map(route_response);
        response
    }

    fn outcome_label(outcome: &ApplyOutcome) -> &'static str {
        match outcome {
            ApplyOutcome::Published { .. } => "queued",
            ApplyOutcome::SuppressedByFocus => "suppressed",
            ApplyOutcome::Duplicate => "duplicate",
            ApplyOutcome::QueueFull => "queue_full",
            ApplyOutcome::RemovedStale { .. } => "removed",
            ApplyOutcome::ClickedVisible { .. } => "clicked",
            ApplyOutcome::ClickedMore => "list",
            ApplyOutcome::IgnoredClick => "ignored",
            ApplyOutcome::Selected { .. } => "selected",
            ApplyOutcome::IgnoredSelection => "ignored",
            ApplyOutcome::ActiveClientUpdated => "focused",
            ApplyOutcome::StatusWidthUpdated => "width_updated",
            ApplyOutcome::Rejected(_) => "malformed",
        }
    }

    fn writes_status(outcome: &ApplyOutcome) -> bool {
        match outcome {
            ApplyOutcome::Published { .. }
            | ApplyOutcome::ClickedVisible { .. }
            | ApplyOutcome::Selected { .. }
            | ApplyOutcome::ActiveClientUpdated => true,
            ApplyOutcome::RemovedStale { count } => *count > 0,
            _ => false,
        }
    }

    fn route_response(route: &RouteIntent) -> RouteResponse {
        match route {
            RouteIntent::List => RouteResponse {
                kind: "list".to_owned(),
                session_id: None,
                window_id: None,
                pane_id: None,
            },
            RouteIntent::Pane(target) => RouteResponse {
                kind: "pane".to_owned(),
                session_id: Some(target.session_id().0.clone()),
                window_id: Some(target.window_id().0.clone()),
                pane_id: Some(target.pane_id().0.clone()),
            },
        }
    }

    fn kind_label(kind: NotificationKind) -> &'static str {
        match kind {
            NotificationKind::Error => "error",
            NotificationKind::Permission => "permission",
            NotificationKind::Question => "question",
            NotificationKind::Finished => "finished",
        }
    }

    fn response_frame(response: &Response) -> Result<Vec<u8>> {
        let mut frame = serde_json::to_vec(response)?;
        if frame.len() + 1 > MAX_FRAME_BYTES {
            frame = serde_json::to_vec(&Response::failure(
                "response_too_large",
                "notification response exceeds 4 KiB",
            ))?;
        }
        frame.push(b'\n');
        Ok(frame)
    }

    async fn write_response(stream: &mut UnixStream, response: &Response) -> Result<()> {
        stream.write_all(&response_frame(response)?).await?;
        Ok(())
    }

    async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &[u8]) -> Result<()> {
        if frame.len() + 1 > MAX_FRAME_BYTES {
            bail!("notification frame exceeds 4 KiB")
        }
        writer.write_all(frame).await?;
        writer.write_all(b"\n").await?;
        Ok(())
    }

    async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
        let mut frame = Vec::new();
        loop {
            let mut byte = [0_u8; 1];
            let count = reader.read(&mut byte).await?;
            if count == 0 {
                if frame.is_empty() {
                    return Ok(None);
                }
                bail!("notification frame is missing its newline")
            }
            frame.push(byte[0]);
            if frame.len() > MAX_FRAME_BYTES {
                bail!("notification frame exceeds 4 KiB")
            }
            if byte[0] == b'\n' {
                frame.pop();
                return Ok(Some(frame));
            }
        }
    }

    fn response_success(outcome: &str) -> Response {
        Response {
            ok: true,
            version: None,
            outcome: Some(outcome.to_owned()),
            error: None,
            sequence: None,
            removed: None,
            route: None,
            snapshot: None,
            next_after_sequence: None,
        }
    }

    impl Response {
        fn success(outcome: &str) -> Self {
            response_success(outcome)
        }

        fn failure(outcome: &str, error: impl Into<String>) -> Self {
            Self {
                ok: false,
                version: None,
                outcome: Some(outcome.to_owned()),
                error: Some(error.into()),
                sequence: None,
                removed: None,
                route: None,
                snapshot: None,
                next_after_sequence: None,
            }
        }

        fn with_version(mut self, version: u32) -> Self {
            self.version = Some(version);
            self
        }

        fn with_snapshot(mut self, snapshot: Vec<SnapshotItem>) -> Self {
            self.snapshot = Some(snapshot);
            self
        }

        fn with_next_after_sequence(mut self, sequence: Option<u64>) -> Self {
            self.next_after_sequence = sequence;
            self
        }
    }
}

#[cfg(unix)]
pub use unix::run_cli;

#[cfg(not(unix))]
pub async fn run_cli(_args: &[String]) -> Result<()> {
    bail!("notification service requires Unix sockets")
}
