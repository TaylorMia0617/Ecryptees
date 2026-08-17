use reqwest::blocking::{Client, Response};
use reqwest::header::{
    ACCEPT, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, REFERER, USER_AGENT,
};
use reqwest::redirect::Policy;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::ipc::Response as IpcResponse;
use url::Url;
use uuid::Uuid;

const NETWORK_TEMP_DIRECTORY: &str = "ecryptees-network-v1";
const NETWORK_TEMP_SUFFIX: &str = ".part";
const MAX_HTML_BYTES: u64 = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 500 * 1024 * 1024;
const MAX_READ_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_ACTIVE_TASKS: usize = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HTML_TASK_TIMEOUT: Duration = Duration::from_secs(120);
const IMAGE_TASK_TIMEOUT: Duration = Duration::from_secs(600);
const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const CLOUDFLARE_CHALLENGE_MARKER: &str = "ECRYPTEES_CLOUDFLARE_CHALLENGE:";
const MAX_DIAGNOSTIC_ENTRIES: usize = 160;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NetworkMode {
    Auto,
    SystemProxy,
    Direct,
}

impl NetworkMode {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" | "auto" => Ok(Self::Auto),
            "systemProxy" => Ok(Self::SystemProxy),
            "direct" => Ok(Self::Direct),
            _ => Err("Windows 网络模式无效".into()),
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Auto => "自动",
            Self::SystemProxy => "系统代理",
            Self::Direct => "仅直连/TUN",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AddressClass {
    Public,
    ClashFakeIp,
}

impl AddressClass {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Public => "公网",
            Self::ClashFakeIp => "Clash Fake-IP",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NetworkRoute {
    pub(crate) host: String,
    pub(crate) addresses: Vec<SocketAddr>,
    pub(crate) connection_addresses: Vec<SocketAddr>,
    pub(crate) class: AddressClass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NetworkKind {
    Html,
    Image,
}

impl NetworkKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "html" => Ok(Self::Html),
            "image" => Ok(Self::Image),
            _ => Err("网络任务类型无效".into()),
        }
    }

    fn maximum_bytes(self) -> u64 {
        match self {
            Self::Html => MAX_HTML_BYTES,
            Self::Image => MAX_IMAGE_BYTES,
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Html => HTML_TASK_TIMEOUT,
            Self::Image => IMAGE_TASK_TIMEOUT,
        }
    }

