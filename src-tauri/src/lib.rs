mod network;
mod render_capture;

use fs2::available_space;
use network::{
    NetworkManager, begin_desktop_network_fetch, cancel_desktop_network_fetch,
    get_desktop_network_status, read_desktop_network_chunk, release_desktop_network_fetch,
};
use render_capture::{
    RenderCaptureManager, begin_desktop_rendered_page_capture,
    get_desktop_rendered_page_capture_status, read_desktop_rendered_page_image_chunk,
    release_desktop_rendered_page_capture,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Listener, Manager, State};
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const LIBRARY_SCHEMA_VERSION: u32 = 1;
const RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const PENDING_DIRECTORY: &str = ".ecryptees-pending";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    Image,
    Comic,
    Video,
}

impl AssetKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "image" => Ok(Self::Image),
            "comic" => Ok(Self::Comic),
            "video" => Ok(Self::Video),
            _ => Err("未知的资产类型".into()),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Comic => "comic",
            Self::Video => "video",
        }
    }

    fn default_directory(self) -> &'static str {
        match self {
            Self::Image => "图片",
            Self::Comic => "漫画",
            Self::Video => "视频",
        }
    }

    fn container(self) -> &'static str {
        match self {
            Self::Comic => "books",
            Self::Image | Self::Video => "assets",
        }
    }

    fn primary_file_name(self, metadata: &Value) -> Result<String, String> {
        match self {
            Self::Comic => Ok("archive.ecomic".into()),
            Self::Video => Ok("original.mp4".into()),
            Self::Image => {
                let requested = metadata
                    .get("fileName")
                    .and_then(Value::as_str)
                    .unwrap_or("image.png");
                let extension = Path::new(requested)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png")
                    .to_ascii_lowercase();
                let safe = match extension.as_str() {
                    "avif" | "bmp" | "gif" | "heic" | "heif" | "jpeg" | "jpg" | "png" | "webp" => {
                        extension
                    }
                    _ => "img".into(),
                };
                Ok(format!("original.{safe}"))
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindPaths {
    active_path: PathBuf,
    #[serde(default)]
    legacy_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    schema_version: u32,
    image: KindPaths,
    comic: KindPaths,
    video: KindPaths,
}

impl DesktopSettings {
    fn paths(&self, kind: AssetKind) -> &KindPaths {
        match kind {
            AssetKind::Image => &self.image,
            AssetKind::Comic => &self.comic,
            AssetKind::Video => &self.video,
        }
    }

    fn paths_mut(&mut self, kind: AssetKind) -> &mut KindPaths {
        match kind {
            AssetKind::Image => &mut self.image,
            AssetKind::Comic => &mut self.comic,
            AssetKind::Video => &mut self.video,
        }
    }

    fn all_active(&self) -> [(AssetKind, &Path); 3] {
        [
            (AssetKind::Image, self.image.active_path.as_path()),
            (AssetKind::Comic, self.comic.active_path.as_path()),
            (AssetKind::Video, self.video.active_path.as_path()),
        ]
    }
}

#[derive(Debug)]
struct WriteSession {
    kind: AssetKind,
    asset_id: String,
    staging_directory: PathBuf,
    file: File,
    expected_size: u64,
    written: u64,
    metadata: Value,
    primary_file_name: String,
}

#[derive(Default)]
struct DesktopState {
    settings_path: Mutex<Option<PathBuf>>,
    settings: Mutex<Option<DesktopSettings>>,
    writes: Mutex<HashMap<String, WriteSession>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindSettingsResponse {
    active_path: String,
    legacy_paths: Vec<String>,
    available: bool,
    available_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsResponse {
    schema_version: u32,
    version: String,
    image: KindSettingsResponse,
    comic: KindSettingsResponse,
    video: KindSettingsResponse,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskAsset {
    kind: String,
    asset_id: String,
    metadata: Value,
    file_path: Option<String>,
    root_path: String,
    available: bool,
    legacy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginWriteRequest {
    kind: String,
    asset_id: String,
    expected_size: u64,
    metadata: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginWriteResponse {
    token: String,
    chunk_size: usize,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}：{error}")
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn validate_asset_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.len() < 8
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("资产 ID 无效".into());
    }
    Ok(id.into())
}

fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error("无法读取目录", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("资产路径必须是普通目录，不能使用符号链接或目录联接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("资产路径不能使用 Windows 重解析点".into());
        }
    }
    Ok(())
}

fn is_plain_file(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| io_error("无法创建资产目录", error))?;
    ensure_plain_directory(path)?;
    path.canonicalize()
        .map_err(|error| io_error("无法解析资产目录", error))
}

fn normalized_path(path: &Path) -> String {
    let mut value = path_text(path).replace('/', "\\");
    while value.ends_with('\\') {
        value.pop();
    }
    value.to_ascii_lowercase()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = normalized_path(left);
    let right = normalized_path(right);
    left == right || left.starts_with(&(right.clone() + "\\")) || right.starts_with(&(left + "\\"))
}

fn library_path(root: &Path) -> PathBuf {
    root.join("library.json")
}

fn library_backup_path(root: &Path) -> PathBuf {
    root.join("library.json.bak")
}

fn default_library(kind: AssetKind) -> Value {
    json!({
        "schemaVersion": LIBRARY_SCHEMA_VERSION,
        "kind": kind.key(),
        "groups": [],
        "orderMode": "natural",
        "order": []
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| io_error("无法读取元数据", error))?;
    serde_json::from_slice(&bytes).map_err(|error| io_error("元数据格式无效", error))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "元数据路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| io_error("无法创建元数据目录", error))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let payload =
        serde_json::to_vec_pretty(value).map_err(|error| io_error("无法编码元数据", error))?;
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| io_error("无法创建元数据候选文件", error))?;
        file.write_all(&payload)
            .map_err(|error| io_error("无法写入元数据", error))?;
        file.sync_all()
            .map_err(|error| io_error("无法提交元数据", error))?;
    }
    let replacement_backup = parent.join(format!(".{}.replace", Uuid::new_v4()));
    let had_previous = path.exists();
    if had_previous {
        fs::rename(path, &replacement_backup)
            .map_err(|error| io_error("无法暂存旧元数据", error))?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            if had_previous {
                let _ = fs::remove_file(&replacement_backup);
            }
            Ok(())
        }
        Err(error) => {
            if had_previous {
                let _ = fs::rename(&replacement_backup, path);
            }
            let _ = fs::remove_file(&temporary);
            Err(io_error("无法提交元数据", error))
        }
    }
}

fn initialize_library(root: &Path, kind: AssetKind) -> Result<(), String> {
    fs::create_dir_all(root.join(kind.container()))
        .map_err(|error| io_error("无法创建资产容器", error))?;
    let marker = library_path(root);
    if marker.exists() {
        let library = read_json(&marker)?;
        if library.get("kind").and_then(Value::as_str) != Some(kind.key()) {
            return Err("所选目录属于其他资产类型".into());
        }
        if library.get("schemaVersion").and_then(Value::as_u64)
            != Some(LIBRARY_SCHEMA_VERSION as u64)
        {
            return Err("所选目录使用了不兼容的资产目录版本".into());
        }
        return Ok(());
    }
    write_json_atomic(&marker, &default_library(kind))
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| io_error("无法定位应用设置目录", error))?;
    fs::create_dir_all(&directory).map_err(|error| io_error("无法创建应用设置目录", error))?;
    Ok(directory.join("desktop-storage.json"))
}

fn create_default_settings(app: &AppHandle) -> Result<DesktopSettings, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| io_error("无法定位文档目录", error))?;
    let base = documents.join("Ecryptees");
    let image = canonical_directory(&base.join(AssetKind::Image.default_directory()))?;
    let comic = canonical_directory(&base.join(AssetKind::Comic.default_directory()))?;
    let video = canonical_directory(&base.join(AssetKind::Video.default_directory()))?;
    let settings = DesktopSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        image: KindPaths {
            active_path: image,
            legacy_paths: Vec::new(),
        },
        comic: KindPaths {
            active_path: comic,
            legacy_paths: Vec::new(),
        },
        video: KindPaths {
            active_path: video,
            legacy_paths: Vec::new(),
        },
    };
    for (kind, path) in settings.all_active() {
        initialize_library(path, kind)?;
    }
    Ok(settings)
}

