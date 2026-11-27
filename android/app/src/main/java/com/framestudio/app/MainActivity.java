package com.framestudio.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends Activity {
    private static final String TAG = "FrameStudio";
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    private WebView webView;
    private LocalAssetServer localServer;
    private int localServerPort = -1;
    private ValueCallback<Uri[]> pendingFileCallback;
    private final Map<String, PendingWrite> pendingWrites = new ConcurrentHashMap<>();

    private static final class PendingWrite {
        final File tempFile;
        final OutputStream out;
        final String filename;
        final String mimeType;

        PendingWrite(File tempFile, OutputStream out, String filename, String mimeType) {
            this.tempFile = tempFile;
            this.out = out;
            this.filename = filename;
            this.mimeType = mimeType;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            requestWindowFeature(Window.FEATURE_NO_TITLE);
        } catch (Throwable ignored) {}

        super.onCreate(savedInstanceState);

        try {
            localServer = new LocalAssetServer(getAssets());
            localServer.start();
            localServerPort = localServer.getPort();
        } catch (Throwable t) {
            Log.w(TAG, "Loopback HTTP server unavailable, using WebView intercept", t);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0e14"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0b0e14"));
        root.addView(
            webView,
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        );
        setContentView(root);

        try {
            configureDarkSystemBars();
        } catch (Throwable ignored) {}
        try {
            applySystemBarInsets(root);
        } catch (Throwable ignored) {}

        configureWebView(webView);
        String startUrl = localServerPort > 0
            ? "http://127.0.0.1:" + localServerPort + "/index.html?offline=1&t=" + Uri.encode(localServer.getToken())
            : "https://" + ASSET_HOST + "/index.html?offline=1";
        webView.loadUrl(startUrl);
    }

    @SuppressWarnings("deprecation")
    private void configureDarkSystemBars() {
        Window window = getWindow();
        int bgDark = Color.parseColor("#0b0e14");
        window.setStatusBarColor(bgDark);
        window.setNavigationBarColor(bgDark);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                    0,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void applySystemBarInsets(final View root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                );
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(
                    insets.getSystemWindowInsetLeft(),
                    insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(),
                    insets.getSystemWindowInsetBottom()
                );
            }
            return insets;
        });
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        view.addJavascriptInterface(new FrameStudioBridge(), "FrameStudioNative");

        view.setWebViewClient(new WebViewClient() {
            private boolean isLocalOrigin(Uri url) {
                if (url == null) return false;
                String host = url.getHost();
                if (host == null) return false;
                return ASSET_HOST.equalsIgnoreCase(host)
                    || "127.0.0.1".equals(host)
                    || "localhost".equalsIgnoreCase(host);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url != null && (ASSET_HOST.equalsIgnoreCase(url.getHost())
                    || ("127.0.0.1".equals(url.getHost()) && url.getPort() == localServerPort))) {
                    return serveLocalAsset(url.getPath());
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isLocalOrigin(url)) {
                    return false;
                }
                if (url != null) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (Exception ignored) {}
                }
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                }
                pendingFileCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                if (fileChooserParams != null &&
                    fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select Media"), FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    if (pendingFileCallback != null) {
                        pendingFileCallback.onReceiveValue(null);
                        pendingFileCallback = null;
                    }
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                if (consoleMessage != null) {
                    Log.d(
                        TAG,
                        "[WebView] " + consoleMessage.message()
                            + " (" + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + ")"
                    );
                }
                return true;
            }
        });
    }

    private WebResourceResponse serveLocalAsset(String rawPath) {
        String rel = (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath))
            ? "index.html"
            : rawPath.replaceFirst("^/+", "");

        if (rel.contains("..")) {
            return notFoundResponse();
        }

        AssetManager assets = getAssets();
        try {
            InputStream stream = new BufferedInputStream(assets.open("static/" + rel));
            String mime = guessMimeType(rel);
            String encoding = isTextMime(mime) ? "UTF-8" : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
        } catch (IOException e) {
            return notFoundResponse();
        }
    }

    private WebResourceResponse notFoundResponse() {
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            404,
            "Not Found",
            new HashMap<>(),
            new ByteArrayInputStream(new byte[0])
        );
    }

    private static String guessMimeType(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private static boolean isTextMime(String mime) {
        return mime.startsWith("text/")
            || "application/javascript".equals(mime)
            || "application/json".equals(mime)
            || "image/svg+xml".equals(mime);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || pendingFileCallback == null) {
            return;
        }
        Uri[] uris = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> collected = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) collected.add(u);
                }
            } else if (data.getData() != null) {
                collected.add(data.getData());
            }
            if (!collected.isEmpty()) {
                uris = collected.toArray(new Uri[0]);
            }
        }
        pendingFileCallback.onReceiveValue(uris);
        pendingFileCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        for (PendingWrite pw : pendingWrites.values()) {
            try {
                pw.out.close();
            } catch (Exception ignored) {}
            if (pw.tempFile.exists()) {
                pw.tempFile.delete();
            }
        }
        pendingWrites.clear();
        if (localServer != null) {
            localServer.stop();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    public final class FrameStudioBridge {
        @JavascriptInterface
        public boolean isAndroidNative() {
            return true;
        }

        @JavascriptInterface
        public String getDeviceInfo() {
            String soc = Build.VERSION.SDK_INT >= 31 ? Build.SOC_MODEL : Build.HARDWARE;
            return "{\"model\":\"" + escapeJson(Build.MODEL)
                + "\",\"soc\":\"" + escapeJson(soc)
                + "\",\"release\":\"" + escapeJson(Build.VERSION.RELEASE)
                + "\",\"sdk\":" + Build.VERSION.SDK_INT + "}";
        }

        @JavascriptInterface
        public String beginFileWrite(String filename, String mimeType) {
            String safeName = sanitizeFilename(filename);
            String handle = UUID.randomUUID().toString();
            try {
                File tmp = new File(getCacheDir(), "export_" + handle + ".tmp");
                OutputStream out = new BufferedOutputStream(new FileOutputStream(tmp));
                pendingWrites.put(handle, new PendingWrite(tmp, out, safeName, mimeType));
                return handle;
            } catch (IOException e) {
                Log.e(TAG, "beginFileWrite failed", e);
                return "";
            }
        }

        @JavascriptInterface
        public boolean appendFileChunk(String handle, String base64Chunk) {
            PendingWrite pw = pendingWrites.get(handle);
            if (pw == null || base64Chunk == null) return false;
            try {
                byte[] bytes = Base64.decode(base64Chunk, Base64.DEFAULT);
                pw.out.write(bytes);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "appendFileChunk failed", e);
                return false;
            }
        }

        @JavascriptInterface
        public boolean finishFileWrite(String handle) {
            PendingWrite pw = pendingWrites.remove(handle);
            if (pw == null) return false;
            try {
                pw.out.flush();
                pw.out.close();
                commitTempFileToDownloads(pw.tempFile, pw.filename, pw.mimeType);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "finishFileWrite failed", e);
                showToast("Export failed: " + e.getMessage());
                return false;
            } finally {
                if (pw.tempFile.exists()) {
                    pw.tempFile.delete();
                }
            }
        }

        @JavascriptInterface
        public boolean saveBase64File(String filename, String mimeType, String base64Data) {
            String safeName = sanitizeFilename(filename);
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                File tmp = new File(getCacheDir(), "export_" + System.currentTimeMillis() + ".tmp");
                try (FileOutputStream fos = new FileOutputStream(tmp)) {
                    fos.write(bytes);
                }
                try {
                    commitTempFileToDownloads(tmp, safeName, mimeType);
                } finally {
                    if (tmp.exists()) tmp.delete();
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG, "saveBase64File failed", e);
                showToast("Save failed: " + e.getMessage());
                return false;
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void commitTempFileToDownloads(File tempFile, String filename, String mimeType) throws IOException {
        String safeMime = (mimeType == null || mimeType.trim().isEmpty())
            ? "application/octet-stream"
            : mimeType;

        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FrameStudio");
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("Could not create MediaStore entry");
            }
            try (OutputStream out = resolver.openOutputStream(uri);
                 InputStream in = new BufferedInputStream(new FileInputStream(tempFile))) {
                if (out == null) throw new IOException("Could not open MediaStore stream");
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                out.flush();
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, ready, null, null);
        } else {
            File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "FrameStudio"
            );
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("Could not create Downloads/FrameStudio directory");
            }
            File dest = new File(dir, filename);
            try (InputStream in = new BufferedInputStream(new FileInputStream(tempFile));
                 OutputStream out = new BufferedOutputStream(new FileOutputStream(dest))) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                out.flush();
            }
        }

        showToast("Saved to Downloads/FrameStudio/" + filename);
    }

    private void showToast(final String message) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
    }

    private static String sanitizeFilename(String name) {
        if (name == null || name.trim().isEmpty()) {
            return "framestudio_export.bin";
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static String escapeJson(String val) {
        return val == null ? "" : val.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static final class LocalAssetServer {
        private final AssetManager assets;
        private final String authToken;
        private ServerSocket serverSocket;
        private volatile boolean running;
        private Thread acceptThread;

        LocalAssetServer(AssetManager assets) throws IOException {
            this.assets = assets;
            this.authToken = UUID.randomUUID().toString();
            this.serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        }

        int getPort() {
            return serverSocket != null ? serverSocket.getLocalPort() : -1;
        }

        String getToken() {
            return authToken;
        }

        void start() {
            running = true;
            acceptThread = new Thread(() -> {
                while (running && serverSocket != null && !serverSocket.isClosed()) {
                    try {
                        final Socket client = serverSocket.accept();
                        Thread worker = new Thread(() -> handleClient(client), "FSAssetWorker");
                        worker.setDaemon(true);
                        worker.start();
                    } catch (IOException e) {
                        if (running) {
                            Log.w(TAG, "LocalAssetServer accept error", e);
                        }
                    }
                }
            }, "FSAssetAccept");
            acceptThread.setDaemon(true);
            acceptThread.start();
        }

        void stop() {
            running = false;
            if (serverSocket != null) {
                try {
                    serverSocket.close();
                } catch (IOException ignored) {}
            }
        }

        private void handleClient(Socket client) {
            try (Socket s = client) {
                s.setSoTimeout(5000);
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII)
                );
                String requestLine = reader.readLine();
                if (requestLine == null || requestLine.isEmpty()) return;

                String headerLine;
                String cookieHeader = "";
                while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
                    if (headerLine.toLowerCase(Locale.US).startsWith("cookie:")) {
                        cookieHeader = headerLine.substring(7).trim();
                    }
                }

                String[] parts = requestLine.split(" ");
                String method = parts.length > 0 ? parts[0].toUpperCase(Locale.US) : "GET";
                String rawTarget = parts.length > 1 ? parts[1] : "/";
                String target = rawTarget;
                String queryToken = null;
                int qIdx = rawTarget.indexOf('?');
                if (qIdx >= 0) {
                    target = rawTarget.substring(0, qIdx);
                    String query = rawTarget.substring(qIdx + 1);
                    for (String kv : query.split("&")) {
                        int eq = kv.indexOf('=');
                        if (eq > 0 && "t".equals(kv.substring(0, eq))) {
                            queryToken = Uri.decode(kv.substring(eq + 1));
                        }
                    }
                }

                boolean tokenValid = authToken.equals(queryToken) || cookieHeader.contains("fs_local=" + authToken);
                OutputStream out = new BufferedOutputStream(s.getOutputStream());
                if (!tokenValid) {
                    writeSimpleResponse(out, 403, "Forbidden", "text/plain; charset=utf-8", new byte[0], method, null);
                    return;
                }

                String rel = Uri.decode(target).replaceFirst("^/+", "");
                if (rel.isEmpty()) rel = "index.html";

                if (rel.contains("..")) {
                    writeSimpleResponse(out, 403, "Forbidden", "text/plain", new byte[0], method, null);
                    return;
                }

                String setCookie = authToken.equals(queryToken)
                    ? ("fs_local=" + authToken + "; Path=/; HttpOnly; SameSite=Strict")
                    : null;

                try (InputStream assetIn = assets.open("static/" + rel)) {
                    byte[] body = readAllBytesCompat(assetIn);
                    String mime = guessMimeType(rel);
                    if (isTextMime(mime)) {
                        mime = mime + "; charset=utf-8";
                    }
                    writeSimpleResponse(out, 200, "OK", mime, body, method, setCookie);
                } catch (IOException notFound) {
                    writeSimpleResponse(out, 404, "Not Found", "text/plain; charset=utf-8", new byte[0], method, setCookie);
                }
            } catch (Exception ignored) {
            }
        }

        private static byte[] readAllBytesCompat(InputStream in) throws IOException {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        }

        private static void writeSimpleResponse(
            OutputStream out,
            int code,
            String reason,
            String contentType,
            byte[] body,
            String method,
            String setCookie
        ) throws IOException {
            StringBuilder headers = new StringBuilder();
            headers.append("HTTP/1.1 ").append(code).append(" ").append(reason).append("\r\n");
            headers.append("Content-Type: ").append(contentType).append("\r\n");
            headers.append("Content-Length: ").append(body.length).append("\r\n");
            headers.append("Access-Control-Allow-Origin: *\r\n");
            headers.append("Cache-Control: no-cache\r\n");
            if (setCookie != null) {
                headers.append("Set-Cookie: ").append(setCookie).append("\r\n");
            }
            headers.append("Connection: close\r\n\r\n");
            out.write(headers.toString().getBytes(StandardCharsets.US_ASCII));
            if (!"HEAD".equals(method) && body.length > 0) {
                out.write(body);
            }
            out.flush();
        }
    }
}
