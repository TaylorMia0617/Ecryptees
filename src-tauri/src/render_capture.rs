use crate::network::{
    AddressClass, NetworkMode, NetworkRoute, classify_network_url, normalize_https_url,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::ipc::Response as IpcResponse;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;
use uuid::Uuid;

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::*;
#[cfg(windows)]
use webview2_com::{PermissionRequestedEventHandler, WebResourceRequestedEventHandler};
#[cfg(windows)]
use windows::Win32::System::Com::CoTaskMemFree;
#[cfg(windows)]
use windows::core::{HSTRING, Interface, PWSTR};

const CAPTURE_TEMP_DIRECTORY: &str = "ecryptees-render-capture-v1";
const CAPTURE_EVENT_NAME: &str = "ecryptees-capture-message";
const MAX_CAPTURE_PAGES: usize = 80;
const MAX_CAPTURE_BYTES: u64 = 500 * 1024 * 1024;
const MAX_CAPTURE_CHUNK_BYTES: usize = 192 * 1024;
const MAX_READ_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_NAVIGATIONS: usize = 5;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(150);
const STALE_CAPTURE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const RENDER_CAPTURE_SCRIPT: &str = include_str!("../../js/render-capture.js");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderedImageStatus {
    index: usize,
    captured_index: i64,
    source_url: String,
    name: String,
    mime: String,
    size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderCaptureStatus {
    state: String,
    final_url: String,
    images: Vec<RenderedImageStatus>,
    bytes_written: u64,
    error_code: String,
    error: String,
    diagnostics: Vec<String>,
}

impl Default for RenderCaptureStatus {
    fn default() -> Self {
        Self {
            state: "running".into(),
            final_url: String::new(),
            images: Vec::new(),
            bytes_written: 0,
            error_code: String::new(),
            error: String::new(),
            diagnostics: Vec::new(),
        }
    }
}

struct CapturedImage {
    source_url: String,
    name: String,
    mime: String,
    expected_size: u64,
    written: u64,
    path: Option<PathBuf>,
    complete: bool,
}

struct RenderCaptureTaskState {
    status: RenderCaptureStatus,
    images: Vec<CapturedImage>,
    navigations: usize,
    diagnostic_keys: HashSet<String>,
}

struct RenderCaptureTask {
    token: String,
    label: String,
    initial_origin: String,
    maximum: usize,
    interactive_verification: bool,
    mode: NetworkMode,
    root: PathBuf,
    browser_directory: PathBuf,
    image_directory: PathBuf,
    state: Mutex<RenderCaptureTaskState>,
    route_cache: Mutex<HashMap<String, Result<NetworkRoute, String>>>,
}

impl RenderCaptureTask {
    fn fail(&self, message: impl Into<String>) {
        if let Ok(mut state) = self.state.lock()
            && (state.status.state == "running"
                || state.status.state == "checkingChallenge"
                || state.status.state == "awaitingVerification")
        {
            state.status.state = "error".into();
            let message = message.into();
            state.status.error_code = classify_capture_error_code(&message).into();
            state.status.error = classify_capture_error(&message);
        }
    }

    fn route(&self, url: &Url) -> Result<NetworkRoute, String> {
        let key = format!(
            "{}:{}",
            url.host_str()
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_ascii_lowercase(),
            url.port_or_known_default().unwrap_or(443)
        );
        if let Ok(cache) = self.route_cache.lock()
            && let Some(result) = cache.get(&key)
        {
            return result.clone();
        }
        let result = classify_network_url(url);
        if let Ok(mut cache) = self.route_cache.lock() {
            cache.insert(key, result.clone());
        }
        result
    }

    fn log_route(&self, phase: &str, route: &NetworkRoute, allowed: bool) {
        let key = format!("{phase}:{}:{}", route.host, route.class.label());
        let addresses = route
            .addresses
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        self.log_once(
            key,
            format!(
                "{phase} · {} · DNS [{}] · {} · {} · {}",
                route.host,
                addresses,
                route.class.label(),
                self.mode.label(),
                if allowed { "允许" } else { "拒绝" }
            ),
        );
    }

    fn log_rejection(&self, phase: &str, raw_url: &str, reason: &str) {
        let host = Url::parse(raw_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "无效地址".into());
        self.log_once(
            format!("{phase}:{host}:{reason}"),
            format!("{phase} · {host} · 拒绝 · {reason}"),
        );
    }

    fn log_once(&self, key: String, message: String) {
        if let Ok(mut state) = self.state.lock()
            && state.status.diagnostics.len() < 160
            && state.diagnostic_keys.insert(key)
        {
            state.status.diagnostics.push(message);
        }
    }

    fn status(&self) -> Result<RenderCaptureStatus, String> {
        self.state
            .lock()
            .map(|state| state.status.clone())
            .map_err(|_| "无法读取动态网页任务状态".to_string())
    }
}

#[derive(Default)]
struct RenderCaptureManagerInner {
    directory: Mutex<Option<PathBuf>>,
    tasks: Mutex<HashMap<String, Arc<RenderCaptureTask>>>,
}

#[derive(Clone, Default)]
pub(crate) struct RenderCaptureManager {
    inner: Arc<RenderCaptureManagerInner>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderCaptureMessage {
    token: String,
    label: String,
    action: String,
    #[serde(default)]
    index: usize,
    #[serde(default)]
    order: usize,
    #[serde(default)]
    source: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    chunk: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    count: usize,
    #[serde(default)]
    error: String,
}

impl RenderCaptureManager {
    pub(crate) fn initialize(&self, temp_root: &Path) -> Result<(), String> {
        let directory = temp_root.join(CAPTURE_TEMP_DIRECTORY);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建动态网页临时目录：{error}"))?;
        clean_stale_capture_directories(&directory);
        *self
            .inner
            .directory
            .lock()
            .map_err(|_| "无法锁定动态网页临时目录".to_string())? = Some(directory);
        Ok(())
    }

    fn directory(&self) -> Result<PathBuf, String> {
        self.inner
            .directory
            .lock()
            .map_err(|_| "无法读取动态网页临时目录".to_string())?
            .clone()
            .ok_or_else(|| "动态网页分析尚未初始化".to_string())
    }

    fn task(&self, token: &str) -> Result<Arc<RenderCaptureTask>, String> {
        if Uuid::parse_str(token).is_err() {
            return Err("动态网页任务令牌无效".into());
        }
        self.inner
            .tasks
            .lock()
            .map_err(|_| "无法读取动态网页任务".to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| "动态网页任务不存在或已经释放".to_string())
    }

    pub(crate) fn begin(
        &self,
        app: &AppHandle,
        raw_url: &str,
        maximum: usize,
        interactive_verification: bool,
        raw_mode: &str,
    ) -> Result<String, String> {
        let initial_url = normalize_https_url(raw_url)?;
        let mode = NetworkMode::parse(raw_mode)?;
        let initial_route = classify_network_url(&initial_url)?;
        let origin = initial_url.origin().ascii_serialization();
        let maximum = maximum.clamp(1, MAX_CAPTURE_PAGES);
        let token = Uuid::new_v4().to_string();
        let label = format!("capture-{token}");
        let root = self.directory()?.join(&token);
        let browser_directory = root.join("browser");
        let image_directory = root.join("images");
        fs::create_dir_all(&browser_directory)
            .and_then(|_| fs::create_dir_all(&image_directory))
            .map_err(|error| format!("无法创建动态网页临时空间：{error}"))?;
        let task = Arc::new(RenderCaptureTask {
            token: token.clone(),
            label: label.clone(),
            initial_origin: origin,
            maximum,
            interactive_verification,
            mode,
            root,
            browser_directory: browser_directory.clone(),
            image_directory,
            state: Mutex::new(RenderCaptureTaskState {
                status: RenderCaptureStatus {
                    state: if interactive_verification {
                        "checkingChallenge".into()
                    } else {
                        "running".into()
                    },
                    final_url: initial_url.to_string(),
                    ..RenderCaptureStatus::default()
                },
                images: Vec::new(),
                navigations: 0,
                diagnostic_keys: HashSet::new(),
            }),
            route_cache: Mutex::new(HashMap::new()),
        });
        task.log_route("主页面", &initial_route, true);
        self.inner
            .tasks
            .lock()
            .map_err(|_| "无法锁定动态网页任务".to_string())?
            .insert(token.clone(), Arc::clone(&task));

        if let Err(error) = self.build_capture_window(app, &task, initial_url) {
            self.inner
                .tasks
                .lock()
                .ok()
                .and_then(|mut tasks| tasks.remove(&token));
            let _ = fs::remove_dir_all(&task.root);
            return Err(error);
        }

        let timeout_manager = self.clone();
        let timeout_app = app.clone();
        let timeout_token = token.clone();
        thread::spawn(move || {
            thread::sleep(CAPTURE_TIMEOUT);
            if let Ok(task) = timeout_manager.task(&timeout_token)
                && task.status().is_ok_and(|status| {
                    status.state == "running"
                        || status.state == "checkingChallenge"
                        || status.state == "awaitingVerification"
                })
            {
                task.fail(if task.interactive_verification {
                    "网页验证未完成或已经超时"
                } else {
                    "动态网页分析超过 150 秒，任务已停止"
                });
                close_capture_window(&timeout_app, &task);
            }
        });
        if task.interactive_verification {
            let reveal_manager = self.clone();
            let reveal_app = app.clone();
            let reveal_token = token.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(8));
                if let Ok(task) = reveal_manager.task(&reveal_token)
                    && let Ok(mut state) = task.state.lock()
                    && state.status.state == "checkingChallenge"
                {
                    state.status.state = "awaitingVerification".into();
                    drop(state);
                    if let Some(window) = reveal_app.get_webview_window(&task.label) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
        }
        Ok(token)
    }

    fn build_capture_window(
        &self,
        app: &AppHandle,
        task: &Arc<RenderCaptureTask>,
        initial_url: Url,
    ) -> Result<(), String> {
        let init_script = capture_initialization_script(task);
        let navigation_task = Arc::clone(task);
        let page_task = Arc::clone(task);
        let manager = self.clone();
        let builder = WebviewWindowBuilder::new(
            app,
            &task.label,
            WebviewUrl::External(Url::parse("about:blank").expect("valid about:blank URL")),
        )
        .data_directory(task.browser_directory.clone())
        .initialization_script(init_script)
        .on_navigation(move |url| validate_capture_navigation(&navigation_task, url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
        let direct_webview = task.mode == NetworkMode::Direct
            || (task.mode == NetworkMode::Auto
                && task
                    .route(&initial_url)
                    .is_ok_and(|route| route.class == AddressClass::ClashFakeIp));
        let builder = if direct_webview {
            builder.additional_browser_args(
                "--no-proxy-server --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
            )
        } else {
            builder
        };
        let page_script = capture_page_script(task);
        let builder = if task.interactive_verification {
            builder
                .title("Ecryptees 网页验证")
                .inner_size(980.0, 720.0)
                .center()
                .visible(false)
                .focused(false)
                .decorations(true)
                .skip_taskbar(false)
        } else {
            builder
                .title("Ecryptees isolated capture")
                .visible(false)
                .focused(false)
                .decorations(false)
                .skip_taskbar(true)
        };
        let window = builder
            .on_page_load(move |window, payload| {
                if payload.url().scheme() != "https" {
                    return;
                }
                manager.update_final_url(&page_task.token, payload.url());
                if payload.event() == PageLoadEvent::Finished
                    && let Err(error) = window.eval(&page_script)
                {
                    page_task.fail(format!("网页阻止了自动分析：{error}"));
                    close_capture_window(window.app_handle(), &page_task);
                }
            })
            .build()
            .map_err(|error| format!("无法启动隔离 WebView2：{error}"))?;

        let security_task = Arc::clone(task);
        let security_app = app.clone();
        window
            .with_webview(move |webview| {
                if let Err(error) = install_webview_security(webview, &initial_url, &security_task)
                {
                    security_task.fail(error);
                    close_capture_window(&security_app, &security_task);
                }
            })
            .map_err(|error| format!("无法配置隔离 WebView2：{error}"))?;
        Ok(())
    }

    fn update_final_url(&self, token: &str, url: &Url) {
        if let Ok(task) = self.task(token)
            && let Ok(mut state) = task.state.lock()
        {
            state.status.final_url = url.to_string();
        }
    }

    pub(crate) fn process_payload(&self, app: &AppHandle, payload: &str) {
        let Ok(message) = serde_json::from_str::<RenderCaptureMessage>(payload) else {
            return;
        };
        let Ok(task) = self.task(&message.token) else {
            return;
        };
        if message.label != task.label {
            return;
        }
        if let Err(error) = process_capture_message(app, &task, message) {
            task.fail(error);
            close_capture_window(app, &task);
        }
    }

    pub(crate) fn window_destroyed(&self, label: &str) {
        if !label.starts_with("capture-") {
            return;
        }
        let task = self
            .inner
            .tasks
            .lock()
            .ok()
            .and_then(|tasks| tasks.values().find(|task| task.label == label).cloned());
        if let Some(task) = task {
            task.fail(if task.interactive_verification {
                "用户关闭了网页验证窗口"
            } else {
                "动态网页窗口已经关闭"
            });
            schedule_directory_cleanup(task.browser_directory.clone());
        }
    }

    pub(crate) fn status(&self, token: &str) -> Result<RenderCaptureStatus, String> {
        self.task(token)?.status()
    }

    pub(crate) fn read_chunk(
        &self,
        token: &str,
        index: usize,
        offset: u64,
        requested_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        let task = self.task(token)?;
        let state = task
            .state
            .lock()
            .map_err(|_| "无法读取动态网页图片".to_string())?;
        let image = state
            .images
            .get(index)
            .ok_or_else(|| "动态网页图片序号无效".to_string())?;
        if !image.complete || image.path.is_none() {
            return Err("动态网页图片尚未写入完成".into());
        }
        if offset > image.written {
            return Err("动态网页图片分块偏移无效".into());
        }
        if offset == image.written {
            return Ok(Vec::new());
        }
        let path = image.path.clone().expect("checked path");
        let remaining = image.written.saturating_sub(offset) as usize;
        drop(state);
        let mut bytes = vec![
            0_u8;
            requested_bytes
                .clamp(1, MAX_READ_CHUNK_BYTES)
                .min(remaining)
        ];
        let mut file =
            File::open(path).map_err(|error| format!("无法读取动态网页图片：{error}"))?;
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|error| format!("动态网页图片读取不完整：{error}"))?;
        Ok(bytes)
    }

    pub(crate) fn release(&self, app: &AppHandle, token: &str) -> Result<(), String> {
        if Uuid::parse_str(token).is_err() {
            return Err("动态网页任务令牌无效".into());
        }
        let task = self
            .inner
            .tasks
            .lock()
            .map_err(|_| "无法锁定动态网页任务".to_string())?
            .remove(token);
        if let Some(task) = task {
            close_capture_window(app, &task);
            schedule_directory_cleanup(task.root.clone());
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self, app: &AppHandle) {
        let tasks = self
            .inner
            .tasks
            .lock()
            .map(|mut tasks| tasks.drain().map(|(_, task)| task).collect::<Vec<_>>())
            .unwrap_or_default();
        for task in tasks {
            close_capture_window(app, &task);
            schedule_directory_cleanup(task.root.clone());
        }
    }
}

fn capture_initialization_script(task: &RenderCaptureTask) -> String {
    let token = serde_json::to_string(&task.token).expect("serializable capture token");
    let label = serde_json::to_string(&task.label).expect("serializable capture label");
    format!(
        r#"(() => {{
            if (window.top !== window) return;
            const token = {token};
            const label = {label};
            const send = (action, details = {{}}) => window.__TAURI__.event.emit(
                '{CAPTURE_EVENT_NAME}',
                {{ token, label, action, ...details }}
            );
            window.__ECRYPTEES_CAPTURE_TOKEN__ = token;
            window.__ECRYPTEES_CAPTURE_MAXIMUM__ = {maximum};
            window.AndroidRenderedCapture = Object.freeze({{
                getRenderedImageCount: () => 0,
                navigateRenderedPage: (_, url) => send('navigate', {{ url }}).then(() => true),
                addRenderedPageSource: (_, source) => send('addSource', {{ source }}).then(() => true),
                beginRenderedImage: (_, order, name, mime, size) => send(
                    'beginImage', {{ index: Number(order), order: Number(order), name, mime, size: Number(size) }}
                ).then(() => Number(order)),
                writeRenderedImageChunk: (_, index, chunk) => send(
                    'writeImageChunk', {{ index: Number(index), chunk }}
                ).then(() => true),
                finishRenderedImage: (_, index) => send('finishImage', {{ index: Number(index) }}).then(() => true),
                finishRenderedPage: (_, count) => send('finishPage', {{ count: Number(count) }}).then(() => true),
                failRenderedPage: (_, error) => send('fail', {{ error: String(error || '') }}).then(() => true)
            }});
        }})();"#,
        maximum = task.maximum
    )
}

fn capture_page_script(task: &RenderCaptureTask) -> String {
    if !task.interactive_verification {
        return RENDER_CAPTURE_SCRIPT.into();
    }
    let token = serde_json::to_string(&task.token).expect("serializable capture token");
    let label = serde_json::to_string(&task.label).expect("serializable capture label");
    format!(
        r#"(async () => {{
            const challenged = /just a moment|请稍候|安全验证|security verification/i.test(document.title || '')
                || !!document.querySelector('#challenge-stage, #challenge-form, #challenge-running, form[action*="challenge"], script[src*="challenge-platform"]');
            if (challenged) return;
            await window.__TAURI__.event.emit(
                '{CAPTURE_EVENT_NAME}',
                {{ token: {token}, label: {label}, action: 'pageReady' }}
            );
            {RENDER_CAPTURE_SCRIPT}
        }})();"#
    )
}