fn load_or_create_settings(app: &AppHandle, path: &Path) -> Result<DesktopSettings, String> {
    let existing = path.exists();
    let settings = if existing {
        let bytes = fs::read(path).map_err(|error| io_error("无法读取桌面存储设置", error))?;
        let value: DesktopSettings = serde_json::from_slice(&bytes)
            .map_err(|error| io_error("桌面存储设置格式无效", error))?;
        if value.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err("桌面存储设置版本不兼容".into());
        }
        value
    } else {
        create_default_settings(app)?
    };
    for (kind, root) in settings.all_active() {
        if !root.is_absolute() {
            return Err(format!("{}保存路径不是绝对目录", kind.default_directory()));
        }
        if root.is_dir() {
            ensure_plain_directory(root)?;
            initialize_library(root, kind)?;
        }
    }
    let active = settings.all_active();
    for left in 0..active.len() {
        for right in (left + 1)..active.len() {
            if paths_overlap(active[left].1, active[right].1) {
                return Err("图片、漫画和视频保存路径不能相同或互相嵌套".into());
            }
        }
    }
    write_settings(path, &settings)?;
    Ok(settings)
}

fn write_settings(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    let value =
        serde_json::to_value(settings).map_err(|error| io_error("无法编码桌面设置", error))?;
    write_json_atomic(path, &value)
}

