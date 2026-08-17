# Ecryptees

一款带点玩具感、但认真对待本地数据边界的文本、图片、漫画与视频处理工具。

Ecryptees 可以把多张图片打包成带认证的 `.ecomic`，也可以直接保存和播放原始 MP4，并在分享时按需生成 `.emp4`。Android 与现代浏览器都能离线整理漫画、图片和视频资产，并按需导出原文件。

当前 Android 版本：`1.1.3`（versionCode 20）。

当前 Windows 桌面版本：`1.1.4`（Tauri v2，Windows x64）。

## 它能做什么

### 文本

- 在明文与项目自定义码表文本之间双向转换。
- 支持中文、英文、Emoji 和混合文本。
- 全程在当前设备中处理。

### 图片

- 支持 PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC 和 HEIF。
- 提供清晰、平衡、极限三档 JPG 压缩。
- 图片结果以本地 TXT 密文文件导出，也可以重新导入并恢复图片。
- 保持对历史图片格式 v1–v3 的解码兼容。

### `.ecomic` 漫画

- 最多按顺序封装 80 张图片，原始页面总量不超过 500 MiB。
- 使用 `.ecomic` v1、AES-256-GCM、4 MiB 分块和逐块认证。
- 页面按用户排列顺序写入，解密后保持归档原页字节一致。
- 支持连续阅读、阅读位置恢复、归档导出和按需生成长图。
- 支持从本地图片创建，也可以主动分析 HTTPS 静态网页中的 `<img>` 地址，确认、筛选和排序后批量加入漫画；对受支持站点的分段混淆图片会先还原再入库。
- Android 可以从 QQ、文件管理器等应用的“打开方式”或“发送/分享”接收单个 `.ecomic`。

### `.emp4` 视频

- 将一个 MP4 字节精确地封装为 `.emp4` v1，不转码、不重封装。
- 使用随机 AES-256 内容密钥、1 MiB 独立认证分块和加密清单。
- 使用应用内置密钥自动加密和解密，不提供视频自定义密码。
- 视频资产直接保存原始 MP4，播放和“导出原 MP4”不再经过二次解密。
- 导入 `.emp4` 时会先完成认证解密，再把原始 MP4 写入应用私有数据；旧版密文资产会按同样规则安全迁移。
- 只有用户点击“导出 .emp4”时才临时加密生成归档，下载交接后回收临时文件。
- Android 可从文件管理器或分享入口接收 `.emp4`。直接打开本地 `index.html` 时，如果浏览器禁止 `file://` 持久存储，仍可在当前页面完成解密、播放和原 MP4 导出。
- 完整二进制规范见 [`EMP4-FORMAT.md`](EMP4-FORMAT.md)。

### 本地资产

- 漫画资产长期保存原始页面、封面、标题、阅读进度和分组信息。
- 图片模式使用现有 v3 密文格式无损封装原始图片，不压缩或强制转换 JPG；勾选“同时保存到资产”后，只有处理成功才写入图片资产库。
- 不长期保存 `.ecomic` 或长图；点击导出时才临时重新生成，完成后回收临时文件。
- 每本漫画提供 `阅读`、`导出 .ecomic`、`导出长图`、`删除`四个直接操作。
- 漫画与图片拥有独立文件夹；图片资产可以查看、导出 TXT、导出原图或删除。
- 视频拥有独立文件夹；资产长期保存原始 MP4，不长期保存 `.emp4`。
- 漫画阅读器侧边栏使用中文数字、阿拉伯数字和英文数字的自然顺序；阅读或滑动切换不会改变顺序，也可以拖动并持久保存自定义顺序。侧边栏支持按钮或横杠手势全屏展开，超长标题可在文字区域内单独左右滑动。
- 覆盖安装新版 APK 会保留资产；卸载应用或清除应用数据会删除私有资产。

## 一句话介绍

> Ecryptees 是一个离线优先的漫画打包器、阅读器与图片资产工具：把本地图片或用户主动选择的网页图片排好顺序生成 `.ecomic`，也可以无损生成图片密文 TXT。没有账号，没有云端上传，资产与加解密处理都留在自己的设备上。

## Android 使用