fn validate_capture_navigation(task: &RenderCaptureTask, url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let normalized = match normalize_https_url(url.as_str()) {
        Ok(url) => url,
        Err(error) => {
            task.log_rejection("页面导航", url.as_str(), &error);
            task.fail("网页重定向到了不允许的地址");
            return false;
        }
    };
    match task.route(&normalized) {
        Ok(route) => task.log_route("页面导航", &route, true),
        Err(error) => {
            task.log_rejection("页面导航", url.as_str(), &error);
            task.fail(format!("网页重定向被阻止：{error}"));
            return false;
        }
    }
    let Ok(mut state) = task.state.lock() else {
        return false;
    };
    if state.navigations > MAX_NAVIGATIONS {
        state.status.state = "error".into();
        state.status.error = "网页重定向次数超过 5 次".into();
        return false;
    }
    state.navigations += 1;
    true
}

fn process_capture_message(
    app: &AppHandle,
    task: &Arc<RenderCaptureTask>,
    message: RenderCaptureMessage,
) -> Result<(), String> {
    if message.action == "pageReady" {
        let mut state = task
            .state
            .lock()
            .map_err(|_| "无法更新网页验证状态".to_string())?;
        if state.status.state == "checkingChallenge" || state.status.state == "awaitingVerification"
        {
            state.status.state = "running".into();
        }
        return Ok(());
    }
    if task.status()?.state != "running" {
        return Err("动态网页任务已经结束".into());
    }
    match message.action.as_str() {
        "navigate" => navigate_capture_page(app, task, &message.url),
        "addSource" => add_capture_source(task, &message.source),
        "beginImage" => begin_capture_image(task, &message),
        "writeImageChunk" => write_capture_chunk(task, message.index, &message.chunk),
        "finishImage" => finish_capture_image(task, message.index),
        "finishPage" => finish_capture_page(app, task, message.count),
        "fail" => Err(message.error),
        _ => Err("动态网页捕获消息无效".into()),
    }
}