    fn accept(self) -> &'static str {
        match self {
            Self::Html => "text/html,application/xhtml+xml",
            Self::Image => "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Html => "HTML",
            Self::Image => "图片",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkStatus {
    state: String,
    final_url: String,
    content_type: String,
    content_length: i64,
    bytes_read: u64,
    error_code: String,
    error: String,
    diagnostics: Vec<String>,
}

impl Default for NetworkStatus {
    fn default() -> Self {
        Self {
            state: "queued".into(),
            final_url: String::new(),
            content_type: String::new(),
            content_length: -1,
            bytes_read: 0,
            error_code: String::new(),
            error: String::new(),
            diagnostics: Vec::new(),
        }
    }
}

struct NetworkTask {
    initial_url: Url,
    kind: NetworkKind,
    referer: Option<Url>,
    mode: NetworkMode,
    path: PathBuf,
    cancelled: AtomicBool,
    status: Mutex<NetworkStatus>,
}

impl NetworkTask {
    fn set_state(&self, value: &str) {
        if let Ok(mut status) = self.status.lock() {
            status.state = value.into();
        }
    }

    fn fail(&self, message: String) {
        if let Ok(mut status) = self.status.lock() {
            if let Some(detail) = message.strip_prefix(CLOUDFLARE_CHALLENGE_MARKER) {
                status.error_code = "cloudflareChallenge".into();
                status.error = detail.into();
            } else {
                status.error_code = classify_network_error_code(&message, self.mode).into();
                status.error = message;
            }
            status.state = if self.cancelled.load(Ordering::Acquire) {
                "cancelled".into()
            } else {
                "error".into()
            };
        }
        let _ = fs::remove_file(&self.path);
    }

    fn log(&self, message: impl Into<String>) {
        if let Ok(mut status) = self.status.lock()
            && status.diagnostics.len() < MAX_DIAGNOSTIC_ENTRIES
        {
            status.diagnostics.push(message.into());
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.set_state("cancelled");
    }

    fn check_cancelled(&self, deadline: Instant) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("请求已取消".into());
        }
        if Instant::now() >= deadline {
            return Err("网络任务总时间超限".into());
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct NetworkManager {
    directory: Mutex<Option<PathBuf>>,
    tasks: Arc<Mutex<HashMap<String, Arc<NetworkTask>>>>,
    active: Arc<AtomicUsize>,
}

impl NetworkManager {
    pub(crate) fn initialize(&self, temp_root: &Path) -> Result<(), String> {
        let directory = temp_root.join(NETWORK_TEMP_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|error| format!("无法创建网络临时目录：{error}"))?;
        clean_stale_files(&directory);
        *self
            .directory
            .lock()
            .map_err(|_| "无法锁定网络临时目录".to_string())? = Some(directory);
        Ok(())
    }

    fn directory(&self) -> Result<PathBuf, String> {
        self.directory
            .lock()
            .map_err(|_| "无法读取网络临时目录".to_string())?
            .clone()
            .ok_or_else(|| "桌面网络桥尚未初始化".to_string())
    }

    pub(crate) fn begin(
        &self,
        raw_url: &str,
        raw_kind: &str,
        raw_referer: &str,
        raw_mode: &str,
    ) -> Result<String, String> {
        let kind = NetworkKind::parse(raw_kind)?;
        let mode = NetworkMode::parse(raw_mode)?;
        let initial_url = normalize_https_url(raw_url)?;
        let referer = if raw_referer.trim().is_empty() {
            None
        } else {
            Some(normalize_https_url(raw_referer)?)
        };
        let directory = self.directory()?;
        if self.active.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE_TASKS {
            self.active.fetch_sub(1, Ordering::AcqRel);
            return Err("最多只能同时运行两个网络任务".into());
        }

        let token = Uuid::new_v4().to_string();
        let path = directory.join(format!("{token}{NETWORK_TEMP_SUFFIX}"));
        let task = Arc::new(NetworkTask {
            initial_url,
            kind,
            referer,
            mode,
            path,
            cancelled: AtomicBool::new(false),
            status: Mutex::new(NetworkStatus::default()),
        });
        let mut tasks = match self.tasks.lock() {
            Ok(tasks) => tasks,
            Err(_) => {
                self.active.fetch_sub(1, Ordering::AcqRel);
                return Err("无法锁定网络任务".into());
            }
        };
        tasks.insert(token.clone(), Arc::clone(&task));
        drop(tasks);
        let active = Arc::clone(&self.active);
        thread::spawn(move || {
            if let Err(error) = run_fetch(&task) {
                task.fail(error);
            }
            active.fetch_sub(1, Ordering::AcqRel);
        });
        Ok(token)
    }

    fn task(&self, token: &str) -> Result<Arc<NetworkTask>, String> {
        if Uuid::parse_str(token).is_err() {
            return Err("网络任务令牌无效".into());
        }
        self.tasks
            .lock()
            .map_err(|_| "无法读取网络任务".to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| "网络任务不存在或已经释放".to_string())
    }

    pub(crate) fn status(&self, token: &str) -> Result<NetworkStatus, String> {
        let task = self.task(token)?;
        let status = task
            .status
            .lock()
            .map_err(|_| "无法读取网络任务状态".to_string())?
            .clone();
        Ok(status)
    }

    pub(crate) fn read_chunk(
        &self,
        token: &str,
        offset: u64,
        requested_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        let task = self.task(token)?;
        let status = task
            .status
            .lock()
            .map_err(|_| "无法读取网络任务状态".to_string())?
            .clone();
        if status.state != "ready" {
            return Err("网络任务尚未完成".into());
        }
        if offset > status.bytes_read {
            return Err("网络分块偏移无效".into());
        }
        if offset == status.bytes_read {
            return Ok(Vec::new());
        }
        let length = requested_bytes.clamp(1, MAX_READ_CHUNK_BYTES);
        let remaining = status.bytes_read.saturating_sub(offset) as usize;
        let mut bytes = vec![0_u8; length.min(remaining)];
        let mut file =
            File::open(&task.path).map_err(|error| format!("无法读取网络临时文件：{error}"))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("无法定位网络分块：{error}"))?;
        file.read_exact(&mut bytes)
            .map_err(|error| format!("网络临时文件读取不完整：{error}"))?;
        Ok(bytes)
    }

    pub(crate) fn cancel(&self, token: &str) -> Result<(), String> {
        self.task(token)?.cancel();
        Ok(())
    }

    pub(crate) fn release(&self, token: &str) -> Result<(), String> {
        if Uuid::parse_str(token).is_err() {
            return Err("网络任务令牌无效".into());
        }
        let task = self
            .tasks
            .lock()
            .map_err(|_| "无法锁定网络任务".to_string())?
            .remove(token);
        if let Some(task) = task {
            task.cancel();
            let _ = fs::remove_file(&task.path);
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self) {
        let tasks = match self.tasks.lock() {
            Ok(mut tasks) => tasks.drain().map(|(_, task)| task).collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for task in tasks {
            task.cancel();
            let _ = fs::remove_file(&task.path);
        }
    }
}

#[tauri::command]
pub(crate) fn begin_desktop_network_fetch(
    url: String,
    kind: String,
    referer: String,
    mode: String,
    manager: tauri::State<'_, NetworkManager>,
) -> Result<String, String> {
    manager.begin(&url, &kind, &referer, &mode)
}

#[tauri::command]
pub(crate) fn get_desktop_network_status(
    token: String,
    manager: tauri::State<'_, NetworkManager>,
) -> Result<NetworkStatus, String> {
    manager.status(&token)
}

#[tauri::command]
pub(crate) fn read_desktop_network_chunk(
    token: String,
    offset: u64,
    requested_bytes: usize,
    manager: tauri::State<'_, NetworkManager>,
) -> Result<IpcResponse, String> {
    manager
        .read_chunk(&token, offset, requested_bytes)
        .map(IpcResponse::new)
}

#[tauri::command]
pub(crate) fn cancel_desktop_network_fetch(
    token: String,
    manager: tauri::State<'_, NetworkManager>,
) -> Result<(), String> {
    manager.cancel(&token)
}

#[tauri::command]
pub(crate) fn release_desktop_network_fetch(
    token: String,
    manager: tauri::State<'_, NetworkManager>,
) -> Result<(), String> {
    manager.release(&token)
}

fn run_fetch(task: &NetworkTask) -> Result<(), String> {
    task.set_state("running");
    let deadline = Instant::now() + task.kind.timeout();
    let mut current = task.initial_url.clone();
    for redirect_count in 0..=MAX_REDIRECTS {
        task.check_cancelled(deadline)?;
        let route = match classify_network_url(&current) {
            Ok(route) => route,
            Err(error) => {
                task.log(format!(
                    "拒绝 {} · {} · {}",
                    task.kind.label(),
                    current.host_str().unwrap_or("未知域名"),
                    error
                ));
                return Err(error);
            }
        };
        let transport = transport_label(task.mode, route.class);
        task.log(format_route_diagnostic(
            if redirect_count == 0 {
                "请求"
            } else {
                "重定向"
            },
            task.kind,
            &route,
            transport,
        ));
        let client = build_client(&current, &route, task.kind, task.mode)?;
        let mut request = client
            .get(current.clone())
            .header(USER_AGENT, "Ecryptees/1.1.5 Windows")
            .header(ACCEPT, task.kind.accept())
            .header(ACCEPT_ENCODING, "identity");
        if task.kind == NetworkKind::Image
            && let Some(referer) = &task.referer
        {
            request = request.header(REFERER, referer.as_str());
        }
        let response = request.send().map_err(map_reqwest_error)?;
        task.log(format!(
            "响应 {} · {} · HTTP {}",
            route.host,
            task.kind.label(),
            response.status().as_u16()
        ));
        if response
            .headers()
            .get("cf-mitigated")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("challenge"))
        {
            task.log(format!(
                "Cloudflare challenge · {} · 交给隔离 WebView2",
                route.host
            ));
            if let Ok(mut status) = task.status.lock() {
                status.final_url = current.to_string();
            }
            return Err(format!(
                "{CLOUDFLARE_CHALLENGE_MARKER}网页要求完成 Cloudflare 人机验证"
            ));
        }
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("网页重定向次数超过 5 次".into());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "网页重定向地址无效".to_string())?;
            current = normalize_https_url(
                current
                    .join(location)
                    .map_err(|_| "网页重定向地址无效".to_string())?
                    .as_str(),
            )?;
            let redirected = classify_network_url(&current)?;
            task.log(format_route_diagnostic(
                "重定向校验",
                task.kind,
                &redirected,
                transport_label(task.mode, redirected.class),
            ));
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        return stream_response(task, response, current, deadline);
    }
    Err("网页重定向次数超过 5 次".into())
}

fn stream_response(
    task: &NetworkTask,
    mut response: Response,
    final_url: Url,
    deadline: Instant,
) -> Result<(), String> {
    let maximum = task.kind.maximum_bytes();
    let declared_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared_length.is_some_and(|length| length > maximum) {
        return Err(size_limit_error(task.kind));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if task.kind == NetworkKind::Html
        && !content_type.is_empty()
        && !content_type.to_ascii_lowercase().starts_with("text/html")
        && !content_type
            .to_ascii_lowercase()
            .starts_with("application/xhtml+xml")
    {
        return Err("网页响应格式不是 HTML".into());
    }
    if let Ok(mut status) = task.status.lock() {
        status.final_url = final_url.into();
        status.content_type = content_type;
        status.content_length = declared_length.map_or(-1, |length| length as i64);
    }

    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&task.path)
        .map_err(map_temp_io_error)?;
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        task.check_cancelled(deadline)?;
        let count = response.read(&mut buffer).map_err(map_reqwest_io_error)?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > maximum {
            return Err(size_limit_error(task.kind));
        }
        output
            .write_all(&buffer[..count])
            .map_err(map_temp_io_error)?;
        if let Ok(mut status) = task.status.lock() {
            status.bytes_read = total;
        }
    }
    output.flush().map_err(map_temp_io_error)?;
    task.check_cancelled(deadline)?;
    if total == 0 {
        return Err("网络响应内容为空".into());
    }
    if let Ok(mut status) = task.status.lock() {
        status.content_length = total as i64;
        status.bytes_read = total;
        status.state = "ready".into();
    }
    Ok(())
}

fn build_client(
    url: &Url,
    route: &NetworkRoute,
    kind: NetworkKind,
    mode: NetworkMode,
) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "HTTPS 地址缺少主机名".to_string())?;
    let builder = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(kind.timeout())
        .resolve_to_addrs(host, &route.connection_addresses);
    let builder = if mode == NetworkMode::Direct
        || (mode == NetworkMode::Auto && route.class == AddressClass::ClashFakeIp)
    {
        builder.no_proxy()
    } else {
        builder
    };
    builder.build().map_err(map_reqwest_error)
}

