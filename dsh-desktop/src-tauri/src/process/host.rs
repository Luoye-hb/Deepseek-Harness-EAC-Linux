use std::collections::BTreeMap;
use std::env;
use std::io::{BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{Host, Url};

use super::fence::ProcessFence;

const PROTOCOL_VERSION: u64 = 1;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Default, Serialize)]
pub struct HostStatus {
    pub running: bool,
    pub host_pid: Option<u32>,
    pub dsh_pid: Option<u32>,
    pub url: Option<String>,
}

#[derive(Default)]
pub struct HostManager {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    fence: Option<ProcessFence>,
    next_id: u64,
    url: Option<String>,
    dsh_pid: Option<u32>,
}

impl HostManager {
    pub fn status(&mut self) -> HostStatus {
        self.reap_if_exited();
        HostStatus {
            running: self.child.is_some(),
            host_pid: self.child.as_ref().map(Child::id),
            dsh_pid: self.dsh_pid,
            url: self.url.clone(),
        }
    }

    pub fn start(
        &mut self,
        resource_dir: Option<&Path>,
        user_data_dir: Option<&Path>,
    ) -> Result<HostStatus, String> {
        self.reap_if_exited();
        if self.child.is_some() {
            return Ok(self.status());
        }

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let resource_root = resource_dir.unwrap_or(&root);
        let node = resolve_path(
            "DSH_DESKTOP_NODE",
            &[
                resource_root.join("node").join("node"),
                resource_root.join("node").join("node.exe"),
                resource_root.join("vendor").join("node").join("node"),
                resource_root.join("vendor").join("node").join("node.exe"),
                root.join("vendor").join("node").join("node"),
                root.join("vendor").join("node").join("node.exe"),
            ],
        )?;
        let npm_cli = resolve_path(
            "DSH_DESKTOP_NPM_CLI",
            &[
                resource_root.join("npm").join("bin").join("npm-cli.js"),
                resource_root
                    .join("vendor")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js"),
                root.join("vendor")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js"),
            ],
        )?;
        let entry = resolve_path(
            "DSH_DESKTOP_HOST_ENTRY",
            &[
                resource_root.join("desktop-host").join("main.js"),
                root.join("desktop-host").join("main.js"),
            ],
        )?;
        let dsh_bin = resolve_path(
            "DSH_DESKTOP_DSH_BIN",
            &[
                resource_root
                    .join("node_modules")
                    .join("@deepseek-ai")
                    .join("dsh")
                    .join("lib")
                    .join("bin.js"),
                root.join("node_modules")
                    .join("@deepseek-ai")
                    .join("dsh")
                    .join("lib")
                    .join("bin.js"),
            ],
        )?;
        let cwd = env::var_os("DSH_DESKTOP_CWD")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone());
        let fence_plan = ProcessFence::prepare(&entry, &node)?;