fn navigate_capture_page(
    app: &AppHandle,
    task: &RenderCaptureTask,
    raw_url: &str,
) -> Result<(), String> {
    let url = normalize_https_url(raw_url)?;
    let route = task.route(&url)?;
    task.log_route("阅读器翻页", &route, true);
    if url.origin().ascii_serialization() != task.initial_origin {
        return Err("动态网页只能在原网站内切换阅读页面".into());
    }
    app.get_webview_window(&task.label)
        .ok_or_else(|| "隔离网页窗口已经关闭".to_string())?
        .navigate(url)
        .map_err(|error| format!("无法切换动态阅读页面：{error}"))
}

fn add_capture_source(task: &RenderCaptureTask, raw_source: &str) -> Result<(), String> {
    let source = normalize_https_url(raw_source)?;
    let route = task.route(&source)?;
    task.log_route("漫画图片", &route, true);
    let mut state = task
        .state
        .lock()
        .map_err(|_| "无法写入动态网页图片地址".to_string())?;
    if state.images.len() >= task.maximum {
        return Err("动态网页图片数量超过限制".into());
    }
    if state
        .images
        .iter()
        .any(|image| image.source_url == source.as_str())
    {
        return Ok(());
    }
    let index = state.images.len();
    state.images.push(CapturedImage {
        source_url: source.to_string(),
        name: format!("page-{:03}.jpg", index + 1),
        mime: String::new(),
        expected_size: 0,
        written: 0,
        path: None,
        complete: true,
    });
    state.status.images.push(RenderedImageStatus {
        index,
        captured_index: -1,
        source_url: source.to_string(),
        name: format!("page-{:03}.jpg", index + 1),
        mime: String::new(),
        size: 0,
    });
    Ok(())
}

