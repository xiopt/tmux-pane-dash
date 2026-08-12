use std::collections::{HashMap, HashSet};
use std::time::Duration;

use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::model::{HeadlessRecord, HeadlessSessionId, Status};

const DISCOVERY_URL: &str = "http://127.0.0.1:29988/kimaki/opencode-port";
const DIRECTORY_HEADER: &str = "x-opencode-directory";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollUpdate {
    pub records: Vec<HeadlessRecord>,
    pub warning: Option<String>,
}

pub fn spawn_poller() -> mpsc::Receiver<PollUpdate> {
    spawn_poller_with(DISCOVERY_URL, POLL_INTERVAL)
}

fn spawn_poller_with(
    discovery_url: &'static str,
    poll_interval: Duration,
) -> mpsc::Receiver<PollUpdate> {
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let Ok(client) = http_client() else {
            return;
        };
        let mut healthy = false;
        let mut warned = false;
        let mut interval = tokio::time::interval(poll_interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            match poll_once(&client, discovery_url).await {
                Ok(records) => {
                    healthy = true;
                    warned = false;
                    match tx.try_send(PollUpdate {
                        records,
                        warning: None,
                    }) {
                        Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                        Err(mpsc::error::TrySendError::Closed(_)) => break,
                    }
                }
                Err(_) if healthy && !warned => {
                    match tx.try_send(PollUpdate {
                        records: Vec::new(),
                        warning: Some("kimaki source unavailable".into()),
                    }) {
                        Ok(()) => warned = true,
                        Err(mpsc::error::TrySendError::Full(_)) => {}
                        Err(mpsc::error::TrySendError::Closed(_)) => break,
                    }
                }
                Err(_) => {}
            }
        }
    });
    rx
}

fn http_client() -> Result<reqwest::Client, PollError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(PollError::Http)
}