pub(crate) fn normalize_https_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "请输入有效的 HTTPS 网页链接".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("只允许读取 HTTPS 网页".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网页地址不能包含用户名或密码".into());
    }
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn classify_network_url(url: &Url) -> Result<NetworkRoute, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "HTTPS 地址缺少主机名".to_string())?;
    let lowered = host.trim_end_matches('.').to_ascii_lowercase();
    if lowered == "localhost"
        || lowered.ends_with(".localhost")
        || lowered.ends_with(".local")
        || lowered.ends_with(".internal")
    {
        return Err("出于安全原因，不能读取本机或局域网地址".into());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let literal_ip = host.parse::<IpAddr>().ok();
    let mut addresses = if let Some(ip) = literal_ip {
        vec![SocketAddr::new(ip, port)]
    } else {
        (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("DNS 解析失败：{error}"))?
            .collect::<Vec<_>>()
    };
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err("DNS 没有返回可用地址".into());
    }
    classify_resolved_addresses(&lowered, literal_ip, addresses)
}

fn classify_resolved_addresses(
    host: &str,
    literal_ip: Option<IpAddr>,
    addresses: Vec<SocketAddr>,
) -> Result<NetworkRoute, String> {
    if literal_ip.is_some_and(is_benchmark_ip) {
        return Err("不能直接访问 Clash Fake-IP 或网络测试保留地址".into());
    }
    if addresses
        .iter()
        .any(|address| !is_public_ip(address.ip()) && !is_benchmark_ip(address.ip()))
    {
        return Err("出于安全原因，不能读取本机或局域网地址".into());
    }
    let fake_addresses = addresses
        .iter()
        .copied()
        .filter(|address| is_benchmark_ip(address.ip()))
        .collect::<Vec<_>>();
    let class = if fake_addresses.is_empty() {
        AddressClass::Public
    } else {
        AddressClass::ClashFakeIp
    };
    let connection_addresses = if class == AddressClass::ClashFakeIp {
        fake_addresses
    } else {
        addresses.clone()
    };
    Ok(NetworkRoute {
        host: host.into(),
        addresses,
        connection_addresses,
        class,
    })
}