fn begin_capture_image(
    task: &RenderCaptureTask,
    message: &RenderCaptureMessage,
) -> Result<(), String> {
    let mut state = task
        .state
        .lock()
        .map_err(|_| "无法创建动态网页图片".to_string())?;
    let index = state.images.len();
    if index >= task.maximum || message.index != index || message.order != index {
        return Err("动态网页图片顺序无效".into());
    }
    if message.size == 0
        || state.status.bytes_written.saturating_add(message.size) > MAX_CAPTURE_BYTES
    {
        return Err("漫画原图总体积不能超过 500 MiB".into());
    }
    let mime = message.mime.trim().to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return Err("动态网页返回了非图片内容".into());
    }
    let name = sanitize_capture_name(&message.name, index, &mime);
    let path = task.image_directory.join(format!("image-{index:03}.part"));
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(map_capture_io_error)?;
    state.images.push(CapturedImage {
        source_url: String::new(),
        name,
        mime,
        expected_size: message.size,
        written: 0,
        path: Some(path),
        complete: false,
    });
    Ok(())
}

fn write_capture_chunk(
    task: &RenderCaptureTask,
    index: usize,
    encoded: &str,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "动态网页图片分块编码无效".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_CAPTURE_CHUNK_BYTES {
        return Err("动态网页图片分块大小无效".into());
    }
    let mut state = task
        .state
        .lock()
        .map_err(|_| "无法写入动态网页图片".to_string())?;
    let image = state
        .images
        .get_mut(index)
        .ok_or_else(|| "动态网页图片序号无效".to_string())?;
    if image.complete
        || image.path.is_none()
        || image.written.saturating_add(bytes.len() as u64) > image.expected_size
    {
        return Err("动态网页图片分块超出声明大小".into());
    }
    let path = image.path.clone().expect("checked capture path");
    OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(map_capture_io_error)?;
    image.written += bytes.len() as u64;
    state.status.bytes_written += bytes.len() as u64;
    Ok(())
}