1. 安装 `dist/Ecryptees-v1.1.3.apk`；从旧版本升级时直接覆盖安装，不要先卸载。
2. 在“漫画”中选择图片、调整顺序并点击“加密并加入资产”。
3. 完成后点击“去查看”直接阅读；需要文件时从漫画资产卡导出 `.ecomic` 或长图。
4. 在 QQ 或文件管理器中对 `.ecomic` 或 `.emp4` 使用“其他应用打开”或“发送”，然后选择 Ecryptees。

也可以在“漫画 → 网页链接”中粘贴 HTTPS 页面地址。点击“分析网页”才会联网；分析结果按页面顺序列出，用户确认、删除或调整顺序后才加入漫画。应用会依次识别 `<img>`、页面内嵌图片清单、滚动列表和翻页阅读器。Android APK 必要时会创建隔离的临时 WebView，运行目标页面脚本并分块复制最终图片，随后销毁临时页面及其 Cookie、缓存和站点存储。该环境不读取 Ecryptees 主 WebView 状态，但目标页面脚本本身仍会向其网站及页面引用的第三方地址发起请求。

为了兼容不同 Android 厂商和应用不稳定的 MIME 标记，Ecryptees 会出现在较多文件的打开或分享候选中。真正导入前仍会检查 `.ecomic` 文件名、大小、`ECRCOM1` 文件头和完整归档认证；无效文件不会进入书架。

Android 最低版本为 Android 8.0（API 26）。APK 的单图和漫画多图导入使用系统照片选择器，只显示图片，并在系统支持时按勾选顺序返回；不支持有序选择的设备会保留系统返回顺序，用户可根据页码拖动确认。TXT、`.ecomic` 等非图片文件继续使用系统文档选择器。应用不申请读取整个相册、读取全部文件或管理全部文件权限，只使用用户选择项目的临时 URI 权限。1.0.11 起为主动网页导入声明普通权限 `INTERNET`。

## 浏览器与 PWA

仓库不依赖框架或第三方运行时。直接打开 `index.html` 可以使用核心功能；通过 HTTP/HTTPS 访问时可以使用 Worker、OPFS 和 PWA 离线缓存。

本地启动：

```bash
python -m http.server 8000
```

然后访问 `http://127.0.0.1:8000/`。如果要安装为 PWA，正式环境需要 HTTPS。

桌面 Chrome/Edge 还可以连接一个用户选择的独立书架目录。目录中的书籍使用 `books/<book-id>/`，包含 `archive.ecomic`、封面、元数据和可选的历史长图文件；Android APK 使用应用私有书架，不显示目录选择功能。

## Windows 桌面版

Windows 版首次启动会在“文档\Ecryptees”下创建“图片”“漫画”“视频”三个互相独立的正式保存目录。可在“设置 → 资产保存位置”中分别更改目录、查看剩余空间或用资源管理器打开。磁盘原件是桌面版主数据，IndexedDB 与 OPFS 只保存可重建缓存。

- 图片保存为 `图片\assets\<assetId>\original.<ext>`。
- 漫画保存为 `漫画\books\<bookId>\archive.ecomic`。
- 视频保存为 `视频\assets\<assetId>\original.mp4`，不会长期保存 `.emp4`，也不提供视频自定义密码。
- 每个根目录包含 `library.json` 与备份；标题、分组、顺序和阅读/播放状态同步写入目录元数据。
- 更改路径时可选择校验后迁移，或让新目录只接收以后导入的资产。旧目录在后一种模式下继续作为只读来源。
- 删除资产时只处理经验证的应用资产 ID 目录并移入 Windows 回收站；无关文件不会被删除。
- 覆盖安装或卸载 Windows 应用不会删除这三个外部资产目录。

桌面安装包内置 WebView2 离线安装程序，不需要联网安装。首个版本未使用商业代码签名证书，因此 Windows 可能显示未知发布者或 SmartScreen 提示。

## 数据与安全边界