fn add_root_scope(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(path, true)
        .map_err(|error| io_error("无法授权资产目录", error))?;
    app.asset_protocol_scope()
        .allow_directory(path, true)
        .map_err(|error| io_error("无法授权媒体目录", error))?;
    Ok(())
}

fn clean_pending(root: &Path) -> Result<(), String> {
    let pending = root.join(PENDING_DIRECTORY);
    if pending.exists() {
        ensure_plain_directory(&pending)?;
        fs::remove_dir_all(&pending).map_err(|error| io_error("无法清理未完成写入", error))?;
    }
    Ok(())
}

fn initialize(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let path = settings_file(app)?;
    let settings = load_or_create_settings(app, &path)?;
    for (kind, active) in settings.all_active() {
        if active.is_dir() && ensure_plain_directory(active).is_ok() {
            initialize_library(active, kind)?;
            clean_pending(active)?;
            add_root_scope(app, active)?;
        }
        for legacy in &settings.paths(kind).legacy_paths {
            if legacy.is_dir() && ensure_plain_directory(legacy).is_ok() {
                add_root_scope(app, legacy)?;
            }
        }
    }
    *state.settings_path.lock().map_err(|_| "无法锁定设置路径")? = Some(path);
    *state.settings.lock().map_err(|_| "无法锁定桌面设置")? = Some(settings);
    Ok(())
}

fn settings_clone(state: &DesktopState) -> Result<DesktopSettings, String> {
    state
        .settings
        .lock()
        .map_err(|_| "无法读取桌面设置".to_string())?
        .clone()
        .ok_or_else(|| "桌面存储尚未初始化".to_string())
}

fn kind_response(paths: &KindPaths) -> KindSettingsResponse {
    let available =
        paths.active_path.is_dir() && ensure_plain_directory(&paths.active_path).is_ok();
    KindSettingsResponse {
        active_path: path_text(&paths.active_path),
        legacy_paths: paths
            .legacy_paths
            .iter()
            .map(|path| path_text(path))
            .collect(),
        available,
        available_bytes: available_space(&paths.active_path).ok(),
    }
}

#[tauri::command]
fn get_desktop_settings(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SettingsResponse, String> {
    let settings = settings_clone(&state)?;
    Ok(SettingsResponse {
        schema_version: settings.schema_version,
        version: app.package_info().version.to_string(),
        image: kind_response(&settings.image),
        comic: kind_response(&settings.comic),
        video: kind_response(&settings.video),
        warnings: Vec::new(),
    })
}

fn roots_for_kind(settings: &DesktopSettings, kind: AssetKind) -> Vec<(PathBuf, bool)> {
    let paths = settings.paths(kind);
    let mut roots = vec![(paths.active_path.clone(), false)];
    roots.extend(paths.legacy_paths.iter().cloned().map(|path| (path, true)));
    roots
}

fn locate_primary_file(directory: &Path, kind: AssetKind, metadata: &Value) -> Option<PathBuf> {
    let fixed = kind.primary_file_name(metadata).ok()?;
    let path = directory.join(fixed);
    if is_plain_file(&path) {
        return Some(path);
    }
    if kind == AssetKind::Image {
        return fs::read_dir(directory)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                is_plain_file(path)
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("original."))
            });
    }
    None
}