fn finish_capture_image(task: &RenderCaptureTask, index: usize) -> Result<(), String> {
    let mut state = task
        .state
        .lock()
        .map_err(|_| "无法完成动态网页图片".to_string())?;
    let image = state
        .images
        .get_mut(index)
        .ok_or_else(|| "动态网页图片序号无效".to_string())?;
    if image.complete || image.written != image.expected_size {
        return Err("动态网页图片写入不完整".into());
    }
    image.complete = true;
    let name = image.name.clone();
    let mime = image.mime.clone();
    let size = image.written;
    state.status.images.push(RenderedImageStatus {
        index,
        captured_index: index as i64,
        source_url: String::new(),
        name,
        mime,
        size,
    });
    Ok(())
}

fn finish_capture_page(
    app: &AppHandle,
    task: &Arc<RenderCaptureTask>,
    count: usize,
) -> Result<(), String> {
    let mut state = task
        .state
        .lock()
        .map_err(|_| "无法完成动态网页任务".to_string())?;
    if count == 0 || count != state.images.len() || state.images.iter().any(|image| !image.complete)
    {
        return Err("页面运行完成后仍未找到漫画图片".into());
    }
    state.status.state = "ready".into();
    drop(state);
    close_capture_window(app, task);
    Ok(())
}

fn sanitize_capture_name(raw: &str, index: usize, mime: &str) -> String {
    let candidate = Path::new(raw.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && name.len() <= 180)
        .map(str::to_string);
    candidate.unwrap_or_else(|| {
        let extension = if mime.contains("png") {
            "png"
        } else if mime.contains("webp") {
            "webp"
        } else {
            "jpg"
        };
        format!("page-{:03}.{extension}", index + 1)
    })
}