fn transport_label(mode: NetworkMode, class: AddressClass) -> &'static str {
    match (mode, class) {
        (NetworkMode::Auto, AddressClass::ClashFakeIp) => "TUN/Fake-IP",
        (NetworkMode::Auto, AddressClass::Public) => "自动（系统代理或直连）",
        (NetworkMode::SystemProxy, _) => "系统代理",
        (NetworkMode::Direct, _) => "直连/TUN",
    }
}

fn format_route_diagnostic(
    phase: &str,
    kind: NetworkKind,
    route: &NetworkRoute,
    transport: &str,
) -> String {
    let addresses = route
        .addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{phase} {} · {} · DNS [{}] · {} · {}",
        kind.label(),
        route.host,
        addresses,
        route.class.label(),
        transport
    )
}

fn classify_network_error_code(message: &str, mode: NetworkMode) -> &'static str {
    if message.contains("DNS") {
        "dnsError"
    } else if message.contains("本机") || message.contains("局域网") || message.contains("保留地址")
    {
        "privateAddressBlocked"
    } else if message.contains("HTTP 403") {
        "httpForbidden"
    } else if message.contains("HTTP 429") {
        "rateLimited"
    } else if message.contains("证书") {
        "certificateError"
    } else if message.contains("超时") {
        "timeout"
    } else if message.contains("无法连接") && mode == NetworkMode::SystemProxy {
        "systemProxyUnavailable"
    } else if message.contains("无法连接") {
        "connectionFailed"
    } else {
        "networkError"
    }
}