#[derive(Debug, thiserror::Error)]
enum PollError {
    #[error("HTTP request failed")]
    Http(#[from] reqwest::Error),
    #[error("invalid response")]
    Json(#[from] serde_json::Error),
    #[error("invalid directory header")]
    Header(#[from] reqwest::header::InvalidHeaderValue),
    #[error("response exceeded one MiB")]
    ResponseTooLarge,
    #[error("invalid server port")]
    Port,
    #[error("invalid session ancestry")]
    Ancestry,
}

async fn get(
    client: &reqwest::Client,
    url: &str,
    directory: Option<&str>,
) -> Result<Vec<u8>, PollError> {
    let mut request = client.get(url);
    if let Some(directory) = directory {
        request = request.header(DIRECTORY_HEADER, HeaderValue::from_str(directory)?);
    }
    let mut response = request.send().await?.error_for_status()?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(PollError::ResponseTooLarge);
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let Some(length) = body.len().checked_add(chunk.len()) else {
            return Err(PollError::ResponseTooLarge);
        };
        if length > MAX_RESPONSE_BYTES {
            return Err(PollError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    directory: Option<&str>,
) -> Result<T, PollError> {
    Ok(serde_json::from_slice(&get(client, url, directory).await?)?)
}

#[derive(Deserialize)]
struct Discovery {
    port: u16,
}

#[derive(Deserialize)]
struct Project {
    worktree: String,
}

#[derive(Deserialize)]
struct SessionStatus {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct PendingRequest {
    #[serde(rename = "sessionID")]
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SessionInfo {
    id: String,
    directory: String,
    title: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    model: Option<SessionModel>,
    time: SessionTime,
}

#[derive(Debug, Clone, Deserialize)]
struct SessionModel {
    id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SessionTime {
    updated: u64,
}

#[derive(Clone)]
struct ActiveSession {
    directory: String,
    status: Status,
}

async fn poll_once(
    client: &reqwest::Client,
    discovery_url: &str,
) -> Result<Vec<HeadlessRecord>, PollError> {
    let discovery: Discovery = json(client, discovery_url, None).await?;
    if discovery.port == 0 {
        return Err(PollError::Port);
    }
    let base = format!("http://127.0.0.1:{}", discovery.port);
    let projects: Vec<Project> = json(client, &format!("{base}/project"), None).await?;
    let mut seen_worktrees = HashSet::new();
    let mut active = HashMap::new();

    for project in projects {
        if !seen_worktrees.insert(project.worktree.clone()) {
            continue;
        }
        let statuses: HashMap<String, SessionStatus> = json(
            client,
            &format!("{base}/session/status"),
            Some(&project.worktree),
        )
        .await?;
        if statuses.is_empty() {
            continue;
        }

        for (session_id, status) in statuses {
            if matches!(status.kind.as_str(), "busy" | "retry") {
                active
                    .entry(session_id)
                    .and_modify(|current: &mut ActiveSession| {
                        if current.status != Status::NeedsInput {
                            current.directory.clone_from(&project.worktree);
                            current.status = Status::Working;
                        }
                    })
                    .or_insert_with(|| ActiveSession {
                        directory: project.worktree.clone(),
                        status: Status::Working,
                    });
            }
        }
        for endpoint in ["permission", "question"] {
            let requests: Vec<PendingRequest> = json(
                client,
                &format!("{base}/{endpoint}"),
                Some(&project.worktree),
            )
            .await?;
            for request in requests {
                active.insert(
                    request.session_id,
                    ActiveSession {
                        directory: project.worktree.clone(),
                        status: Status::NeedsInput,
                    },
                );
            }
        }
    }

    aggregate_roots(client, &base, active).await
}

async fn aggregate_roots(
    client: &reqwest::Client,
    base: &str,
    active: HashMap<String, ActiveSession>,
) -> Result<Vec<HeadlessRecord>, PollError> {
    let mut cache: HashMap<(String, String), SessionInfo> = HashMap::new();
    let mut roots: HashMap<String, (SessionInfo, Status)> = HashMap::new();
    for (session_id, active_session) in active {
        let mut current_id = session_id;
        let mut visited = HashSet::new();
        loop {
            if !visited.insert(current_id.clone()) {
                return Err(PollError::Ancestry);
            }
            let key = (active_session.directory.clone(), current_id.clone());
            let session = if let Some(session) = cache.get(&key) {
                session.clone()
            } else {
                let url = format!("{base}/session/{}", encode_path_segment(&current_id));
                let session: SessionInfo =
                    json(client, &url, Some(&active_session.directory)).await?;
                cache.insert(key, session.clone());
                session
            };
            if let Some(parent_id) = &session.parent_id {
                current_id = parent_id.clone();
                continue;
            }
            roots
                .entry(session.id.clone())
                .and_modify(|(_, root_status)| {
                    if active_session.status == Status::NeedsInput {
                        *root_status = active_session.status;
                    }
                })
                .or_insert((session, active_session.status));
            break;
        }
    }

    let mut records = roots
        .into_values()
        .map(|(session, status)| HeadlessRecord {
            source_url: base.to_owned(),
            session_id: HeadlessSessionId(session.id),
            title: session.title,
            directory: session.directory,
            model: session.model.map_or_else(String::new, |model| model.id),
            status,
            status_since: Some(session.time.updated / 1_000),
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Ok(records)
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_RESPONSE_BYTES, PollError, encode_path_segment, http_client, poll_once,
        spawn_poller_with,
    };
    use crate::model::{HeadlessSessionId, Status};
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;
    use tokio::time::{Duration, timeout};

    #[derive(Clone, Debug)]
    struct TestRequest {
        path: String,
        headers: HashMap<String, String>,
    }

    struct TestResponse {
        status: u16,
        body: Vec<u8>,
        content_length: Option<usize>,
        location: Option<String>,
    }

    impl TestResponse {
        fn json(body: impl Into<Vec<u8>>) -> Self {
            let body = body.into();
            Self {
                status: 200,
                content_length: Some(body.len()),
                body,
                location: None,
            }
        }

        fn status(status: u16) -> Self {
            Self {
                status,
                body: Vec::new(),
                content_length: Some(0),
                location: None,
            }
        }

        fn redirect(location: impl Into<String>) -> Self {
            Self {
                status: 302,
                body: Vec::new(),
                content_length: Some(0),
                location: Some(location.into()),
            }
        }
    }

    type Handler = dyn Fn(&TestRequest) -> TestResponse + Send + Sync;

    struct TestServer {
        url: &'static str,
        discovery_url: &'static str,
        requests: Arc<Mutex<Vec<TestRequest>>>,
        task: JoinHandle<()>,
    }

    impl TestServer {
        async fn spawn<F, H>(make_handler: F) -> Self
        where
            F: FnOnce(u16) -> H,
            H: Fn(&TestRequest) -> TestResponse + Send + Sync + 'static,
        {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let url = Box::leak(format!("http://127.0.0.1:{port}").into_boxed_str());
            let discovery_url = Box::leak(format!("{url}/kimaki/opencode-port").into_boxed_str());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let handler: Arc<Handler> = Arc::new(make_handler(port));
            let request_log = Arc::clone(&requests);
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let handler = Arc::clone(&handler);
                    let request_log = Arc::clone(&request_log);
                    tokio::spawn(handle_connection(stream, handler, request_log));
                }
            });
            Self {
                url,
                discovery_url,
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<TestRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn handle_connection(
        stream: TcpStream,
        handler: Arc<Handler>,
        requests: Arc<Mutex<Vec<TestRequest>>>,
    ) {
        let mut stream = BufReader::new(stream);
        loop {
            let mut request_line = String::new();
            match stream.read_line(&mut request_line).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if request_line == "\r\n" {
                continue;
            }
            let Some(path) = request_line.split_whitespace().nth(1) else {
                return;
            };
            let mut headers = HashMap::new();
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.trim_end().split_once(':') {
                    headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                }
            }
            let request = TestRequest {
                path: path.to_owned(),
                headers,
            };
            requests.lock().unwrap().push(request.clone());
            let response = handler(&request);
            let reason = if response.status == 200 {
                "OK"
            } else {
                "Error"
            };
            let length = response.content_length.unwrap_or(response.body.len());
            let location = response
                .location
                .as_deref()
                .map_or_else(String::new, |location| format!("Location: {location}\r\n"));
            let head = format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n{location}Connection: keep-alive\r\n\r\n",
                response.status
            );
            let inner = stream.get_mut();
            if inner.write_all(head.as_bytes()).await.is_err()
                || inner.write_all(&response.body).await.is_err()
            {
                return;
            }
        }
    }

    fn directory(request: &TestRequest) -> Option<&str> {
        request
            .headers
            .get("x-opencode-directory")
            .map(String::as_str)
    }

    #[tokio::test]
    async fn scoped_active_project_resolves_exact_root_and_needs_input_priority() {
        let server = TestServer::spawn(|port| move |request| {
            let scoped = directory(request) == Some("/work/active");
            match request.path.as_str() {
                "/kimaki/opencode-port" => TestResponse::json(format!(r#"{{"port":{port}}}"#)),
                "/project" => TestResponse::json(
                    r#"[{"worktree":"/work/active"},{"worktree":"/work/active"}]"#,
                ),
                "/session/status" if scoped => {
                    TestResponse::json(r#"{"ses_child":{"type":"busy"}}"#)
                }
                "/permission" if scoped => {
                    TestResponse::json(r#"[{"sessionID":"ses_child"}]"#)
                }
                "/question" if scoped => TestResponse::json("[]"),
                "/session/ses_child" if scoped => TestResponse::json(
                    r#"{"id":"ses_child","directory":"/work/active","title":"Child","parentID":"ses_root","time":{"updated":2000}}"#,
                ),
                "/session/ses_root" if scoped => TestResponse::json(
                    r#"{"id":"ses_root","directory":"/work/active","title":"Root task","model":{"id":"gpt-test"},"time":{"updated":3000}}"#,
                ),
                _ => TestResponse::status(400),
            }
        })
        .await;

        let records = poll_once(&http_client().unwrap(), server.discovery_url)
            .await
            .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].session_id, HeadlessSessionId::from("ses_root"));
        assert_eq!(records[0].source_url, server.url);
        assert_eq!(records[0].status, Status::NeedsInput);
        assert_eq!(records[0].title, "Root task");
        assert_eq!(records[0].directory, "/work/active");
        assert_eq!(records[0].model, "gpt-test");
        let requests = server.requests();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.path == "/session/status")
                .count(),
            1
        );
        assert!(
            requests
                .iter()
                .filter(|request| {
                    request.path.starts_with("/session/")
                        || matches!(request.path.as_str(), "/permission" | "/question")
                })
                .all(|request| directory(request) == Some("/work/active"))
        );
    }

    #[tokio::test]
    async fn idle_projects_dedupe_status_calls_and_skip_sparse_endpoints() {
        let projects = (0..28)
            .map(|index| serde_json::json!({ "worktree": format!("/work/{}", index % 27) }))
            .collect::<Vec<_>>();
        let projects = serde_json::to_vec(&projects).unwrap();
        let server = TestServer::spawn(move |port| {
            let projects = projects.clone();
            move |request| match request.path.as_str() {
                "/kimaki/opencode-port" => TestResponse::json(format!(r#"{{"port":{port}}}"#)),
                "/project" => TestResponse::json(projects.clone()),
                "/session/status" if directory(request).is_some() => TestResponse::json("{}"),
                _ => TestResponse::status(400),
            }
        })
        .await;

        let records = poll_once(&http_client().unwrap(), server.discovery_url)
            .await
            .unwrap();

        assert!(records.is_empty());
        let requests = server.requests();
        let status_requests = requests
            .iter()
            .filter(|request| request.path == "/session/status")
            .collect::<Vec<_>>();
        assert_eq!(status_requests.len(), 27);
        assert_eq!(
            status_requests
                .iter()
                .filter_map(|request| directory(request))
                .collect::<HashSet<_>>()
                .len(),
            27
        );
        assert!(
            !requests
                .iter()
                .any(|request| { matches!(request.path.as_str(), "/permission" | "/question") })
        );
    }

    #[tokio::test]
    async fn invalid_port_and_oversized_responses_are_rejected() {
        let invalid_port = TestServer::spawn(|_| {
            |request| match request.path.as_str() {
                "/kimaki/opencode-port" => TestResponse::json(r#"{"port":0}"#),
                _ => TestResponse::status(404),
            }
        })
        .await;
        assert!(matches!(
            poll_once(&http_client().unwrap(), invalid_port.discovery_url).await,
            Err(PollError::Port)
        ));

        let oversized = TestServer::spawn(|_| {
            |request| match request.path.as_str() {
                "/kimaki/opencode-port" => TestResponse {
                    status: 200,
                    body: Vec::new(),
                    content_length: Some(MAX_RESPONSE_BYTES + 1),
                    location: None,
                },
                _ => TestResponse::status(404),
            }
        })
        .await;
        assert!(matches!(
            poll_once(&http_client().unwrap(), oversized.discovery_url).await,
            Err(PollError::ResponseTooLarge)
        ));
    }

    #[tokio::test]
    async fn redirects_are_rejected_without_contacting_target() {
        let target = TestServer::spawn(|_| |_| TestResponse::json("[]")).await;
        let redirect_url = format!("{}/session/status", target.url);
        let source = TestServer::spawn(move |port| {
            move |request| match request.path.as_str() {
                "/kimaki/opencode-port" => TestResponse::json(format!(r#"{{"port":{port}}}"#)),
                "/project" => TestResponse::json(r#"[{"worktree":"/work/active"}]"#),
                "/session/status" if directory(request) == Some("/work/active") => {
                    TestResponse::redirect(redirect_url.clone())
                }
                _ => TestResponse::status(400),
            }
        })
        .await;

        assert!(
            poll_once(&http_client().unwrap(), source.discovery_url)
                .await
                .is_err()
        );
        assert!(target.requests().is_empty());
    }

    #[tokio::test]
    async fn absence_is_silent_and_failure_after_health_warns_once() {
        let healthy = Arc::new(Mutex::new(true));
        let server = TestServer::spawn({
            let healthy = Arc::clone(&healthy);
            move |port| {
                move |request| {
                    if !*healthy.lock().unwrap() {
                        return TestResponse::status(503);
                    }
                    match request.path.as_str() {
                        "/kimaki/opencode-port" => {
                            TestResponse::json(format!(r#"{{"port":{port}}}"#))
                        }
                        "/project" => TestResponse::json("[]"),
                        _ => TestResponse::status(404),
                    }
                }
            }
        })
        .await;
        let mut updates = spawn_poller_with(server.discovery_url, Duration::from_millis(10));
        let first = timeout(Duration::from_secs(1), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(first.records.is_empty());
        assert_eq!(first.warning, None);
        *healthy.lock().unwrap() = false;
        let warning = timeout(Duration::from_secs(1), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            warning.warning.as_deref(),
            Some("kimaki source unavailable")
        );
        assert!(
            timeout(Duration::from_millis(50), updates.recv())
                .await
                .is_err()
        );

        let absent = TestServer::spawn(|_| |_| TestResponse::status(503)).await;
        let mut absent_updates = spawn_poller_with(absent.discovery_url, Duration::from_millis(10));
        assert!(
            timeout(Duration::from_millis(50), absent_updates.recv())
                .await
                .is_err()
        );
    }

    #[test]
    fn path_segments_are_percent_encoded() {
        assert_eq!(encode_path_segment("ses/a b?"), "ses%2Fa%20b%3F");
    }
}