fn scan_kind(settings: &DesktopSettings, kind: AssetKind) -> Result<Vec<DiskAsset>, String> {
    let mut assets = Vec::new();
    let mut seen = HashMap::<String, String>::new();
    for (root, legacy) in roots_for_kind(settings, kind) {
        if !root.is_dir() || ensure_plain_directory(&root).is_err() {
            continue;
        }
        let container = root.join(kind.container());
        let entries = match fs::read_dir(&container) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error("无法扫描资产目录", error)),
        };
        for entry in entries.flatten() {
            let directory = entry.path();
            if ensure_plain_directory(&directory).is_err() {
                continue;
            }
            let asset_id = match entry
                .file_name()
                .to_str()
                .and_then(|value| validate_asset_id(value).ok())
            {
                Some(value) => value,
                None => continue,
            };
            if seen.contains_key(&asset_id) {
                continue;
            }
            let metadata_file = directory.join("metadata.json");
            let metadata = match read_json(&metadata_file) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.get("assetId").and_then(Value::as_str) != Some(asset_id.as_str()) {
                continue;
            }
            let primary = locate_primary_file(&directory, kind, &metadata);
            seen.insert(asset_id.clone(), path_text(&root));
            assets.push(DiskAsset {
                kind: kind.key().into(),
                asset_id,
                metadata,
                file_path: primary.as_deref().map(path_text),
                root_path: path_text(&root),
                available: primary.is_some(),
                legacy,
            });
        }
    }
    Ok(assets)
}

