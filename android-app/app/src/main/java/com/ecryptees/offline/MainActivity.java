package com.ecryptees.offline;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
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

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
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
    private static final int MAX_NATIVE_CHUNK_BYTES = 1024 * 1024;
    private static final String HEIC_CACHE_PREFIX = "ecryptees-heic-";

    private FrameLayout rootView;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean imageDocumentChooser;
    private final FileBridge fileBridge = new FileBridge();
    private PendingDownload pendingDownload;
    private OutputStream downloadStream;
    private Uri downloadUri;
    private String downloadToken;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(255, 64, 129));
        getWindow().setNavigationBarColor(Color.rgb(252, 228, 236));
        cleanupStaleHeicFiles();
        rootView = new FrameLayout(this);
        setContentView(rootView);
        createWebView(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackNavigation(this);
            }
        });
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
            public boolean onRenderProcessGone(
                    @NonNull WebView view,
                    @NonNull RenderProcessGoneDetail detail
            ) {
                fileBridge.abortCurrentDownload(false);
                fileBridge.abortAllHeicDecodes();
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
                "(() => { const dialog = document.querySelector('dialog[open]');"
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
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        fileBridge.abortCurrentDownload(false);
        fileBridge.shutdownHeicDecodes();
        if (webView != null) {
            rootView.removeView(webView);
            webView.removeJavascriptInterface("AndroidFileBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static String safeMimeType(String mimeType, String fileName) {
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

    public final class FileBridge {
        private final Map<String, HeicTask> heicTasks = new ConcurrentHashMap<>();
        private final ExecutorService heicExecutor = Executors.newFixedThreadPool(2);
        private final Semaphore fullSizeDecodeSlot = new Semaphore(1, true);

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
}