        let mut command = Command::new(&node);
        command
            .arg(&entry)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("DSH_DESKTOP", "1");
        command.env("DSH_DESKTOP_VERSION", env!("CARGO_PKG_VERSION"));
        if let Some(user_data_dir) = user_data_dir {
            command.env("DSH_DESKTOP_USERDATA", user_data_dir);
        }
        if let Some(lease_path) = fence_plan.lease_path() {
            command.env("DSH_DESKTOP_LEASE", lease_path);
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            let supervisor_pid = std::process::id() as libc::pid_t;
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // Avoid the small fork/exec race where the supervisor can
                    // exit before PR_SET_PDEATHSIG is installed.
                    if libc::getppid() != supervisor_pid {
                        let _ = libc::kill(libc::getpid(), libc::SIGTERM);
                    }
                    Ok(())
                });
            }
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to spawn desktop-host: {error}"))?;
        let fence = match ProcessFence::attach(&child, &entry, &node, fence_plan) {
            Ok(fence) => fence,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "failed to attach desktop-host process fence: {error}"
                ));
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "desktop-host stdin was not piped".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "desktop-host stdout was not piped".to_owned())?;
        set_stdout_nonblocking(&stdout)?;

        self.child = Some(child);
        self.stdin = Some(stdin);
        self.stdout = Some(BufReader::new(stdout));
        self.fence = Some(fence);
        self.url = None;
        self.dsh_pid = None;

        let mut params = BTreeMap::new();
        params.insert(
            "nodePath".to_owned(),
            Value::String(node.display().to_string()),
        );
        params.insert(
            "npmCliPath".to_owned(),
            Value::String(npm_cli.display().to_string()),
        );
        params.insert(
            "dshBin".to_owned(),
            Value::String(dsh_bin.display().to_string()),
        );
        params.insert(
            "profile".to_owned(),
            Value::String(
                env::var("DSH_DESKTOP_PROFILE").unwrap_or_else(|_| "web-desktop".to_owned()),
            ),
        );
        params.insert("cwd".to_owned(), Value::String(cwd.display().to_string()));
        params.insert("host".to_owned(), Value::String("127.0.0.1".to_owned()));
        params.insert("port".to_owned(), Value::from(0_u16));
        params.insert(
            "assetsDir".to_owned(),
            Value::String(
                resource_root
                    .join("assets")
                    .join("plugins")
                    .display()
                    .to_string(),
            ),
        );

        let result = match self.request("dsh:start", Value::Object(params.into_iter().collect())) {
            Ok(result) => result,
            Err(error) => {
                self.abort();
                return Err(error);
            }
        };
        let url = result
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "desktop-host returned no dsh URL".to_owned())
            .and_then(|url| {
                validate_loopback_http_200(url)?;
                Ok(url.to_owned())
            });
        let url = match url {
            Ok(url) => url,
            Err(error) => {
                self.abort();
                return Err(error);
            }
        };
        self.url = Some(url);
        self.dsh_pid = result
            .get("pid")
            .and_then(Value::as_u64)
            .map(|pid| pid as u32);
        Ok(self.status())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if self.child.is_none() {
            return Ok(());
        }
        let shutdown = self.request_with_timeout("host:shutdown", Value::Null, SHUTDOWN_TIMEOUT);
        if let Err(error) = shutdown {
            self.abort();
            return Err(error);
        }
        self.stdin = None;
        self.stdout = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.fence = None;
        self.url = None;
        self.dsh_pid = None;
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request_with_notify_timeout(method, params, timeout, |_event, _payload| {})
    }

    fn request_with_notify<F>(
        &mut self,
        method: &str,
        params: Value,
        on_notify: F,
    ) -> Result<Value, String>
    where
        F: FnMut(&str, &Value),
    {
        self.request_with_notify_timeout(method, params, REQUEST_TIMEOUT, on_notify)
    }

    fn request_with_notify_timeout<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        mut on_notify: F,
    ) -> Result<Value, String>
    where
        F: FnMut(&str, &Value),
    {
        if self.child.is_none() {
            return Err("desktop-host is not running".to_owned());
        }
        self.next_id = self.next_id.wrapping_add(1);
        let id = format!("tauri-{}", self.next_id);
        let request = json!({
            "kind": "req",
            "version": PROTOCOL_VERSION,
            "id": id,
            "method": method,
            "params": params,
        });
        write_frame(
            self.stdin
                .as_mut()
                .ok_or_else(|| "desktop-host stdin is unavailable".to_owned())?,
            &request,
        )?;

        let deadline = Instant::now() + timeout;
        loop {
            let message = read_frame(
                self.stdout
                    .as_mut()
                    .ok_or_else(|| "desktop-host stdout is unavailable".to_owned())?,
                deadline,
            )?;
            match message.get("kind").and_then(Value::as_str) {
                Some("notify") => {
                    let event = message
                        .get("event")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "desktop-host notification has no event".to_owned())?;
                    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
                    on_notify(event, &payload);
                    continue;
                }
                Some("res") => {
                    if message.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                        return Err("desktop-host returned an unexpected response id".to_owned());
                    }
                    if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                    }
                    let error = message
                        .get("error")
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("desktop-host request failed");
                    return Err(error.to_owned());
                }
                _ => return Err("desktop-host returned an invalid message".to_owned()),
            }
        }
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request(method, params)
    }

    pub fn call_with_notify<F>(
        &mut self,
        method: &str,
        params: Value,
        on_notify: F,
    ) -> Result<Value, String>
    where
        F: FnMut(&str, &Value),
    {
        self.request_with_notify(method, params, on_notify)
    }

    fn reap_if_exited(&mut self) {
        let exited = self
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some();
        if exited {
            self.fence = None;
            self.child = None;
            self.stdin = None;
            self.stdout = None;
            self.url = None;
            self.dsh_pid = None;
        }
    }

    fn abort(&mut self) {
        self.stdin = None;
        self.stdout = None;
        self.fence = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.url = None;
        self.dsh_pid = None;
    }
}

impl Drop for HostManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Debug, Deserialize)]
struct _ProtocolMarker {
    #[allow(dead_code)]
    version: u64,
}

fn resolve_path(name: &str, candidates: &[PathBuf]) -> Result<PathBuf, String> {
    if let Some(value) = env::var_os(name) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "{name} does not point to a file: {}",
            path.display()
        ));
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "could not resolve {name}; checked {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn write_frame(writer: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.len() > MAX_FRAME_BYTES {
        return Err("desktop-host request exceeds the 4 MiB frame limit".to_owned());
    }
    let length = (body.len() as u32).to_le_bytes();
    writer
        .write_all(&length)
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("desktop-host write failed: {error}"))
}