#[tauri::command]
fn list_desktop_assets(
    kind: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<DiskAsset>, String> {
    let kind = AssetKind::parse(&kind)?;
    scan_kind(&settings_clone(&state)?, kind)
}

fn find_asset_directory(
    settings: &DesktopSettings,
    kind: AssetKind,
    asset_id: &str,
) -> Result<PathBuf, String> {
    let asset_id = validate_asset_id(asset_id)?;
    for (root, _) in roots_for_kind(settings, kind) {
        let candidate = root.join(kind.container()).join(&asset_id);
        if candidate.is_dir() && ensure_plain_directory(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("资产文件不存在或保存目录不可用".into())
}

#[tauri::command]
fn get_desktop_asset_path(
    kind: String,
    asset_id: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    let kind = AssetKind::parse(&kind)?;
    let settings = settings_clone(&state)?;
    let directory = find_asset_directory(&settings, kind, &asset_id)?;
    let metadata = read_json(&directory.join("metadata.json"))?;
    let file = locate_primary_file(&directory, kind, &metadata)
        .ok_or_else(|| "资产原件不可用".to_string())?;
    Ok(path_text(&file))
}

#[tauri::command]
fn begin_asset_write(
    request: BeginWriteRequest,
    state: State<'_, DesktopState>,
) -> Result<BeginWriteResponse, String> {
    let kind = AssetKind::parse(&request.kind)?;
    let asset_id = validate_asset_id(&request.asset_id)?;
    if request.expected_size == 0 {
        return Err("资产文件不能为空".into());
    }
    let settings = settings_clone(&state)?;
    let root = settings.paths(kind).active_path.clone();
    ensure_plain_directory(&root)?;
    let free =
        available_space(&root).map_err(|error| io_error("无法读取保存目录剩余空间", error))?;
    if free < request.expected_size.saturating_add(RESERVE_BYTES) {
        return Err("保存目录空间不足；需要额外保留 64 MiB 安全空间".into());
    }
    let final_directory = root.join(kind.container()).join(&asset_id);
    if final_directory.exists() {
        return Err("该资产已经存在于保存目录中".into());
    }
    let token = Uuid::new_v4().to_string();
    let staging_directory = root.join(PENDING_DIRECTORY).join(&token);
    fs::create_dir_all(&staging_directory)
        .map_err(|error| io_error("无法创建写入候选目录", error))?;
    ensure_plain_directory(&staging_directory)?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(staging_directory.join("payload.part"))
        .map_err(|error| io_error("无法创建资产候选文件", error))?;
    let primary_file_name = kind.primary_file_name(&request.metadata)?;
    state
        .writes
        .lock()
        .map_err(|_| "无法锁定写入任务".to_string())?
        .insert(
            token.clone(),
            WriteSession {
                kind,
                asset_id,
                staging_directory,
                file,
                expected_size: request.expected_size,
                written: 0,
                metadata: request.metadata,
                primary_file_name,
            },
        );
    Ok(BeginWriteResponse {
        token,
        chunk_size: MAX_CHUNK_BYTES,
    })
}

fn request_header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("写入请求缺少 {name}"))
}

#[tauri::command]
fn write_asset_chunk(
    request: tauri::ipc::Request<'_>,
    state: State<'_, DesktopState>,
) -> Result<u64, String> {
    let token = request_header(&request, "x-ecryptees-token")?.to_string();
    let offset = request_header(&request, "x-ecryptees-offset")?
        .parse::<u64>()
        .map_err(|_| "写入偏移无效".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("资产分块必须使用原始二进制请求".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Err("资产分块为空或超过 4 MiB".into());
    }
    let mut writes = state
        .writes
        .lock()
        .map_err(|_| "无法锁定写入任务".to_string())?;
    let session = writes
        .get_mut(&token)
        .ok_or_else(|| "写入任务不存在或已经结束".to_string())?;
    if offset != session.written {
        return Err("资产分块顺序无效".into());
    }
    if session.written.saturating_add(bytes.len() as u64) > session.expected_size {
        return Err("资产分块超过声明大小".into());
    }
    session
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|error| io_error("无法定位资产分块", error))?;
    session
        .file
        .write_all(bytes)
        .map_err(|error| io_error("无法写入资产分块", error))?;
    session.written += bytes.len() as u64;
    Ok(session.written)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| io_error("无法打开文件进行校验", error))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; MAX_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| io_error("无法读取文件进行校验", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[tauri::command]
fn commit_asset_write(token: String, state: State<'_, DesktopState>) -> Result<DiskAsset, String> {
    let mut session = state
        .writes
        .lock()
        .map_err(|_| "无法锁定写入任务".to_string())?
        .remove(&token)
        .ok_or_else(|| "写入任务不存在或已经结束".to_string())?;
    if session.written != session.expected_size {
        return Err("资产文件尚未完整写入".into());
    }
    session
        .file
        .flush()
        .map_err(|error| io_error("无法刷新资产文件", error))?;
    session
        .file
        .sync_all()
        .map_err(|error| io_error("无法提交资产文件", error))?;
    drop(session.file);
    let candidate = session.staging_directory.join("payload.part");
    let hash = hash_file(&candidate)?;
    let mut metadata = match session.metadata {
        Value::Object(value) => value,
        _ => Map::new(),
    };
    metadata.insert("assetId".into(), Value::String(session.asset_id.clone()));
    metadata.insert("kind".into(), Value::String(session.kind.key().into()));
    metadata.insert(
        "fileSize".into(),
        Value::Number(session.expected_size.into()),
    );
    metadata.insert("contentHashSha256".into(), Value::String(hash));
    metadata.insert(
        "storageSchemaVersion".into(),
        Value::Number(LIBRARY_SCHEMA_VERSION.into()),
    );
    let metadata = Value::Object(metadata);
    fs::rename(
        &candidate,
        session.staging_directory.join(&session.primary_file_name),
    )
    .map_err(|error| io_error("无法命名资产原件", error))?;
    write_json_atomic(&session.staging_directory.join("metadata.json"), &metadata)?;
    let root = session
        .staging_directory
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "写入候选目录无效".to_string())?
        .to_path_buf();
    let target = root.join(session.kind.container()).join(&session.asset_id);
    fs::create_dir_all(root.join(session.kind.container()))
        .map_err(|error| io_error("无法创建资产容器", error))?;
    fs::rename(&session.staging_directory, &target)
        .map_err(|error| io_error("无法提交资产目录", error))?;
    let primary = target.join(&session.primary_file_name);
    Ok(DiskAsset {
        kind: session.kind.key().into(),
        asset_id: session.asset_id,
        metadata,
        file_path: Some(path_text(&primary)),
        root_path: path_text(&root),
        available: true,
        legacy: false,
    })
}

#[tauri::command]
fn abort_asset_write(token: String, state: State<'_, DesktopState>) -> Result<(), String> {
    let session = state
        .writes
        .lock()
        .map_err(|_| "无法锁定写入任务".to_string())?
        .remove(&token);
    if let Some(session) = session {
        drop(session.file);
        if session.staging_directory.exists() {
            fs::remove_dir_all(&session.staging_directory)
                .map_err(|error| io_error("无法清理取消的写入任务", error))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn update_desktop_asset_metadata(
    kind: String,
    asset_id: String,
    metadata: Value,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let kind = AssetKind::parse(&kind)?;
    let asset_id = validate_asset_id(&asset_id)?;
    let settings = settings_clone(&state)?;
    let directory = find_asset_directory(&settings, kind, &asset_id)?;
    let mut value = match metadata {
        Value::Object(value) => value,
        _ => return Err("资产元数据必须是对象".into()),
    };
    value.insert("assetId".into(), Value::String(asset_id));
    value.insert("kind".into(), Value::String(kind.key().into()));
    write_json_atomic(&directory.join("metadata.json"), &Value::Object(value))
}

#[tauri::command]
fn update_desktop_library(
    kind: String,
    mut library: Value,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let kind = AssetKind::parse(&kind)?;
    let settings = settings_clone(&state)?;
    let root = &settings.paths(kind).active_path;
    let object = library
        .as_object_mut()
        .ok_or_else(|| "目录元数据必须是对象".to_string())?;
    object.insert(
        "schemaVersion".into(),
        Value::Number(LIBRARY_SCHEMA_VERSION.into()),
    );
    object.insert("kind".into(), Value::String(kind.key().into()));
    let target = library_path(root);
    if target.exists() {
        fs::copy(&target, library_backup_path(root))
            .map_err(|error| io_error("无法备份目录元数据", error))?;
    }
    write_json_atomic(&target, &library)
}

#[tauri::command]
fn get_desktop_library(kind: String, state: State<'_, DesktopState>) -> Result<Value, String> {
    let kind = AssetKind::parse(&kind)?;
    let settings = settings_clone(&state)?;
    read_json(&library_path(&settings.paths(kind).active_path))
}

#[tauri::command]
fn trash_desktop_asset(
    kind: String,
    asset_id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let kind = AssetKind::parse(&kind)?;
    let settings = settings_clone(&state)?;
    let directory = find_asset_directory(&settings, kind, &asset_id)?;
    ensure_plain_directory(&directory)?;
    trash::delete(&directory).map_err(|error| io_error("无法将资产移入 Windows 回收站", error))
}

fn copy_file_verified(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error("无法创建迁移目录", error))?;
    }
    fs::copy(source, target).map_err(|error| io_error("无法复制资产文件", error))?;
    if fs::metadata(source)
        .map_err(|error| io_error("无法校验源文件", error))?
        .len()
        != fs::metadata(target)
            .map_err(|error| io_error("无法校验目标文件", error))?
            .len()
        || hash_file(source)? != hash_file(target)?
    {
        return Err("迁移文件校验失败".into());
    }
    Ok(())
}

fn copy_directory_verified(source: &Path, target: &Path) -> Result<(), String> {
    ensure_plain_directory(source)?;
    fs::create_dir_all(target).map_err(|error| io_error("无法创建迁移目标目录", error))?;
    ensure_plain_directory(target)?;
    for entry in fs::read_dir(source).map_err(|error| io_error("无法读取迁移源目录", error))?
    {
        let entry = entry.map_err(|error| io_error("无法读取迁移项目", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| io_error("无法检查迁移项目", error))?;
        if metadata.file_type().is_symlink() {
            return Err("迁移目录中包含不允许的符号链接".into());
        }
        if metadata.is_dir() {
            copy_directory_verified(&source_path, &target_path)?;
        } else if metadata.is_file() {
            copy_file_verified(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    ensure_plain_directory(path)?;
    Ok(fs::read_dir(path)
        .map_err(|error| io_error("无法检查迁移目标目录", error))?
        .next()
        .is_none())
}

fn directory_size(path: &Path) -> Result<u64, String> {
    ensure_plain_directory(path)?;
    let mut total = 0_u64;
    for entry in fs::read_dir(path).map_err(|error| io_error("无法统计迁移空间", error))? {
        let entry = entry.map_err(|error| io_error("无法读取迁移项目", error))?;
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)
            .map_err(|error| io_error("无法检查迁移项目", error))?;
        if metadata.file_type().is_symlink() {
            return Err("迁移目录中包含不允许的符号链接".into());
        }
        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry_path)?);
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

fn managed_asset_directories(root: &Path, kind: AssetKind) -> Result<Vec<PathBuf>, String> {
    let container = root.join(kind.container());
    let entries = match fs::read_dir(&container) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error("无法读取资产目录", error)),
    };
    let mut managed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| io_error("无法读取资产项目", error))?;
        let directory = entry.path();
        if ensure_plain_directory(&directory).is_err() {
            continue;
        }
        let Some(asset_id) = entry
            .file_name()
            .to_str()
            .and_then(|value| validate_asset_id(value).ok())
        else {
            continue;
        };
        let Ok(metadata) = read_json(&directory.join("metadata.json")) else {
            continue;
        };
        if metadata.get("assetId").and_then(Value::as_str) == Some(asset_id.as_str())
            && metadata
                .get("kind")
                .and_then(Value::as_str)
                .is_none_or(|value| value == kind.key())
        {
            managed.push(directory);
        }
    }
    Ok(managed)
}

fn migrate_managed_assets(
    kind: AssetKind,
    old_root: &Path,
    new_root: &Path,
) -> Result<Vec<PathBuf>, String> {
    let old_container = old_root.join(kind.container());
    let new_container = new_root.join(kind.container());
    if !old_container.exists() {
        return Ok(Vec::new());
    }
    if !directory_is_empty(&new_container)? {
        return Err("迁移目标已经包含资产；请选择空目录，或使用“仅供新资产使用”".into());
    }
    let managed = managed_asset_directories(old_root, kind)?;
    let required = managed.iter().try_fold(0_u64, |total, directory| {
        directory_size(directory).map(|size| total.saturating_add(size))
    })?;
    let free =
        available_space(new_root).map_err(|error| io_error("无法读取迁移目录剩余空间", error))?;
    if free < required.saturating_add(RESERVE_BYTES) {
        return Err("迁移目录空间不足；需要额外保留 64 MiB 安全空间".into());
    }
    let staging_parent = new_root
        .join(PENDING_DIRECTORY)
        .join(format!("migration-{}", Uuid::new_v4()));
    let staging_container = staging_parent.join(kind.container());
    let result = (|| {
        fs::create_dir_all(&staging_container)
            .map_err(|error| io_error("无法创建迁移候选目录", error))?;
        for source in &managed {
            let name = source
                .file_name()
                .ok_or_else(|| "迁移资产目录无效".to_string())?;
            copy_directory_verified(source, &staging_container.join(name))?;
        }
        if new_container.exists() {
            fs::remove_dir(&new_container)
                .map_err(|error| io_error("无法准备迁移目标目录", error))?;
        }
        fs::rename(&staging_container, &new_container)
            .map_err(|error| io_error("无法提交迁移后的资产目录", error))?;
        Ok(managed)
    })();
    if staging_parent.exists() {
        let _ = fs::remove_dir_all(&staging_parent);
    }
    result
}

fn merge_library(new_library: &Value, old_library: &Value, kind: AssetKind) -> Value {
    let mut merged = new_library.as_object().cloned().unwrap_or_default();
    let old = old_library.as_object().cloned().unwrap_or_default();
    let new_order_was_empty = merged
        .get("order")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    for field in ["groups", "memberships", "order"] {
        let mut values = merged
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for value in old
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !values.contains(value) {
                values.push(value.clone());
            }
        }
        merged.insert(field.into(), Value::Array(values));
    }
    if new_order_was_empty && old.get("orderMode").and_then(Value::as_str) == Some("manual") {
        merged.insert("orderMode".into(), Value::String("manual".into()));
    }
    merged.insert(
        "schemaVersion".into(),
        Value::Number(LIBRARY_SCHEMA_VERSION.into()),
    );
    merged.insert("kind".into(), Value::String(kind.key().into()));
    Value::Object(merged)
}