fn classify_capture_error(message: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        "网页阻止了自动分析".into()
    } else if message.contains("captcha") || message.contains("验证") || message.contains("登录")
    {
        "网页需要登录或人机验证，无法自动读取".into()
    } else {
        message.to_string()
    }
}

fn classify_capture_error_code(message: &str) -> &'static str {
    if message.contains("本机")
        || message.contains("局域网")
        || message.contains("保留地址")
        || message.contains("被阻止")
    {
        "webviewResourceBlocked"
    } else if message.contains("验证") || message.contains("captcha") {
        "cloudflareChallenge"
    } else if message.contains("超时") {
        "timeout"
    } else if message.contains("仍未找到") || message.contains("没有找到") {
        "noImages"
    } else {
        "renderCaptureError"
    }
}

fn close_capture_window(app: &AppHandle, task: &RenderCaptureTask) {
    if let Some(window) = app.get_webview_window(&task.label) {
        let _ = window.close();
    }
    schedule_directory_cleanup(task.browser_directory.clone());
}

fn schedule_directory_cleanup(directory: PathBuf) {
    thread::spawn(move || {
        for _ in 0..12 {
            if !directory.exists() || fs::remove_dir_all(&directory).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

fn clean_stale_capture_directories(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let valid_name = entry
            .file_name()
            .to_str()
            .is_some_and(|name| Uuid::parse_str(name).is_ok());
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_CAPTURE_AGE);
        if valid_name && stale && path.is_dir() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn map_capture_io_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::StorageFull {
        "临时空间不足，无法保存动态网页图片".into()
    } else {
        format!("无法写入动态网页临时文件：{error}")
    }
}

#[cfg(windows)]
fn install_webview_security(
    webview: tauri::webview::PlatformWebview,
    initial_url: &Url,
    task: &Arc<RenderCaptureTask>,
) -> Result<(), String> {
    let controller = webview.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("无法取得 WebView2 控制器：{error}"))?;
    let environment = webview.environment();
    unsafe {
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetAreDevToolsEnabled(false);
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetIsStatusBarEnabled(false);
            if let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = settings4.SetIsGeneralAutofillEnabled(false);
            }
            if let Ok(settings5) = settings.cast::<ICoreWebView2Settings5>() {
                let _ = settings5.SetIsPasswordAutosaveEnabled(false);
            }
        }

        let mut permission_token = 0_i64;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut permission_token,
        )
        .map_err(|error| format!("无法禁用网页系统权限：{error}"))?;

        core.AddWebResourceRequestedFilter(
            &HSTRING::from("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        )
        .map_err(|error| format!("无法启用网页资源安全过滤：{error}"))?;
        let filter_environment = environment.clone();
        let filter_task = Arc::clone(task);
        let mut resource_token = 0_i64;
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let request = args.Request()?;
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
                args.ResourceContext(&mut context)?;
                let mut raw_uri = PWSTR::null();
                request.Uri(&mut raw_uri)?;
                let uri = raw_uri.to_string().unwrap_or_default();
                CoTaskMemFree(Some(raw_uri.0.cast()));
                if !capture_resource_allowed(
                    &filter_task,
                    &uri,
                    web_resource_context_label(context),
                ) {
                    let response = filter_environment.CreateWebResourceResponse(
                        None,
                        403,
                        &HSTRING::from("Forbidden"),
                        &HSTRING::from("Content-Type: text/plain; charset=utf-8"),
                    )?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            })),
            &mut resource_token,
        )
        .map_err(|error| format!("无法安装网页资源安全过滤：{error}"))?;

        core.Navigate(&HSTRING::from(initial_url.as_str()))
            .map_err(|error| format!("无法加载动态网页：{error}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_webview_security(
    _: tauri::webview::PlatformWebview,
    _: &Url,
    _: &Arc<RenderCaptureTask>,
) -> Result<(), String> {
    Err("动态网页分析只在 Windows 版启用".into())
}

#[cfg(windows)]
fn web_resource_context_label(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "文档",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "样式",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "图片",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "媒体",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "字体",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "脚本",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "XHR/API",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "Fetch/API",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "WebSocket",
        _ => "其他资源",
    }
}

