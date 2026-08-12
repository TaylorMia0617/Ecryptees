package com.ecryptees.offline;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;

public final class MainActivity extends ComponentActivity {
    private static final String APP_URL = "https://appassets.androidplatform.net/assets/index.html";
    private static final int REQUEST_OPEN_FILE = 1201;
    private static final int REQUEST_SAVE_FILE = 1202;
    private static final long MAX_NATIVE_IMAGE_PIXELS = 40_000_000L;
    private static final long MAX_NATIVE_INPUT_BYTES = 500L * 1024L * 1024L;
    private static final long MAX_INCOMING_ARCHIVE_BYTES = 512L * 1024L * 1024L;
    private static final int MAX_NATIVE_CHUNK_BYTES = 1024 * 1024;
    private static final String HEIC_CACHE_PREFIX = "ecryptees-heic-";
    private static final String REMOTE_CACHE_PREFIX = "ecryptees-fetch-";
    private static final String RENDER_CACHE_PREFIX = "ecryptees-render-";
    private static final long MAX_REMOTE_HTML_BYTES = 5L * 1024L * 1024L;
    private static final String ECOMIC_MIME_TYPE = "application/vnd.ecryptees.ecomic";

    private FrameLayout rootView;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean imageDocumentChooser;
    private final FileBridge fileBridge = new FileBridge();
    private final RemoteNetworkBridge remoteNetworkBridge = new RemoteNetworkBridge();
    private PendingDownload pendingDownload;
    private OutputStream downloadStream;
    private Uri downloadUri;
    private String downloadToken;
    private PendingIncomingDocument pendingIncomingDocument;
    private InputStream incomingDocumentStream;
    private long incomingDocumentBytesRead;
    private boolean webAppReady;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(255, 64, 129));
        getWindow().setNavigationBarColor(Color.rgb(252, 228, 236));
        cleanupStaleHeicFiles();
        cleanupStaleRemoteFiles();
        cleanupStaleRenderedFiles();
        rootView = new FrameLayout(this);
        setContentView(rootView);
        createWebView(savedInstanceState);
        handleIncomingDocument(getIntent());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackNavigation(this);
            }
        });
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingDocument(intent);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView(@Nullable Bundle savedInstanceState) {
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(252, 228, 236));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        rootView.addView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " EcrypteesAndroid/1.0");

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(fileBridge, "AndroidFileBridge");
        webView.addJavascriptInterface(remoteNetworkBridge, "AndroidNetworkBridge");
        webView.setWebViewClient(new WebViewClientCompat() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    @NonNull WebView view,
                    @NonNull WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(@NonNull WebView view, @NonNull String url) {
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    @NonNull WebView view,
                    @NonNull WebResourceRequest request
            ) {
                Uri uri = request.getUrl();
                return !"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost());
            }

            @Override
            public void onPageFinished(@NonNull WebView view, @NonNull String url) {
                super.onPageFinished(view, url);
                webAppReady = url.startsWith(APP_URL);
                notifyIncomingDocument();
            }

            @Override
            public boolean onRenderProcessGone(
                    @NonNull WebView view,
                    @NonNull RenderProcessGoneDetail detail
            ) {
                webAppReady = false;
                fileBridge.abortIncomingDocument(null);
                fileBridge.abortCurrentDownload(false);
                fileBridge.abortAllHeicDecodes();
                remoteNetworkBridge.abortAll();
                rootView.removeView(view);
                view.destroy();
                Toast.makeText(MainActivity.this, R.string.webview_crashed, Toast.LENGTH_LONG).show();
                createWebView(null);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;
                try {
                    imageDocumentChooser = acceptsImageFiles(params);
                    Intent intent = imageDocumentChooser
                            ? createImageDocumentIntent(params)
                            : params.createIntent();
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(intent, REQUEST_OPEN_FILE);
                    return true;
                } catch (ActivityNotFoundException error) {
                    fileChooserCallback = null;
                    imageDocumentChooser = false;
                    Toast.makeText(MainActivity.this, R.string.file_chooser_unavailable, Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(APP_URL);
        }
    }

    private static boolean acceptsImageFiles(WebChromeClient.FileChooserParams params) {
        String[] acceptTypes = params.getAcceptTypes();
        if (acceptTypes == null) {
            return false;
        }
        for (String acceptType : acceptTypes) {
            if (acceptType == null) {
                continue;
            }
            for (String token : acceptType.split(",")) {
                String normalized = token.trim().toLowerCase(Locale.ROOT);
                if (normalized.startsWith("image/")
                        || normalized.equals(".png")
                        || normalized.equals(".jpg")
                        || normalized.equals(".jpeg")
                        || normalized.equals(".gif")
                        || normalized.equals(".webp")
                        || normalized.equals(".bmp")
                        || normalized.equals(".avif")
                        || normalized.equals(".heic")
                        || normalized.equals(".heif")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Intent createImageDocumentIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // File providers do not consistently label JPEG and WebP content. Show all
        // openable documents and let the web app verify each image byte signature.
        intent.setType("*/*");
        intent.putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        );
        return intent;
    }

    @Nullable
    private Uri[] parseImageDocumentResult(int resultCode, @Nullable Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return null;
        }
        ArrayList<Uri> selectedUris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                addReadableDocument(selectedUris, clipData.getItemAt(index).getUri());
            }
        } else {
            addReadableDocument(selectedUris, data.getData());
        }
        return selectedUris.isEmpty() ? null : selectedUris.toArray(new Uri[0]);
    }

    private void addReadableDocument(ArrayList<Uri> selectedUris, @Nullable Uri uri) {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme()) || selectedUris.contains(uri)) {
            return;
        }
        try (ParcelFileDescriptor descriptor = getContentResolver().openFileDescriptor(uri, "r")) {
            if (descriptor != null) {
                selectedUris.add(uri);
            }
        } catch (IOException | SecurityException ignored) {
            // Ignore inaccessible or untrusted provider results.
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_OPEN_FILE) {
            ValueCallback<Uri[]> callback = fileChooserCallback;
            fileChooserCallback = null;
            boolean parseAsImageDocuments = imageDocumentChooser;
            imageDocumentChooser = false;
            if (callback != null) {
                callback.onReceiveValue(parseAsImageDocuments
                        ? parseImageDocumentResult(resultCode, data)
                        : WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            }
            return;
        }
        if (requestCode == REQUEST_SAVE_FILE) {
            handleSaveLocation(resultCode, data);
        }
    }

    private void handleSaveLocation(int resultCode, @Nullable Intent data) {
        PendingDownload download;
        synchronized (fileBridge) {
            download = pendingDownload;
            pendingDownload = null;
        }
        if (download == null) {
            return;
        }
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            evaluateDownloadScript("cancelled()");
            return;
        }
        try {
            OutputStream stream = getContentResolver().openOutputStream(uri, "w");
            if (stream == null) {
                throw new IOException("The selected document cannot be opened");
            }
            String token = UUID.randomUUID().toString();
            synchronized (fileBridge) {
                downloadStream = stream;
                downloadUri = uri;
                downloadToken = token;
            }
            evaluateDownloadScript("stream("
                    + JSONObject.quote(token) + ","
                    + JSONObject.quote(download.blobUrl) + ","
                    + JSONObject.quote(download.name) + ")");
        } catch (IOException error) {
            fileBridge.abortCurrentDownload(true);
        }
    }

    private void evaluateDownloadScript(String call) {
        if (webView != null) {
            webView.evaluateJavascript("window.EcrypteesAndroidDownload&&window.EcrypteesAndroidDownload." + call, null);
        }
    }

    @Nullable
    @SuppressWarnings("deprecation")
    private Uri getIncomingDocumentUri(@NonNull Intent intent) {
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            return intent.getData();
        }
        if (!Intent.ACTION_SEND.equals(intent.getAction())) {
            return null;
        }
        Uri stream = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) {
            return stream;
        }
        ClipData clipData = intent.getClipData();
        if (clipData != null && clipData.getItemCount() == 1) {
            return clipData.getItemAt(0).getUri();
        }
        return intent.getData();
    }

    private void handleIncomingDocument(@Nullable Intent intent) {
        if (intent == null || (!Intent.ACTION_VIEW.equals(intent.getAction())
                && !Intent.ACTION_SEND.equals(intent.getAction()))) {
            return;
        }
        ClipData clipData = intent.getClipData();
        if (Intent.ACTION_SEND.equals(intent.getAction())
                && clipData != null && clipData.getItemCount() > 1) {
            Toast.makeText(this, "一次只能打开一个 .ecomic 文件", Toast.LENGTH_LONG).show();
            return;
        }
        Uri uri = getIncomingDocumentUri(intent);
        if (uri == null || !("content".equalsIgnoreCase(uri.getScheme())
                || "file".equalsIgnoreCase(uri.getScheme()))) {
            Toast.makeText(this, "只能打开 .ecomic 文件", Toast.LENGTH_LONG).show();
            return;
        }
        String displayName = null;
        long size = -1;
        try (Cursor cursor = getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                null,
                null,
                null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = cursor.getString(nameIndex);
                }
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    size = cursor.getLong(sizeIndex);
                }
            }
        } catch (RuntimeException ignored) {
            // Fall back to the URI path and descriptor metadata below.
        }
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = Uri.decode(uri.getLastPathSegment());
        }
        displayName = displayName == null ? "" : displayName.trim();
        if (!displayName.toLowerCase(Locale.ROOT).endsWith(".ecomic")) {
            Toast.makeText(this, "只能打开 .ecomic 文件", Toast.LENGTH_LONG).show();
            return;
        }
        try (ParcelFileDescriptor descriptor = getContentResolver().openFileDescriptor(uri, "r")) {
            if (descriptor == null) {
                throw new IOException("Document cannot be opened");
            }
            if (size < 0) {
                size = descriptor.getStatSize();
            }
        } catch (IOException | SecurityException error) {
            Toast.makeText(this, "无法读取这个 .ecomic 文件", Toast.LENGTH_LONG).show();
            return;
        }
        if (size == 0 || size > MAX_INCOMING_ARCHIVE_BYTES) {
            Toast.makeText(this, "该 .ecomic 文件为空或超过大小限制", Toast.LENGTH_LONG).show();
            return;
        }
        synchronized (fileBridge) {
            fileBridge.abortIncomingDocument(null);
            pendingIncomingDocument = new PendingIncomingDocument(
                    UUID.randomUUID().toString(),
                    uri,
                    displayName,
                    size
            );
        }
        notifyIncomingDocument();
    }

    private void notifyIncomingDocument() {
        if (webAppReady && webView != null && pendingIncomingDocument != null) {
            webView.evaluateJavascript(
                    "window.EcrypteesAndroidIncoming&&window.EcrypteesAndroidIncoming.receive()",
                    null
            );
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    private void handleBackNavigation(OnBackPressedCallback callback) {
        if (webView == null) {
            callback.setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(() => { if (globalThis.EcrypteesAppNavigation?.closeDrawer?.()) return true;"
                        + "const dialog = document.querySelector('dialog[open]');"
                        + "if (!dialog) return false;"
                        + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
                        + "return true; })()",
                value -> {
                    if ("true".equals(value)) {
                        return;
                    }
                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        callback.setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                }
        );
    }

    @Override
    protected void onDestroy() {
        webAppReady = false;
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        fileBridge.abortIncomingDocument(null);
        fileBridge.abortCurrentDownload(false);
        fileBridge.shutdownHeicDecodes();
        remoteNetworkBridge.shutdown();
        if (webView != null) {
            rootView.removeView(webView);
            webView.removeJavascriptInterface("AndroidFileBridge");
            webView.removeJavascriptInterface("AndroidNetworkBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static String safeMimeType(String mimeType, String fileName) {
        if (fileName != null && fileName.toLowerCase(Locale.ROOT).endsWith(".ecomic")) {
            return ECOMIC_MIME_TYPE;
        }
        if (mimeType != null && mimeType.contains("/")) {
            return mimeType;
        }
        String extension = MimeTypeMap.getFileExtensionFromUrl(fileName).toLowerCase(Locale.ROOT);
        String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return detected == null ? "application/octet-stream" : detected;
    }

    private void cleanupStaleHeicFiles() {
        File[] files = getCacheDir().listFiles((directory, name) -> name.startsWith(HEIC_CACHE_PREFIX));
        if (files == null) {
            return;
        }
        for (File file : files) {
            file.delete();
        }
    }

    private void cleanupStaleRemoteFiles() {
        File[] files = getCacheDir().listFiles((directory, name) -> name.startsWith(REMOTE_CACHE_PREFIX));
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.isFile()) {
                file.delete();
            }
        }
    }

    private void cleanupStaleRenderedFiles() {
        File[] files = getCacheDir().listFiles((directory, name) -> name.startsWith(RENDER_CACHE_PREFIX));
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.isFile()) {
                file.delete();
            }
        }
    }

    private static int calculateSampleSize(int width, int height, int maxDimension) {
        if (maxDimension <= 0) {
            return 1;
        }
        int sampleSize = 1;
        while (Math.max(width / sampleSize, height / sampleSize) > maxDimension && sampleSize <= 64) {
            sampleSize *= 2;
        }
        return sampleSize;
    }

    private Bitmap decodeHeicBitmap(File input, int maxDimension, int[] sourceSize) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(input), (decoder, info, source) -> {
                Size size = info.getSize();
                sourceSize[0] = size.getWidth();
                sourceSize[1] = size.getHeight();
                long pixels = (long) size.getWidth() * size.getHeight();
                if (size.getWidth() <= 0 || size.getHeight() <= 0 || pixels > MAX_NATIVE_IMAGE_PIXELS) {
                    throw new IllegalArgumentException("HEIC/HEIF 图片像素尺寸过大");
                }
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                decoder.setMemorySizePolicy(ImageDecoder.MEMORY_POLICY_DEFAULT);
                decoder.setOnPartialImageListener(error -> false);
                if (maxDimension > 0 && Math.max(size.getWidth(), size.getHeight()) > maxDimension) {
                    double scale = (double) maxDimension / Math.max(size.getWidth(), size.getHeight());
                    decoder.setTargetSize(
                            Math.max(1, (int) Math.round(size.getWidth() * scale)),
                            Math.max(1, (int) Math.round(size.getHeight() * scale))
                    );
                }
            });
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(input.getAbsolutePath(), bounds);
        sourceSize[0] = bounds.outWidth;
        sourceSize[1] = bounds.outHeight;
        long pixels = (long) bounds.outWidth * bounds.outHeight;
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || pixels > MAX_NATIVE_IMAGE_PIXELS) {
            throw new IOException("HEIC/HEIF 图片无法解码或像素尺寸过大");
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inSampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight, maxDimension);
        Bitmap bitmap = BitmapFactory.decodeFile(input.getAbsolutePath(), options);
        if (bitmap == null) {
            throw new IOException("Android 系统无法解码该 HEIC/HEIF 图片");
        }
        return bitmap;
    }

    public final class RemoteNetworkBridge {
        private final Map<String, RemoteFetchTask> tasks = new ConcurrentHashMap<>();
        private final Map<String, RenderedPageTask> renderedTasks = new ConcurrentHashMap<>();
        private final ExecutorService executor = Executors.newFixedThreadPool(2);
        private final RenderedCaptureReceiver renderedCaptureReceiver = new RenderedCaptureReceiver();

        @JavascriptInterface
        public String beginRenderedPageCapture(String rawUrl, int requestedMaximum) {
            String url = normalizeHttpsUrl(rawUrl);
            if (url == null) {
                return "";
            }
            int maximum = Math.max(1, Math.min(80, requestedMaximum));
            String token = UUID.randomUUID().toString();
            RenderedPageTask task = new RenderedPageTask(token, url, maximum);
            renderedTasks.put(token, task);
            runOnUiThread(() -> createRenderedWebView(task));
            return token;
        }

        @JavascriptInterface
        public String getRenderedPageCaptureStatus(String token) {
            RenderedPageTask task = renderedTasks.get(token);
            JSONObject result = new JSONObject();
            try {
                if (task == null) {
                    result.put("state", "error");
                    result.put("error", "动态网页任务不存在或已经释放");
                    return result.toString();
                }
                result.put("state", task.state);
                result.put("error", task.error);
                result.put("finalUrl", task.finalUrl);
                JSONArray images = new JSONArray();
                synchronized (task) {
                    for (CapturedRenderedImage image : task.images) {
                        JSONObject item = new JSONObject();
                        item.put("index", image.index);
                        item.put("name", image.name);
                        item.put("mime", image.mime);
                        item.put("size", image.size);
                        images.put(item);
                    }
                }
                result.put("images", images);
                return result.toString();
            } catch (Exception error) {
                return "{\"state\":\"error\",\"error\":\"无法读取动态网页状态\"}";
            }
        }

        @JavascriptInterface
        public String readRenderedPageImageChunk(String token, int index, long offset, int requestedBytes) {
            RenderedPageTask task = renderedTasks.get(token);
            CapturedRenderedImage image = task == null ? null : task.findImage(index);
            if (image == null || !"ready".equals(task.state)) {
                return "";
            }
            int length = Math.max(1, Math.min(MAX_NATIVE_CHUNK_BYTES, requestedBytes));
            synchronized (image) {
                try {
                    if (image.reader == null) {
                        image.reader = new RandomAccessFile(image.file, "r");
                    }
                    image.reader.seek(Math.max(0, offset));
                    byte[] bytes = new byte[length];
                    int count = image.reader.read(bytes);
                    return count < 0 ? "" : Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP);
                } catch (IOException error) {
                    task.fail("读取动态网页图片失败");
                    return "";
                }
            }
        }

        @JavascriptInterface
        public void releaseRenderedPageCapture(String token) {
            RenderedPageTask task = renderedTasks.remove(token);
            if (task != null) {
                task.cancelAndCleanup();
            }
        }

        private boolean navigateRenderedPage(String token, String rawUrl) {
            RenderedPageTask task = renderedTasks.get(token);
            String url = normalizeHttpsUrl(rawUrl);
            if (task == null || url == null || task.webView == null || task.redirects >= 5) {
                return false;
            }
            try {
                URL current = new URL(task.finalUrl.isEmpty() ? task.initialUrl : task.finalUrl);
                URL destination = new URL(url);
                if (!current.getHost().equalsIgnoreCase(destination.getHost())) {
                    return false;
                }
            } catch (Exception error) {
                return false;
            }
            task.state = "loading";
            task.error = "";
            runOnUiThread(() -> {
                if (renderedTasks.containsKey(token) && task.webView != null) {
                    task.webView.loadUrl(url);
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean beginRenderedImage(String token, int index, String rawName, String rawMime, long expectedSize) {
            RenderedPageTask task = renderedTasks.get(token);
            if (task == null || index != task.images.size() || index >= task.maximum
                    || expectedSize <= 0 || expectedSize > MAX_NATIVE_INPUT_BYTES
                    || task.totalBytes + expectedSize > MAX_NATIVE_INPUT_BYTES) {
                return false;
            }
            String name = rawName == null ? "page-" + (index + 1) + ".jpg" : rawName;
            name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
            String mime = rawMime != null && rawMime.startsWith("image/") ? rawMime : "application/octet-stream";
            File file = new File(getCacheDir(), RENDER_CACHE_PREFIX + token + "-" + index + ".tmp");
            try {
                CapturedRenderedImage image = new CapturedRenderedImage(index, name, mime, expectedSize, file);
                image.output = new FileOutputStream(file, false);
                synchronized (task) {
                    task.images.add(image);
                    task.totalBytes += expectedSize;
                }
                return true;
            } catch (IOException error) {
                file.delete();
                task.fail("无法创建动态网页图片临时文件");
                return false;
            }
        }

        @JavascriptInterface
        public boolean writeRenderedImageChunk(String token, int index, String encoded) {
            RenderedPageTask task = renderedTasks.get(token);
            CapturedRenderedImage image = task == null ? null : task.findImage(index);
            if (image == null || image.output == null || encoded == null) {
                return false;
            }
            try {
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (image.written + bytes.length > image.size) {
                    throw new IOException("Dynamic image is larger than declared");
                }
                image.output.write(bytes);
                image.written += bytes.length;
                return true;
            } catch (Exception error) {
                task.fail("动态网页图片写入失败");
                return false;
            }
        }

        @JavascriptInterface
        public boolean finishRenderedImage(String token, int index) {
            RenderedPageTask task = renderedTasks.get(token);
            CapturedRenderedImage image = task == null ? null : task.findImage(index);
            if (image == null || image.output == null) {
                return false;
            }
            try {
                image.output.flush();
                image.output.close();
                image.output = null;
                if (image.written != image.size) {
                    throw new IOException("Dynamic image is incomplete");
                }
                return true;
            } catch (IOException error) {
                task.fail("动态网页图片写入不完整");
                return false;
            }
        }

        @JavascriptInterface
        public void finishRenderedPage(String token, int count) {
            RenderedPageTask task = renderedTasks.get(token);
            if (task == null) {
                return;
            }
            synchronized (task) {
                if (count <= 0 || task.images.size() != count
                        || task.images.stream().anyMatch(image -> image.output != null || image.written != image.size)) {
                    task.fail("动态网页图片捕获不完整");
                    return;
                }
                task.state = "ready";
            }
            destroyRenderedWebView(task);
        }

        @JavascriptInterface
        public void failRenderedPage(String token, String message) {
            RenderedPageTask task = renderedTasks.get(token);
            if (task != null) {
                task.fail(message == null || message.isEmpty() ? "动态网页分析失败" : message);
            }
        }

        @JavascriptInterface
        public String beginRemoteFetch(String rawUrl, String kind, String rawReferer) {
            if (!"html".equals(kind) && !"image".equals(kind)) {
                return "";
            }
            String url = normalizeHttpsUrl(rawUrl);
            if (url == null) {
                return "";
            }
            String referer = normalizeHttpsUrl(rawReferer);
            if (referer == null) {
                referer = "";
            }
            String token = UUID.randomUUID().toString();
            File file = new File(getCacheDir(), REMOTE_CACHE_PREFIX + token + ".tmp");
            RemoteFetchTask task = new RemoteFetchTask(token, url, kind, referer, file);
            tasks.put(token, task);
            task.future = executor.submit(() -> runRemoteFetch(task));
            return token;
        }

        @JavascriptInterface
        public String getRemoteFetchStatus(String token) {
            RemoteFetchTask task = tasks.get(token);
            JSONObject status = new JSONObject();
            try {
                if (task == null) {
                    status.put("state", "error");
                    status.put("error", "网络任务不存在或已经释放");
                    return status.toString();
                }
                status.put("state", task.state);
                status.put("finalUrl", task.finalUrl);
                status.put("contentType", task.contentType);
                status.put("contentLength", task.contentLength);
                status.put("bytesRead", task.bytesRead);
                status.put("error", task.error);
                return status.toString();
            } catch (Exception error) {
                return "{\"state\":\"error\",\"error\":\"网络状态读取失败\"}";
            }
        }

        @JavascriptInterface
        public String readRemoteFetchChunk(String token, int requestedBytes) {
            RemoteFetchTask task = tasks.get(token);
            if (task == null || !"ready".equals(task.state)) {
                return "";
            }
            int length = Math.max(1, Math.min(MAX_NATIVE_CHUNK_BYTES, requestedBytes));
            synchronized (task) {
                try {
                    if (task.reader == null) {
                        task.reader = new RandomAccessFile(task.file, "r");
                    }
                    byte[] buffer = new byte[length];
                    int count = task.reader.read(buffer);
                    if (count < 0) {
                        return "";
                    }
                    return Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP);
                } catch (IOException error) {
                    task.state = "error";
                    task.error = "读取网络临时文件失败";
                    return "";
                }
            }
        }

        @JavascriptInterface
        public void cancelRemoteFetch(String token) {
            RemoteFetchTask task = tasks.get(token);
            if (task != null) {
                task.cancel();
            }
        }

        @JavascriptInterface
        public void releaseRemoteFetch(String token) {
            RemoteFetchTask task = tasks.remove(token);
            if (task != null) {
                task.cancelAndCleanup();
            }
        }

        private void runRemoteFetch(RemoteFetchTask task) {
            task.state = "running";
            String currentUrl = task.initialUrl;
            try {
                for (int redirect = 0; redirect <= 5; redirect++) {
                    if (task.cancelled || Thread.currentThread().isInterrupted()) {
                        throw new IOException("请求已取消");
                    }
                    URL url = new URL(currentUrl);
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    task.connection = connection;
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(30_000);
                    connection.setUseCaches(false);
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    connection.setRequestProperty("User-Agent", "Ecryptees/1.0.13 Android");
                    connection.setRequestProperty(
                            "Accept",
                            "html".equals(task.kind)
                                    ? "text/html,application/xhtml+xml"
                                    : "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
                    );
                    if ("image".equals(task.kind) && !task.referer.isEmpty()) {
                        connection.setRequestProperty("Referer", task.referer);
                    }
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        String location = connection.getHeaderField("Location");
                        connection.disconnect();
                        task.connection = null;
                        if (location == null || location.isEmpty() || redirect == 5) {
                            throw new IOException("网页重定向次数过多或地址无效");
                        }
                        String redirected = normalizeHttpsUrl(new URL(url, location).toString());
                        if (redirected == null) {
                            throw new IOException("请求重定向到了非 HTTPS 地址");
                        }
                        currentUrl = redirected;
                        continue;
                    }
                    if (status < 200 || status >= 300) {
                        connection.disconnect();
                        task.connection = null;
                        throw new IOException("HTTP " + status);
                    }
                    task.finalUrl = currentUrl;
                    task.contentType = connection.getContentType() == null ? "" : connection.getContentType();
                    task.contentLength = connection.getContentLengthLong();
                    long maximum = "html".equals(task.kind) ? MAX_REMOTE_HTML_BYTES : MAX_NATIVE_INPUT_BYTES;
                    if (task.contentLength > maximum) {
                        throw new IOException("html".equals(task.kind)
                                ? "网页 HTML 不能超过 5 MiB"
                                : "图片体积不能超过 500 MiB");
                    }
                    try (InputStream input = new BufferedInputStream(connection.getInputStream());
                         OutputStream output = new FileOutputStream(task.file, false)) {
                        byte[] buffer = new byte[64 * 1024];
                        long total = 0;
                        while (true) {
                            if (task.cancelled || Thread.currentThread().isInterrupted()) {
                                throw new IOException("请求已取消");
                            }
                            int count = input.read(buffer);
                            if (count < 0) {
                                break;
                            }
                            total += count;
                            if (total > maximum) {
                                throw new IOException("html".equals(task.kind)
                                        ? "网页 HTML 不能超过 5 MiB"
                                        : "图片体积不能超过 500 MiB");
                            }
                            output.write(buffer, 0, count);
                            task.bytesRead = total;
                        }
                        output.flush();
                    } finally {
                        connection.disconnect();
                        task.connection = null;
                    }
                    if (task.cancelled) {
                        throw new IOException("请求已取消");
                    }
                    task.contentLength = task.bytesRead;
                    task.state = "ready";
                    return;
                }
            } catch (Exception error) {
                HttpURLConnection activeConnection = task.connection;
                if (activeConnection != null) {
                    activeConnection.disconnect();
                }
                task.error = error.getMessage() == null ? "网络请求失败" : error.getMessage();
                task.state = task.cancelled ? "cancelled" : "error";
                task.cleanupFile();
            } finally {
                task.connection = null;
            }
        }

        @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
        private void createRenderedWebView(RenderedPageTask task) {
            if (!renderedTasks.containsKey(task.token) || isFinishing() || isDestroyed()) {
                task.fail("应用已经关闭");
                return;
            }
            CookieManager.getInstance().removeAllCookies(null);
            WebView rendered = new WebView(MainActivity.this);
            task.webView = rendered;
            rendered.setAlpha(0.01f);
            rendered.setClickable(false);
            rendered.setFocusable(false);
            rendered.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            ));
            rootView.addView(rendered, 0);
            WebSettings settings = rendered.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(false);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setGeolocationEnabled(false);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setUserAgentString(settings.getUserAgentString() + " EcrypteesCapture/1.0");
            CookieManager.getInstance().setAcceptThirdPartyCookies(rendered, false);
            rendered.addJavascriptInterface(renderedCaptureReceiver, "AndroidRenderedCapture");
            rendered.setWebViewClient(new WebViewClientCompat() {
                @Override
                public void onPageStarted(@NonNull WebView view, @NonNull String url, Bitmap favicon) {
                    super.onPageStarted(view, url, favicon);
                    if ("capturing".equals(task.state)) {
                        task.state = "loading";
                    }
                }

                @Override
                public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (!"https".equalsIgnoreCase(uri.getScheme())) {
                        return true;
                    }
                    if (request.isForMainFrame()) {
                        task.redirects += 1;
                        if (task.redirects > 5) {
                            task.fail("动态网页重定向次数过多");
                            return true;
                        }
                    }
                    return false;
                }

                @Override
                public void onPageFinished(@NonNull WebView view, @NonNull String url) {
                    super.onPageFinished(view, url);
                    if (!renderedTasks.containsKey(task.token) || !"loading".equals(task.state)) {
                        return;
                    }
                    task.finalUrl = url;
                    view.postDelayed(() -> injectRenderedCapture(task), 1200);
                }

                @Override
                public boolean onRenderProcessGone(
                        @NonNull WebView view,
                        @NonNull RenderProcessGoneDetail detail
                ) {
                    task.fail("动态网页进程意外退出");
                    return true;
                }
            });
            rendered.loadUrl(task.initialUrl);
            rendered.postDelayed(() -> {
                if ("loading".equals(task.state) || "capturing".equals(task.state)) {
                    task.fail("动态网页等待图片超时");
                }
            }, 240_000);
        }

        private void injectRenderedCapture(RenderedPageTask task) {
            WebView rendered = task.webView;
            if (rendered == null || !"loading".equals(task.state)) {
                return;
            }
            try (InputStream input = getAssets().open("js/render-capture.js");
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, count);
                }
                String source = output.toString("UTF-8");
                String bootstrap = "globalThis.__ECRYPTEES_CAPTURE_TOKEN__="
                        + JSONObject.quote(task.token)
                        + ";globalThis.__ECRYPTEES_CAPTURE_MAXIMUM__=" + task.maximum + ";";
                task.state = "capturing";
                rendered.evaluateJavascript(bootstrap + source, null);
            } catch (IOException error) {
                task.fail("无法载入动态网页捕获程序");
            }
        }

        private void destroyRenderedWebView(RenderedPageTask task) {
            runOnUiThread(() -> {
                WebView rendered = task.webView;
                task.webView = null;
                if (rendered != null) {
                    rendered.stopLoading();
                    rendered.loadUrl("about:blank");
                    rendered.clearHistory();
                    rendered.clearCache(true);
                    rendered.removeJavascriptInterface("AndroidRenderedCapture");
                    rootView.removeView(rendered);
                    rendered.destroy();
                }
                try {
                    Uri uri = Uri.parse(task.finalUrl.isEmpty() ? task.initialUrl : task.finalUrl);
                    String origin = uri.getScheme() + "://" + uri.getAuthority();
                    WebStorage.getInstance().deleteOrigin(origin);
                } catch (Exception ignored) {
                    // Ephemeral WebView cleanup is best-effort.
                }
                CookieManager.getInstance().removeAllCookies(null);
            });
        }

        private String normalizeHttpsUrl(String value) {
            if (value == null || value.trim().isEmpty()) {
                return null;
            }
            try {
                URL url = new URL(value.trim());
                if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getHost().isEmpty()) {
                    return null;
                }
                return url.toString();
            } catch (Exception error) {
                return null;
            }
        }

        void abortAll() {
            for (RemoteFetchTask task : tasks.values()) {
                task.cancelAndCleanup();
            }
            tasks.clear();
            for (RenderedPageTask task : renderedTasks.values()) {
                task.cancelAndCleanup();
            }
            renderedTasks.clear();
        }

        void shutdown() {
            abortAll();
            executor.shutdownNow();
        }

        private final class RenderedPageTask {
            final String token;
            final String initialUrl;
            final int maximum;
            final List<CapturedRenderedImage> images = new ArrayList<>();
            volatile String state = "loading";
            volatile String error = "";
            volatile String finalUrl = "";
            volatile WebView webView;
            volatile int redirects;
            long totalBytes;

            RenderedPageTask(String token, String initialUrl, int maximum) {
                this.token = token;
                this.initialUrl = initialUrl;
                this.maximum = maximum;
            }

            synchronized CapturedRenderedImage findImage(int index) {
                return index >= 0 && index < images.size() ? images.get(index) : null;
            }

            void fail(String message) {
                if ("ready".equals(state) || "cancelled".equals(state)) {
                    return;
                }
                error = message;
                state = "error";
                destroyRenderedWebView(this);
            }

            void cancelAndCleanup() {
                state = "cancelled";
                destroyRenderedWebView(this);
                synchronized (this) {
                    for (CapturedRenderedImage image : images) {
                        image.cleanup();
                    }
                    images.clear();
                }
            }
        }

        private final class RenderedCaptureReceiver {
            @JavascriptInterface
            public int getRenderedImageCount(String token) {
                RenderedPageTask task = renderedTasks.get(token);
                return task == null ? 0 : task.images.size();
            }

            @JavascriptInterface
            public boolean navigateRenderedPage(String token, String url) {
                return RemoteNetworkBridge.this.navigateRenderedPage(token, url);
            }

            @JavascriptInterface
            public boolean beginRenderedImage(String token, int index, String name, String mime, long size) {
                return RemoteNetworkBridge.this.beginRenderedImage(token, index, name, mime, size);
            }

            @JavascriptInterface
            public boolean writeRenderedImageChunk(String token, int index, String encoded) {
                return RemoteNetworkBridge.this.writeRenderedImageChunk(token, index, encoded);
            }

            @JavascriptInterface
            public boolean finishRenderedImage(String token, int index) {
                return RemoteNetworkBridge.this.finishRenderedImage(token, index);
            }

            @JavascriptInterface
            public void finishRenderedPage(String token, int count) {
                RemoteNetworkBridge.this.finishRenderedPage(token, count);
            }

            @JavascriptInterface
            public void failRenderedPage(String token, String message) {
                RemoteNetworkBridge.this.failRenderedPage(token, message);
            }
        }

        private final class CapturedRenderedImage {
            final int index;
            final String name;
            final String mime;
            final long size;
            final File file;
            long written;
            OutputStream output;
            RandomAccessFile reader;

            CapturedRenderedImage(int index, String name, String mime, long size, File file) {
                this.index = index;
                this.name = name;
                this.mime = mime;
                this.size = size;
                this.file = file;
            }

            void cleanup() {
                try {
                    if (output != null) {
                        output.close();
                    }
                } catch (IOException ignored) {
                    // Best-effort cleanup.
                }
                try {
                    if (reader != null) {
                        reader.close();
                    }
                } catch (IOException ignored) {
                    // Best-effort cleanup.
                }
                output = null;
                reader = null;
                file.delete();
            }
        }

        private final class RemoteFetchTask {
            final String token;
            final String initialUrl;
            final String kind;
            final String referer;
            final File file;
            volatile String state = "queued";
            volatile String finalUrl = "";
            volatile String contentType = "";
            volatile long contentLength = -1;
            volatile long bytesRead;
            volatile String error = "";
            volatile boolean cancelled;
            volatile HttpURLConnection connection;
            Future<?> future;
            RandomAccessFile reader;

            RemoteFetchTask(String token, String initialUrl, String kind, String referer, File file) {
                this.token = token;
                this.initialUrl = initialUrl;
                this.kind = kind;
                this.referer = referer;
                this.file = file;
            }

            void cancel() {
                cancelled = true;
                state = "cancelled";
                HttpURLConnection activeConnection = connection;
                if (activeConnection != null) {
                    activeConnection.disconnect();
                }
                Future<?> activeFuture = future;
                if (activeFuture != null) {
                    activeFuture.cancel(true);
                }
            }

            void cancelAndCleanup() {
                cancel();
                synchronized (this) {
                    if (reader != null) {
                        try {
                            reader.close();
                        } catch (IOException ignored) {
                            // Best-effort cleanup.
                        }
                        reader = null;
                    }
                }
                cleanupFile();
            }

            void cleanupFile() {
                if (file.exists()) {
                    file.delete();
                }
            }
        }
    }

    public final class FileBridge {
        private final Map<String, HeicTask> heicTasks = new ConcurrentHashMap<>();
        private final ExecutorService heicExecutor = Executors.newFixedThreadPool(2);
        private final Semaphore fullSizeDecodeSlot = new Semaphore(1, true);

        @JavascriptInterface
        public String getAppVersionInfo() {
            try {
                JSONObject result = new JSONObject();
                result.put("versionName", BuildConfig.VERSION_NAME);
                result.put("versionCode", BuildConfig.VERSION_CODE);
                return result.toString();
            } catch (Exception error) {
                return "{\"versionName\":\"\",\"versionCode\":0}";
            }
        }

        @JavascriptInterface
        public boolean isLauncherDisguiseEnabled() {
            ComponentName calculator = launcherComponent("CalculatorLauncher");
            return getPackageManager().getComponentEnabledSetting(calculator)
                    == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        }

        @JavascriptInterface
        public boolean setLauncherDisguiseEnabled(boolean enabled) {
            ComponentName ecryptees = launcherComponent("EcrypteesLauncher");
            ComponentName calculator = launcherComponent("CalculatorLauncher");
            ComponentName componentToEnable = enabled ? calculator : ecryptees;
            ComponentName componentToDisable = enabled ? ecryptees : calculator;
            try {
                PackageManager manager = getPackageManager();
                manager.setComponentEnabledSetting(
                        componentToEnable,
                        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        PackageManager.DONT_KILL_APP
                );
                manager.setComponentEnabledSetting(
                        componentToDisable,
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP
                );
                return true;
            } catch (RuntimeException error) {
                return false;
            }
        }

        private ComponentName launcherComponent(String shortName) {
            return new ComponentName(
                    MainActivity.this,
                    getPackageName() + "." + shortName
            );
        }

        @JavascriptInterface
        public synchronized String claimIncomingDocument() {
            PendingIncomingDocument document = pendingIncomingDocument;
            if (document == null || document.claimed || incomingDocumentStream != null) {
                return "";
            }
            try {
                InputStream stream = getContentResolver().openInputStream(document.uri);
                if (stream == null) {
                    throw new IOException("Document cannot be opened");
                }
                incomingDocumentStream = stream;
                incomingDocumentBytesRead = 0;
                document.claimed = true;
                return "{\"token\":" + JSONObject.quote(document.token)
                        + ",\"name\":" + JSONObject.quote(document.name)
                        + ",\"size\":" + document.size + "}";
            } catch (IOException | SecurityException error) {
                abortIncomingDocument(document.token);
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        "无法读取这个 .ecomic 文件",
                        Toast.LENGTH_LONG
                ).show());
                return "";
            }
        }

        @JavascriptInterface
        @Nullable
        public synchronized String readIncomingChunk(String token, int requestedLength) {
            PendingIncomingDocument document = pendingIncomingDocument;
            if (document == null || incomingDocumentStream == null || !document.token.equals(token)) {
                return null;
            }
            int length = Math.max(1, Math.min(requestedLength, MAX_NATIVE_CHUNK_BYTES));
            byte[] bytes = new byte[length];
            try {
                int read = incomingDocumentStream.read(bytes);
                if (read < 0) {
                    if (document.size >= 0 && incomingDocumentBytesRead != document.size) {
                        abortIncomingDocument(token);
                        return null;
                    }
                    return "";
                }
                incomingDocumentBytesRead += read;
                if (incomingDocumentBytesRead > MAX_INCOMING_ARCHIVE_BYTES
                        || (document.size >= 0 && incomingDocumentBytesRead > document.size)) {
                    abortIncomingDocument(token);
                    return null;
                }
                return Base64.encodeToString(bytes, 0, read, Base64.NO_WRAP);
            } catch (IOException | SecurityException error) {
                abortIncomingDocument(token);
                return null;
            }
        }

        @JavascriptInterface
        public synchronized boolean finishIncomingDocument(String token) {
            PendingIncomingDocument document = pendingIncomingDocument;
            if (document == null || !document.token.equals(token)) {
                return false;
            }
            boolean complete = document.size < 0 || incomingDocumentBytesRead == document.size;
            closeIncomingDocumentStream();
            pendingIncomingDocument = null;
            incomingDocumentBytesRead = 0;
            return complete;
        }

        @JavascriptInterface
        public synchronized void abortIncomingDocument(@Nullable String token) {
            if (pendingIncomingDocument != null
                    && token != null
                    && !pendingIncomingDocument.token.equals(token)) {
                return;
            }
            closeIncomingDocumentStream();
            pendingIncomingDocument = null;
            incomingDocumentBytesRead = 0;
        }

        private void closeIncomingDocumentStream() {
            if (incomingDocumentStream != null) {
                try {
                    incomingDocumentStream.close();
                } catch (IOException ignored) {
                    // Best-effort cleanup for a provider-owned stream.
                }
                incomingDocumentStream = null;
            }
        }

        @JavascriptInterface
        public boolean beginDownload(String name, String mimeType, String blobUrl) {
            if (blobUrl == null || !blobUrl.startsWith("blob:")) {
                return false;
            }
            String safeName = name == null || name.trim().isEmpty() ? "download.bin" : name.trim();
            synchronized (this) {
                if (pendingDownload != null || downloadStream != null) {
                    runOnUiThread(() -> Toast.makeText(
                            MainActivity.this,
                            R.string.download_busy,
                            Toast.LENGTH_SHORT
                    ).show());
                    return false;
                }
                pendingDownload = new PendingDownload(safeName, safeMimeType(mimeType, safeName), blobUrl);
            }
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(safeMimeType(mimeType, safeName));
                intent.putExtra(Intent.EXTRA_TITLE, safeName);
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                try {
                    startActivityForResult(intent, REQUEST_SAVE_FILE);
                } catch (ActivityNotFoundException error) {
                    synchronized (FileBridge.this) {
                        pendingDownload = null;
                    }
                    Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_LONG).show();
                    evaluateDownloadScript("failed()");
                }
            });
            return true;
        }

        @JavascriptInterface
        public synchronized boolean writeChunk(String token, String base64Data) {
            if (downloadStream == null || downloadToken == null || !downloadToken.equals(token)) {
                return false;
            }
            try {
                downloadStream.write(Base64.decode(base64Data, Base64.NO_WRAP));
                return true;
            } catch (IOException | IllegalArgumentException error) {
                abortCurrentDownload(true);
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean finishDownload(String token) {
            if (downloadStream == null || downloadToken == null || !downloadToken.equals(token)) {
                return false;
            }
            try {
                downloadStream.flush();
                downloadStream.close();
                clearActiveDownload();
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        R.string.download_saved,
                        Toast.LENGTH_SHORT
                ).show());
                return true;
            } catch (IOException error) {
                abortCurrentDownload(true);
                return false;
            }
        }

        @JavascriptInterface
        public synchronized void abortDownload(String token) {
            if (downloadToken != null && downloadToken.equals(token)) {
                abortCurrentDownload(true);
            }
        }

        private final class HeicTask {
            private final String token;
            private final File inputFile;
            private final File outputFile;
            private FileOutputStream inputStream;
            private Future<?> future;
            private long inputBytes;
            private int maxDimension;
            private int width;
            private int height;
            private int sourceWidth;
            private int sourceHeight;
            private long outputSize;
            private String state = "writing";
            private String error = "";
            private boolean cancelled;

            private HeicTask(String token, File inputFile, File outputFile, FileOutputStream inputStream) {
                this.token = token;
                this.inputFile = inputFile;
                this.outputFile = outputFile;
                this.inputStream = inputStream;
            }
        }

        @JavascriptInterface
        public boolean isHeicDecodeSupported() {
            return true;
        }

        @JavascriptInterface
        public synchronized String beginHeicDecode(String ignoredName) {
            if (heicTasks.size() >= 2 || heicExecutor.isShutdown()) {
                return "";
            }
            String token = UUID.randomUUID().toString();
            File input = new File(getCacheDir(), HEIC_CACHE_PREFIX + token + ".input");
            File output = new File(getCacheDir(), HEIC_CACHE_PREFIX + token + ".png");
            try {
                HeicTask task = new HeicTask(token, input, output, new FileOutputStream(input, false));
                heicTasks.put(token, task);
                return token;
            } catch (IOException | SecurityException error) {
                input.delete();
                output.delete();
                return "";
            }
        }

        @JavascriptInterface
        public boolean writeHeicChunk(String token, String base64Data) {
            HeicTask task = heicTasks.get(token);
            if (task == null) {
                return false;
            }
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.NO_WRAP);
                synchronized (task) {
                    if (!"writing".equals(task.state) || task.inputStream == null || task.cancelled
                            || bytes.length > MAX_NATIVE_CHUNK_BYTES
                            || task.inputBytes + bytes.length > MAX_NATIVE_INPUT_BYTES) {
                        throw new IOException("HEIC/HEIF 临时文件写入失败");
                    }
                    task.inputStream.write(bytes);
                    task.inputBytes += bytes.length;
                }
                return true;
            } catch (IOException | IllegalArgumentException error) {
                abortHeicDecode(token);
                return false;
            }
        }

        @JavascriptInterface
        public boolean commitHeicDecode(String token, int maxDimension) {
            HeicTask task = heicTasks.get(token);
            if (task == null) {
                return false;
            }
            try {
                synchronized (task) {
                    if (!"writing".equals(task.state) || task.inputStream == null || task.cancelled) {
                        return false;
                    }
                    task.inputStream.flush();
                    task.inputStream.close();
                    task.inputStream = null;
                    task.maxDimension = Math.max(0, Math.min(4096, maxDimension));
                    task.state = "queued";
                    task.future = heicExecutor.submit(() -> processHeicTask(task));
                }
                return true;
            } catch (IOException | RuntimeException error) {
                abortHeicDecode(token);
                return false;
            }
        }

        private void processHeicTask(HeicTask task) {
            Bitmap bitmap = null;
            boolean ownsFullSizeSlot = false;
            try {
                if (task.maxDimension == 0) {
                    fullSizeDecodeSlot.acquire();
                    ownsFullSizeSlot = true;
                }
                synchronized (task) {
                    if (task.cancelled || Thread.currentThread().isInterrupted()) {
                        throw new InterruptedException("HEIC/HEIF 解码已取消");
                    }
                    task.state = "processing";
                }
                int[] sourceSize = new int[2];
                bitmap = decodeHeicBitmap(task.inputFile, task.maxDimension, sourceSize);
                if (task.cancelled || Thread.currentThread().isInterrupted()) {
                    throw new InterruptedException("HEIC/HEIF 解码已取消");
                }
                try (FileOutputStream stream = new FileOutputStream(task.outputFile, false)) {
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                        throw new IOException("HEIC/HEIF 转换 PNG 失败");
                    }
                    stream.flush();
                }
                synchronized (task) {
                    if (task.cancelled || Thread.currentThread().isInterrupted()) {
                        throw new InterruptedException("HEIC/HEIF 解码已取消");
                    }
                    task.outputSize = task.outputFile.length();
                    task.width = bitmap.getWidth();
                    task.height = bitmap.getHeight();
                    task.sourceWidth = sourceSize[0];
                    task.sourceHeight = sourceSize[1];
                    task.state = "ready";
                }
            } catch (OutOfMemoryError error) {
                failHeicTask(task, "设备内存不足，无法解码这张 HEIC/HEIF 图片");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                synchronized (task) {
                    task.cancelled = true;
                    task.state = "cancelled";
                }
            } catch (Exception error) {
                failHeicTask(task, error.getMessage() == null ? "HEIC/HEIF 解码失败" : error.getMessage());
            } finally {
                task.inputFile.delete();
                synchronized (task) {
                    if (!"ready".equals(task.state)) {
                        task.outputFile.delete();
                    }
                }
                if (bitmap != null && !bitmap.isRecycled()) {
                    bitmap.recycle();
                }
                if (ownsFullSizeSlot) {
                    fullSizeDecodeSlot.release();
                }
            }
        }

        private void failHeicTask(HeicTask task, String message) {
            synchronized (task) {
                if (!task.cancelled) {
                    task.error = message;
                    task.state = "error";
                }
            }
        }

        @JavascriptInterface
        public String getHeicDecodeStatus(String token) {
            HeicTask task = heicTasks.get(token);
            JSONObject result = new JSONObject();
            try {
                if (task == null) {
                    result.put("state", "cancelled");
                    result.put("error", "HEIC/HEIF 解码任务已失效");
                    return result.toString();
                }
                synchronized (task) {
                    result.put("state", task.state);
                    if (!task.error.isEmpty()) {
                        result.put("error", task.error);
                    }
                    if ("ready".equals(task.state)) {
                        result.put("size", task.outputSize);
                        result.put("width", task.width);
                        result.put("height", task.height);
                        result.put("sourceWidth", task.sourceWidth);
                        result.put("sourceHeight", task.sourceHeight);
                    }
                }
                return result.toString();
            } catch (Exception error) {
                return "{\"state\":\"error\",\"error\":\"HEIC/HEIF 状态读取失败\"}";
            }
        }

        @JavascriptInterface
        public String readHeicChunk(String token, long offset, int requestedLength) {
            HeicTask task = heicTasks.get(token);
            if (task == null || offset < 0 || requestedLength <= 0 || requestedLength > MAX_NATIVE_CHUNK_BYTES) {
                return "";
            }
            synchronized (task) {
                if (!"ready".equals(task.state) || !task.outputFile.exists()) {
                    return "";
                }
                int length = (int) Math.min(requestedLength, Math.max(0, task.outputFile.length() - offset));
                if (length <= 0) {
                    return "";
                }
                byte[] bytes = new byte[length];
                try (RandomAccessFile input = new RandomAccessFile(task.outputFile, "r")) {
                    input.seek(offset);
                    input.readFully(bytes);
                    return Base64.encodeToString(bytes, Base64.NO_WRAP);
                } catch (IOException | SecurityException error) {
                    return "";
                }
            }
        }

        @JavascriptInterface
        public void releaseHeicDecode(String token) {
            HeicTask task = heicTasks.remove(token);
            if (task != null) {
                cleanupHeicTask(task);
            }
        }

        @JavascriptInterface
        public void abortHeicDecode(String token) {
            HeicTask task = heicTasks.remove(token);
            if (task != null) {
                cleanupHeicTask(task);
            }
        }

        private void cleanupHeicTask(HeicTask task) {
            synchronized (task) {
                task.cancelled = true;
                task.state = "cancelled";
                if (task.future != null) {
                    task.future.cancel(true);
                }
                if (task.inputStream != null) {
                    try {
                        task.inputStream.close();
                    } catch (IOException ignored) {
                        // Best-effort cleanup.
                    }
                    task.inputStream = null;
                }
                task.inputFile.delete();
                task.outputFile.delete();
            }
        }

        private void abortAllHeicDecodes() {
            for (String token : new ArrayList<>(heicTasks.keySet())) {
                abortHeicDecode(token);
            }
        }

        private void shutdownHeicDecodes() {
            abortAllHeicDecodes();
            heicExecutor.shutdownNow();
        }

        private synchronized void abortCurrentDownload(boolean notifyUser) {
            if (downloadStream != null) {
                try {
                    downloadStream.close();
                } catch (IOException ignored) {
                    // Best-effort cleanup after a failed or cancelled stream.
                }
            }
            if (downloadUri != null) {
                try {
                    DocumentsContract.deleteDocument(getContentResolver(), downloadUri);
                } catch (Exception ignored) {
                    // Some document providers do not support deleting partial files.
                }
            }
            clearActiveDownload();
            pendingDownload = null;
            if (notifyUser) {
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        R.string.download_failed,
                        Toast.LENGTH_LONG
                ).show());
                runOnUiThread(() -> evaluateDownloadScript("failed()"));
            }
        }

        private void clearActiveDownload() {
            downloadStream = null;
            downloadUri = null;
            downloadToken = null;
        }
    }

    private static final class PendingDownload {
        private final String name;
        private final String mimeType;
        private final String blobUrl;

        private PendingDownload(String name, String mimeType, String blobUrl) {
            this.name = name;
            this.mimeType = mimeType;
            this.blobUrl = blobUrl;
        }
    }

    private static final class PendingIncomingDocument {
        private final String token;
        private final Uri uri;
        private final String name;
        private final long size;
        private boolean claimed;

        private PendingIncomingDocument(String token, Uri uri, String name, long size) {
            this.token = token;
            this.uri = uri;
            this.name = name;
            this.size = size;
        }
    }
}