#[tauri::command]
fn set_desktop_asset_root(
    app: AppHandle,
    kind: String,
    new_path: String,
    migrate: bool,
    state: State<'_, DesktopState>,
) -> Result<SettingsResponse, String> {
    let kind = AssetKind::parse(&kind)?;
    let requested = PathBuf::from(new_path);
    if !requested.is_absolute() {
        return Err("保存路径必须是绝对目录".into());
    }
    let new_root = canonical_directory(&requested)?;
    let mut settings = settings_clone(&state)?;
    for (other_kind, other_root) in settings.all_active() {
        if other_kind != kind && paths_overlap(&new_root, other_root) {
            return Err("图片、漫画和视频保存路径不能相同或互相嵌套".into());
        }
    }
    initialize_library(&new_root, kind)?;
    add_root_scope(&app, &new_root)?;
    let old_root = settings.paths(kind).active_path.clone();
    if paths_overlap(&new_root, &old_root) {
        if normalized_path(&new_root) == normalized_path(&old_root) {
            return get_desktop_settings(app, state);
        }
        return Err("新旧保存路径不能互相嵌套".into());
    }
    let old_library = read_json(&library_path(&old_root)).unwrap_or_else(|_| default_library(kind));
    let new_library_before = read_json(&library_path(&new_root))?;
    let migrated_directories = if migrate {
        migrate_managed_assets(kind, &old_root, &new_root)?
    } else {
        Vec::new()
    };
    let merged_library = merge_library(&new_library_before, &old_library, kind);
    if let Err(error) = write_json_atomic(&library_path(&new_root), &merged_library) {
        if migrate {
            let _ = fs::remove_dir_all(new_root.join(kind.container()));
            let _ = fs::create_dir_all(new_root.join(kind.container()));
        }
        let _ = write_json_atomic(&library_path(&new_root), &new_library_before);
        return Err(error);
    }
    {
        let paths = settings.paths_mut(kind);
        paths.active_path = new_root.clone();
        paths
            .legacy_paths
            .retain(|path| normalized_path(path) != normalized_path(&new_root));
        if !migrate
            && !paths
                .legacy_paths
                .iter()
                .any(|path| normalized_path(path) == normalized_path(&old_root))
        {
            paths.legacy_paths.push(old_root.clone());
        }
    }
    let settings_path = state
        .settings_path
        .lock()
        .map_err(|_| "无法读取设置路径".to_string())?
        .clone()
        .ok_or_else(|| "桌面设置尚未初始化".to_string())?;
    if let Err(error) = write_settings(&settings_path, &settings) {
        if migrate {
            let _ = fs::remove_dir_all(new_root.join(kind.container()));
            let _ = fs::create_dir_all(new_root.join(kind.container()));
        }
        let _ = write_json_atomic(&library_path(&new_root), &new_library_before);
        return Err(error);
    }
    *state.settings.lock().map_err(|_| "无法更新桌面设置")? = Some(settings);
    let mut response = get_desktop_settings(app, state)?;
    if migrate {
        for directory in migrated_directories {
            if let Err(error) = trash::delete(&directory) {
                response
                    .warnings
                    .push(io_error("新目录已启用，但一项旧资产无法移入回收站", error));
            }
        }
    }
    Ok(response)
}