fn is_benchmark_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        }
        IpAddr::V6(_) => false,
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    let in_global_unicast = (segments[0] & 0xe000) == 0x2000;
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let benchmarking = segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0;
    in_global_unicast && !documentation && !benchmarking
}

fn clean_stale_files(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let valid_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(NETWORK_TEMP_SUFFIX))
            .is_some_and(|token| Uuid::parse_str(token).is_ok());
        let stale = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_TEMP_AGE);
        if valid_name && stale {
            let _ = fs::remove_file(path);
        }
    }
}

fn size_limit_error(kind: NetworkKind) -> String {
    match kind {
        NetworkKind::Html => "网页 HTML 不能超过 5 MiB".into(),
        NetworkKind::Image => "单张图片不能超过 500 MiB".into(),
    }
}

fn map_reqwest_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "网络超时".into()
    } else if error.is_connect() {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("certificate") || text.contains("cert") || text.contains("tls") {
            "HTTPS 证书验证失败".into()
        } else {
            format!("无法连接目标网站：{error}")
        }
    } else {
        format!("网络请求失败：{error}")
    }
}

fn map_reqwest_io_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::TimedOut {
        "网络读取超时".into()
    } else {
        format!("网络读取失败：{error}")
    }
}

fn map_temp_io_error(error: std::io::Error) -> String {
    if error.raw_os_error() == Some(112) {
        "网络临时目录空间不足".into()
    } else {
        format!("无法写入网络临时文件：{error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_urls_reject_credentials_and_non_https_schemes() {
        assert!(normalize_https_url("https://example.com/book").is_ok());
        assert!(normalize_https_url("http://example.com/book").is_err());
        assert!(normalize_https_url("https://user:secret@example.com/book").is_err());
    }

    #[test]
    fn private_and_special_ipv4_addresses_are_rejected() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
        ] {
            assert!(!is_public_ip(value.parse().unwrap()), "{value}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_benchmark_ip("198.18.0.1".parse().unwrap()));
        assert!(is_benchmark_ip("198.19.255.254".parse().unwrap()));
        assert!(!is_benchmark_ip("198.20.0.1".parse().unwrap()));
    }

    #[test]
    fn cloudflare_challenge_has_a_machine_readable_error_code() {
        let task = NetworkTask {
            initial_url: Url::parse("https://example.com/").unwrap(),
            kind: NetworkKind::Html,
            referer: None,
            mode: NetworkMode::Auto,
            path: PathBuf::from("missing-network-test.part"),
            cancelled: AtomicBool::new(false),
            status: Mutex::new(NetworkStatus::default()),
        };
        task.fail(format!(
            "{CLOUDFLARE_CHALLENGE_MARKER}网页要求完成 Cloudflare 人机验证"
        ));
        let status = task.status.lock().unwrap();
        assert_eq!(status.error_code, "cloudflareChallenge");
        assert_eq!(status.error, "网页要求完成 Cloudflare 人机验证");
    }

    #[test]
    fn local_and_special_ipv6_addresses_are_rejected() {
        for value in ["::", "::1", "fe80::1", "fc00::1", "2001:db8::1", "ff02::1"] {
            assert!(!is_public_ip(value.parse().unwrap()), "{value}");
        }
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn fake_ip_is_allowed_only_when_it_came_from_a_domain() {
        let literal = Url::parse("https://198.18.0.1/book").unwrap();
        assert!(classify_network_url(&literal).is_err());
        let route = classify_resolved_addresses(
            "reader.example",
            None,
            vec!["198.18.0.7:443".parse().unwrap()],
        )
        .unwrap();
        assert_eq!(route.class, AddressClass::ClashFakeIp);
        assert_eq!(route.connection_addresses, route.addresses);
        assert_eq!(NetworkMode::parse("auto").unwrap(), NetworkMode::Auto);
        assert_eq!(
            NetworkMode::parse("systemProxy").unwrap(),
            NetworkMode::SystemProxy
        );
        assert_eq!(NetworkMode::parse("direct").unwrap(), NetworkMode::Direct);
    }
}