fn capture_resource_allowed(task: &RenderCaptureTask, raw_url: &str, context: &str) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };
    match url.scheme() {
        "https" => {
            let normalized = match normalize_https_url(raw_url) {
                Ok(url) => url,
                Err(error) => {
                    task.log_rejection(&format!("WebView2 {context}"), raw_url, &error);
                    return false;
                }
            };
            match task.route(&normalized) {
                Ok(route) => {
                    task.log_route(&format!("WebView2 {context}"), &route, true);
                    true
                }
                Err(error) => {
                    task.log_rejection(&format!("WebView2 {context}"), raw_url, &error);
                    false
                }
            }
        }
        "blob" | "data" => true,
        "about" => raw_url == "about:blank",
        _ => false,
    }
}

#[tauri::command]
pub(crate) fn begin_desktop_rendered_page_capture(
    app: AppHandle,
    url: String,
    maximum: usize,
    interactive_verification: bool,
    mode: String,
    manager: tauri::State<'_, RenderCaptureManager>,
) -> Result<String, String> {
    manager.begin(&app, &url, maximum, interactive_verification, &mode)
}

#[tauri::command]
pub(crate) fn get_desktop_rendered_page_capture_status(
    token: String,
    manager: tauri::State<'_, RenderCaptureManager>,
) -> Result<RenderCaptureStatus, String> {
    manager.status(&token)
}