#[tauri::command]
fn open_desktop_asset_root(kind: String, state: State<'_, DesktopState>) -> Result<(), String> {
    let kind = AssetKind::parse(&kind)?;
    let settings = settings_clone(&state)?;
    let root = &settings.paths(kind).active_path;
    ensure_plain_directory(root)?;
    Command::new("explorer.exe")
        .arg(root)
        .spawn()
        .map_err(|error| io_error("无法打开 Windows 资源管理器", error))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let capture_manager = RenderCaptureManager::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .manage(NetworkManager::default())
        .manage(capture_manager.clone())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == "main" {
                    window.state::<NetworkManager>().shutdown();
                    window
                        .state::<RenderCaptureManager>()
                        .shutdown(window.app_handle());
                } else {
                    window
                        .state::<RenderCaptureManager>()
                        .window_destroyed(window.label());
                }
            }
        })
        .setup(|app| {
            let state = app.state::<DesktopState>();
            initialize(app.handle(), &state).map_err(std::io::Error::other)?;
            let temp_root = app.path().temp_dir().map_err(std::io::Error::other)?;
            app.state::<NetworkManager>()
                .initialize(&temp_root)
                .map_err(std::io::Error::other)?;
            app.state::<RenderCaptureManager>()
                .initialize(&temp_root)
                .map_err(std::io::Error::other)?;
            let capture_app = app.handle().clone();
            let capture_manager = app.state::<RenderCaptureManager>().inner().clone();
            app.listen("ecryptees-capture-message", move |event| {
                capture_manager.process_payload(&capture_app, event.payload());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_settings,
            list_desktop_assets,
            get_desktop_asset_path,
            begin_asset_write,
            write_asset_chunk,
            commit_asset_write,
            abort_asset_write,
            update_desktop_asset_metadata,
            get_desktop_library,
            update_desktop_library,
            trash_desktop_asset,
            set_desktop_asset_root,
            open_desktop_asset_root,
            begin_desktop_network_fetch,
            get_desktop_network_status,
            read_desktop_network_chunk,
            cancel_desktop_network_fetch,
            release_desktop_network_fetch,
            begin_desktop_rendered_page_capture,
            get_desktop_rendered_page_capture_status,
            read_desktop_rendered_page_image_chunk,
            release_desktop_rendered_page_capture
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Ecryptees desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_ids_reject_path_components() {
        assert!(validate_asset_id("safe-asset_1234").is_ok());
        assert!(validate_asset_id("../escape").is_err());
        assert!(validate_asset_id("short").is_err());
    }

    #[test]
    fn roots_must_not_overlap() {
        assert!(paths_overlap(
            Path::new("D:\\Media"),
            Path::new("D:\\Media\\Videos")
        ));
        assert!(paths_overlap(
            Path::new("d:\\MEDIA"),
            Path::new("D:\\media")
        ));
        assert!(!paths_overlap(
            Path::new("D:\\Images"),
            Path::new("D:\\Videos")
        ));
    }

    #[test]
    fn storage_names_are_format_specific() {
        assert_eq!(
            AssetKind::Comic.primary_file_name(&json!({})).unwrap(),
            "archive.ecomic"
        );
        assert_eq!(
            AssetKind::Video.primary_file_name(&json!({})).unwrap(),
            "original.mp4"
        );
        assert_eq!(
            AssetKind::Image
                .primary_file_name(&json!({ "fileName": "cover.WEBP" }))
                .unwrap(),
            "original.webp"
        );
    }
}