fn read_frame(reader: &mut BufReader<ChildStdout>, deadline: Instant) -> Result<Value, String> {
    let mut length = [0_u8; 4];
    read_exact_until(reader, &mut length, deadline)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err("desktop-host response exceeds the 4 MiB frame limit".to_owned());
    }
    let mut body = vec![0_u8; length];
    read_exact_until(reader, &mut body, deadline)?;
    serde_json::from_slice(&body).map_err(|error| format!("invalid desktop-host JSON: {error}"))
}

fn read_exact_until(
    reader: &mut BufReader<ChildStdout>,
    target: &mut [u8],
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < target.len() {
        if Instant::now() >= deadline {
            return Err("desktop-host response timed out".to_owned());
        }
        if reader.buffer().is_empty() {
            wait_for_stdout(reader.get_ref(), deadline)?;
        }
        let available = reader.buffer().len();
        let end = if available == 0 {
            target.len()
        } else {
            (offset + available).min(target.len())
        };
        match reader.read(&mut target[offset..end]) {
            Ok(0) => return Err("desktop-host stdout closed unexpectedly".to_owned()),
            Ok(read) => offset += read,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(format!("desktop-host read failed: {error}")),
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_stdout_nonblocking(stdout: &ChildStdout) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;

    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(format!(
            "cannot inspect desktop-host stdout flags: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if result < 0 {
        return Err(format!(
            "cannot make desktop-host stdout nonblocking: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_stdout_nonblocking(_stdout: &ChildStdout) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn wait_for_stdout(stdout: &ChildStdout, deadline: Instant) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;

    let fd = stdout.as_raw_fd();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("desktop-host response timed out".to_owned());
        }
        let timeout_ms = remaining.as_millis().min(i32::MAX as u128) as i32;
        let mut poll_fd = libc::pollfd {
            fd,
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
        if result > 0 {
            return Ok(());
        }
        if result == 0 {
            return Err("desktop-host response timed out".to_owned());
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(format!(
                "desktop-host stdout poll failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
}

#[cfg(target_os = "windows")]
fn wait_for_stdout(stdout: &ChildStdout, deadline: Instant) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::thread;

    type Handle = *mut c_void;
    type Bool = i32;
    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_available: *mut u32,
            bytes_left: *mut u32,
        ) -> Bool;
    }

    loop {
        let mut available = 0_u32;
        let ok = unsafe {
            PeekNamedPipe(
                stdout.as_raw_handle() as Handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "desktop-host stdout pipe failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if available > 0 {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("desktop-host response timed out".to_owned());
        }
        thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn wait_for_stdout(_stdout: &ChildStdout, deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err("desktop-host response timed out".to_owned());
    }
    std::thread::sleep(Duration::from_millis(10));
    Ok(())
}

fn validate_loopback_http_200(raw: &str) -> Result<(), String> {
    let parsed = validate_loopback_url(raw)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "dsh URL has no host".to_owned())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "dsh URL has no port".to_owned())?;
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("dsh URL address resolution failed: {error}"))?
        .next()
        .ok_or_else(|| "dsh URL address resolution returned no address".to_owned())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| format!("dsh HTTP readiness connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let path = if parsed.path().is_empty() {
        "/"
    } else {
        parsed.path()
    };
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("dsh HTTP readiness write failed: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("dsh HTTP readiness read failed: {error}"))?;
    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        return Err(format!("dsh HTTP readiness returned {status}"));
    }
    Ok(())
}

fn validate_loopback_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|error| format!("invalid dsh URL: {error}"))?;
    let host = parsed
        .host()
        .ok_or_else(|| "dsh URL has no host".to_owned())?;
    let loopback = match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    if parsed.scheme() != "http"
        || !loopback
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return Err(format!(
            "dsh URL is not an authenticated loopback HTTP URL: {raw}"
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::validate_loopback_url;

    #[cfg(target_os = "linux")]
    use super::{read_frame, set_stdout_nonblocking};

    #[test]
    fn accepts_only_http_loopback_urls() {
        assert!(validate_loopback_url("http://127.0.0.1:43123/").is_ok());
        assert!(validate_loopback_url("http://localhost:43123/").is_ok());
        assert!(validate_loopback_url("http://[::1]:43123/").is_ok());
        assert!(validate_loopback_url("https://127.0.0.1:43123/").is_err());
        assert!(validate_loopback_url("http://192.0.2.10:43123/").is_err());
        assert!(validate_loopback_url("http://user:pass@127.0.0.1:43123/").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn host_response_reads_have_a_deadline() {
        use std::io::BufReader;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let mut child = Command::new("sh")
            .args(["-c", "sleep 2"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn quiet child");
        let stdout = child.stdout.take().expect("child stdout");
        set_stdout_nonblocking(&stdout).expect("configure child stdout");
        let mut reader = BufReader::new(stdout);
        let error = read_frame(&mut reader, Instant::now() + Duration::from_millis(50))
            .expect_err("read should time out");
        assert!(error.contains("timed out"));
        let _ = child.kill();
        let _ = child.wait();
    }
}