- 应用冷启动、切换页面、本地导入、阅读、书架和导出不会自动联网；只有用户点击“分析网页”后才访问该 HTTPS 页面，确认下载后才访问图片地址。
- 网页导入优先解析静态 HTML 和页面内嵌清单；检测到少量预览图、虚拟列表或翻页阅读器时，Android 才在无既有 Cookie 和登录状态的临时 WebView 中运行页面脚本，并在完成后清除临时站点数据。浏览器/PWA 版本仍受目标网站 CORS 策略限制。
- 没有账号、云同步、分析统计、广告 SDK 或远程素材。
- Android 书架中的原始页面是应用私有数据，不是再次加密保存的 `.ecomic`。
- 显式导出的 `.ecomic`、TXT 和 PNG 位于用户选择的外部位置，不会随应用卸载而自动删除。
- `.ecomic` v1 是带完整性认证的本项目归档格式，但当前使用应用内置密钥材料；它不应被当作用户密码保险箱、数字版权管理或对抗专业取证的方案。
- 处理大文件仍受设备可用空间、WebView 解码能力和系统图片高度限制影响。

## 当前限制

| 项目 | 限制 |
| --- | --- |
| 单张图片模式 | 最大 15 MiB、最大 4000 万像素 |
| 单本漫画 | 最多 80 页 |
| 漫画原页总量 | 最大 500 MiB |
| Android | Android 8.0 及以上 |
| 单个视频 | 原始 MP4 最大 64 GiB，实际还受本地剩余空间限制 |
| 分享接收 | 一次接收一个 `.ecomic` 或 `.emp4` |

## 网络功能边界

当前项目不提供项目服务器、后台同步、云存储或用户间传输，也不保留相关界面入口和连接接口。现有网络能力仅用于用户主动点击“分析网页”后的 HTTPS 网页导入。

Android 的 `INTERNET` 是安装时声明的普通权限，不会在首次联网时弹出运行时授权框。自 1.0.11 起，网页导入需要该权限，因此这里保证的是“默认不联网、必须由用户点击触发”，而不是“APK 没有网络权限”。

## 构建与验证

运行全部 Node 回归：

```bash
node --test tests/*.test.js
```

检查 JavaScript：

```bash
node --check js/comic-app.js
```

构建、Lint、签名并验证 Android Release：

```powershell
powershell -ExecutionPolicy Bypass -File .\android-app\build-apk.ps1
```

构建脚本会生成版本化 APK，例如 `dist/Ecryptees-v1.1.3.apk`，并同步覆盖稳定文件名 `dist/Ecryptees.apk`。脚本会验证 APK 内部版本和发布证书；覆盖安装必须继续使用同一个 applicationId 与签名证书。

准备并构建 Windows x64 NSIS 安装包：

```powershell
npm install
npm run desktop:build
```

构建脚本固定使用单个 Cargo 任务以降低 Windows 编译内存峰值，并自动执行资源准备和成品校验。成功后会输出 `dist/windows/Ecryptees-v1.1.4-x64-setup.exe`、稳定别名 `dist/windows/Ecryptees-Setup.exe` 和对应的 SHA-256 文件。`scripts/prepare-desktop.ps1` 只复制网页外壳所需的 HTML、CSS、JavaScript、图标和清单，不会将测试、Android 工程或用户文件打入安装包。

## 项目结构

- `index.html`、`css/`、`assets/`：应用界面与本地资源。
- `js/core.js`、`js/app.js`：文本和图片格式与界面逻辑。
- `js/comic-core.js`：`.ecomic` v1 格式与认证规则。
- `js/video-core.js`、`js/video-worker.js`：`.emp4` v1、内置密钥包装、分块加解密和流式导出。
- `js/video-assets.js`、`js/video-app.js`：原始 MP4 资产、临时 `.emp4` 导入导出与播放界面。
- `js/comic-worker.js`：分块加解密、书架存储和流式长图生成。
- `js/comic-app.js`、`js/web-import-core.js`：漫画、网页图片候选解析、阅读器、书架和分组界面。
- `js/android-bridge.js`、`android-app/`：Android WebView 包装、系统文件交接、分块传输和用户触发的受控 HTTPS 请求。
- `js/desktop-storage.js`、`src-tauri/`：Windows Tauri 外壳、三类正式目录、4 MiB 原始二进制 IPC、迁移与回收站删除。
- `scripts/prepare-desktop.ps1`、`scripts/verify-desktop.ps1`：精简桌面资源并整理版本化 NSIS 安装包与校验值。
- `tests/`：格式、兼容性、边界和 Android 静态集成回归。

更详细的 Android 构建说明见 [`android-app/README.md`](android-app/README.md)，历史浏览器与 APK 验证记录见 [`design-qa.md`](design-qa.md)。