#[tauri::command]
pub(crate) fn read_desktop_rendered_page_image_chunk(
    token: String,
    index: usize,
    offset: u64,
    requested_bytes: usize,
    manager: tauri::State<'_, RenderCaptureManager>,
) -> Result<IpcResponse, String> {
    manager
        .read_chunk(&token, index, offset, requested_bytes)
        .map(IpcResponse::new)
}

#[tauri::command]
pub(crate) fn release_desktop_rendered_page_capture(
    app: AppHandle,
    token: String,
    manager: tauri::State<'_, RenderCaptureManager>,
) -> Result<(), String> {
    manager.release(&app, &token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_task() -> RenderCaptureTask {
        RenderCaptureTask {
            token: Uuid::new_v4().to_string(),
            label: "capture-test".into(),
            initial_origin: "https://example.com".into(),
            maximum: 80,
            interactive_verification: false,
            mode: NetworkMode::Auto,
            root: PathBuf::from("capture-test"),
            browser_directory: PathBuf::from("capture-test/browser"),
            image_directory: PathBuf::from("capture-test/images"),
            state: Mutex::new(RenderCaptureTaskState {
                status: RenderCaptureStatus::default(),
                images: Vec::new(),
                navigations: 0,
                diagnostic_keys: HashSet::new(),
            }),
            route_cache: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn capture_resource_policy_blocks_local_and_non_https_urls() {
        let task = test_task();
        assert!(!capture_resource_allowed(
            &task,
            "http://example.com/image.jpg",
            "图片"
        ));
        assert!(!capture_resource_allowed(
            &task,
            "https://127.0.0.1/image.jpg",
            "图片"
        ));
        assert!(!capture_resource_allowed(
            &task,
            "https://[::1]/image.jpg",
            "图片"
        ));
        assert!(!capture_resource_allowed(
            &task,
            "file:///C:/secret.txt",
            "其他资源"
        ));
        assert!(capture_resource_allowed(
            &task,
            "blob:https://example.com/id",
            "Fetch/API"
        ));
        assert!(capture_resource_allowed(
            &task,
            "data:image/png;base64,AA==",
            "图片"
        ));
    }

    #[test]
    fn capture_names_cannot_escape_the_task_directory() {
        assert_eq!(
            sanitize_capture_name("../page.png", 0, "image/png"),
            "page.png"
        );
        assert_eq!(sanitize_capture_name("", 1, "image/webp"), "page-002.webp");
    }
}
