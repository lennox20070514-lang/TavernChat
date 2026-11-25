package com.tavernchat.app;

import android.content.res.AssetManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "LanHost")
public class LanHostPlugin extends Plugin {
  private static final int PORT_START = 18797;
  private static final int PORT_END = 18810;
  private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
  private static final String SNAPSHOT_FILE = "tavernchat-sync-snapshot.json";

  private static final Map<String, String> MIME_TYPES = new HashMap<>();
  static {
    MIME_TYPES.put(".html", "text/html; charset=utf-8");
    MIME_TYPES.put(".js", "text/javascript; charset=utf-8");
    MIME_TYPES.put(".css", "text/css; charset=utf-8");
    MIME_TYPES.put(".json", "application/json; charset=utf-8");
    MIME_TYPES.put(".webmanifest", "application/manifest+json; charset=utf-8");
    MIME_TYPES.put(".svg", "image/svg+xml");
    MIME_TYPES.put(".png", "image/png");
    MIME_TYPES.put(".webp", "image/webp");
    MIME_TYPES.put(".ico", "image/x-icon");
    MIME_TYPES.put(".woff2", "font/woff2");
    MIME_TYPES.put(".txt", "text/plain; charset=utf-8");
  }

  private final Object serverLock = new Object();
  private final Object syncLock = new Object();
  private ServerSocket serverSocket;
  private ExecutorService workerPool;
  private volatile boolean running = false;
  private int boundPort = 0;

  private String cachedSnapshotJson = null;
  private long currentRevision = 0;

  @PluginMethod
  public void startServer(PluginCall call) {
    try {
      synchronized (serverLock) {
        if (!running || serverSocket == null || serverSocket.isClosed()) {
          startSocketLocked();
        }
      }
      call.resolve(buildStatusObject());
    } catch (Exception e) {
      call.reject("无法启动局域网主机：" + e.getMessage(), e);
    }
  }

  @PluginMethod
  public void stopServer(PluginCall call) {
    stopSocket();
    call.resolve(buildStatusObject());
  }

  @PluginMethod
  public void getStatus(PluginCall call) {
    call.resolve(buildStatusObject());
  }

  @Override
  protected void handleOnDestroy() {
    stopSocket();
    super.handleOnDestroy();
  }

  private void startSocketLocked() throws IOException {
    IOException lastErr = null;
    ServerSocket socket = null;
    int port = 0;
    for (int candidate = PORT_START; candidate <= PORT_END; candidate++) {
      try {
        ServerSocket attempt = new ServerSocket();
        attempt.setReuseAddress(true);
        attempt.bind(new InetSocketAddress("0.0.0.0", candidate), 50);
        socket = attempt;
        port = candidate;
        break;
      } catch (IOException err) {
        lastErr = err;
      }
    }
    if (socket == null) {
      throw lastErr != null ? lastErr : new IOException("No available LAN port");
    }

    serverSocket = socket;
    boundPort = port;
    running = true;
    workerPool = Executors.newFixedThreadPool(12);

    final ServerSocket activeSocket = socket;
    Thread acceptThread = new Thread(() -> {
      while (running && !activeSocket.isClosed()) {
        try {
          final Socket client = activeSocket.accept();
          ExecutorService pool = workerPool;
          if (pool != null && !pool.isShutdown()) {
            pool.execute(() -> handleClient(client));
          } else {
            client.close();
          }
        } catch (IOException ignored) {
          if (!running) break;
        }
      }
    }, "TavernLanAccept");
    acceptThread.setDaemon(true);
    acceptThread.start();
  }

  private void stopSocket() {
    synchronized (serverLock) {
      running = false;
      boundPort = 0;
      if (serverSocket != null) {
        try {
          serverSocket.close();
        } catch (IOException ignored) {}
        serverSocket = null;
      }
      if (workerPool != null) {
        workerPool.shutdownNow();
        workerPool = null;
      }
    }
  }

  private JSObject buildStatusObject() {
    String ip = detectLanIp();
    JSObject status = new JSObject();
    status.put("running", running);
    status.put("ip", ip);
    status.put("port", boundPort);
    status.put("url", running && boundPort > 0 ? "http://" + ip + ":" + boundPort : "");
    synchronized (syncLock) {
      ensureSnapshotLoadedLocked();
      status.put("revision", currentRevision);
    }
    return status;
  }

  private String detectLanIp() {
    List<String> preferred = new ArrayList<>();
    List<String> fallback = new ArrayList<>();
    try {
      Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
      if (ifaces != null) {
        for (NetworkInterface nif : Collections.list(ifaces)) {
          if (!nif.isUp() || nif.isLoopback() || nif.isVirtual()) continue;
          String name = nif.getName() != null ? nif.getName().toLowerCase(Locale.ROOT) : "";
          boolean wifiLike = name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("eth");
          for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
            if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) continue;
            String hostAddr = addr.getHostAddress();
            if (hostAddr == null) continue;
            if (hostAddr.startsWith("192.168.") || hostAddr.startsWith("10.")
                || hostAddr.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*")) {
              if (wifiLike) preferred.add(0, hostAddr);
              else preferred.add(hostAddr);
            } else {
              fallback.add(hostAddr);
            }
          }
        }
      }
    } catch (Exception ignored) {}
    if (!preferred.isEmpty()) return preferred.get(0);
    if (!fallback.isEmpty()) return fallback.get(0);
    return "127.0.0.1";
  }

  private void ensureSnapshotLoadedLocked() {
    if (cachedSnapshotJson != null) return;
    File file = new File(getContext().getFilesDir(), SNAPSHOT_FILE);
    if (file.exists()) {
      try (FileInputStream fis = new FileInputStream(file)) {
        byte[] bytes = readAllBytes(fis, MAX_BODY_BYTES);
        String raw = new String(bytes, StandardCharsets.UTF_8);
        JSONObject obj = new JSONObject(raw);
        currentRevision = obj.optLong("revision", 0);
        cachedSnapshotJson = obj.toString();
        return;
      } catch (Exception ignored) {}
    }
    currentRevision = 0;
    cachedSnapshotJson =
        "{\"schema\":1,\"revision\":0,\"updatedAt\":0,\"components\":[],\"sessions\":[],\"messages\":[],\"deletedIds\":{}}";
  }

  private void persistSnapshotLocked(String json) {
    cachedSnapshotJson = json;
    File target = new File(getContext().getFilesDir(), SNAPSHOT_FILE);
    File tmp = new File(getContext().getFilesDir(), SNAPSHOT_FILE + ".tmp");
    try (FileOutputStream fos = new FileOutputStream(tmp)) {
      fos.write(json.getBytes(StandardCharsets.UTF_8));
      fos.flush();
    } catch (IOException ignored) {
      return;
    }
    //noinspection ResultOfMethodCallIgnored
    tmp.renameTo(target);
  }

  private void handleClient(Socket socket) {
    try (Socket s = socket) {
      s.setSoTimeout(15_000);
      BufferedInputStream in = new BufferedInputStream(s.getInputStream());
      OutputStream out = s.getOutputStream();

      String requestLine = readAsciiLine(in);
      if (requestLine == null || requestLine.isEmpty()) return;
      String[] parts = requestLine.split(" ");
      if (parts.length < 2) return;
      String method = parts[0].toUpperCase(Locale.ROOT);
      String rawTarget = parts[1];

      int contentLength = 0;
      while (true) {
        String header = readAsciiLine(in);
        if (header == null || header.isEmpty()) break;
        int colon = header.indexOf(':');
        if (colon > 0) {
          String k = header.substring(0, colon).trim().toLowerCase(Locale.ROOT);
          String v = header.substring(colon + 1).trim();
          if ("content-length".equals(k)) {
            try {
              contentLength = Math.max(0, Integer.parseInt(v));
            } catch (NumberFormatException ignored) {}
          }
        }
      }

      int qIdx = rawTarget.indexOf('?');
      String pathOnly = qIdx >= 0 ? rawTarget.substring(0, qIdx) : rawTarget;

      if ("OPTIONS".equals(method)) {
        writeHeaders(out, 204, "No Content", "text/plain", 0);
        out.flush();
        return;
      }

      if ("GET".equals(method) && "/api/v1/health".equals(pathOnly)) {
        String body = "{\"ok\":true,\"app\":\"TavernChat\",\"mode\":\"android-lan-host\",\"capabilities\":{\"proxy\":false,\"market\":false,\"sync\":true}}";
        writeJson(out, 200, "OK", body);
        return;
      }

      if ("GET".equals(method) && "/api/v1/sync/snapshot".equals(pathOnly)) {
        String snapshotJson;
        synchronized (syncLock) {
          ensureSnapshotLoadedLocked();
          snapshotJson = cachedSnapshotJson;
        }
        writeJson(out, 200, "OK", "{\"ok\":true,\"snapshot\":" + snapshotJson + "}");
        return;
      }

      if ("POST".equals(method) && "/api/v1/sync/snapshot".equals(pathOnly)) {
        if (contentLength > MAX_BODY_BYTES) {
          writeJson(out, 413, "Payload Too Large", "{\"ok\":false,\"error\":\"快照体积过大\"}");
          return;
        }
        byte[] bodyBytes = readFixedBytes(in, contentLength);
        try {
          JSONObject payload = new JSONObject(new String(bodyBytes, StandardCharsets.UTF_8));
          JSONObject snap = payload.has("snapshot") ? payload.getJSONObject("snapshot") : payload;
          long baseRev = payload.optLong("baseRevision", -1);

          synchronized (syncLock) {
            ensureSnapshotLoadedLocked();
            if (baseRev >= 0 && currentRevision > 0 && baseRev != currentRevision) {
              writeJson(
                  out,
                  409,
                  "Conflict",
                  "{\"ok\":false,\"conflict\":true,\"snapshot\":" + cachedSnapshotJson + "}"
              );
              return;
            }
            currentRevision += 1;
            snap.put("revision", currentRevision);
            String committed = snap.toString();
            persistSnapshotLocked(committed);
            JSObject eventData = new JSObject();
            eventData.put("revision", currentRevision);
            notifyListeners("syncUpdated", eventData);
            writeJson(out, 200, "OK", "{\"ok\":true,\"snapshot\":" + committed + "}");
            return;
          }
        } catch (Exception err) {
          writeJson(
              out,
              400,
              "Bad Request",
              "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(err.getMessage())) + "}"
          );
          return;
        }
      }

      if ("GET".equals(method) && !pathOnly.startsWith("/api/")) {
        serveStaticAsset(out, pathOnly);
        return;
      }

      writeJson(out, 404, "Not Found", "{\"error\":\"Not Found\"}");
    } catch (Exception ignored) {}
  }

  private void serveStaticAsset(OutputStream out, String pathOnly) throws IOException {
    String decoded;
    try {
      decoded = URLDecoder.decode(pathOnly, "UTF-8");
    } catch (Exception e) {
      decoded = pathOnly;
    }
    if (decoded.contains("..")) {
      writeJson(out, 403, "Forbidden", "{\"error\":\"Forbidden\"}");
      return;
    }
    String rel = decoded.startsWith("/") ? decoded.substring(1) : decoded;
    if (rel.isEmpty()) rel = "index.html";

    AssetManager assets = getContext().getAssets();
    byte[] data = tryOpenAsset(assets, "public/" + rel);
    String servedName = rel;
    if (data == null && !rel.contains(".")) {
      data = tryOpenAsset(assets, "public/index.html");
      servedName = "index.html";
    }
    if (data == null) {
      writeJson(out, 404, "Not Found", "{\"error\":\"Asset Not Found\"}");
      return;
    }

    String mime = "application/octet-stream";
    int dot = servedName.lastIndexOf('.');
    if (dot >= 0) {
      String ext = servedName.substring(dot).toLowerCase(Locale.ROOT);
      String mapped = MIME_TYPES.get(ext);
      if (mapped != null) mime = mapped;
    }
    writeHeaders(out, 200, "OK", mime, data.length);
    out.write(data);
    out.flush();
  }

  private byte[] tryOpenAsset(AssetManager assets, String path) {
    try (InputStream is = assets.open(path)) {
      return readAllBytes(is, MAX_BODY_BYTES);
    } catch (IOException e) {
      return null;
    }
  }

  private static String readAsciiLine(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int b;
    while ((b = in.read()) != -1) {
      if (b == '\n') break;
      if (b != '\r') buf.write(b);
      if (buf.size() > 8192) break;
    }
    if (b == -1 && buf.size() == 0) return null;
    return buf.toString("US-ASCII");
  }

  private static byte[] readFixedBytes(InputStream in, int length) throws IOException {
    byte[] buf = new byte[length];
    int offset = 0;
    while (offset < length) {
      int read = in.read(buf, offset, length - offset);
      if (read < 0) break;
      offset += read;
    }
    if (offset == length) return buf;
    byte[] trimmed = new byte[offset];
    System.arraycopy(buf, 0, trimmed, 0, offset);
    return trimmed;
  }

  private static byte[] readAllBytes(InputStream in, int maxBytes) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int total = 0;
    int read;
    while ((read = in.read(chunk)) != -1) {
      total += read;
      if (total > maxBytes) throw new IOException("Asset too large");
      out.write(chunk, 0, read);
    }
    return out.toByteArray();
  }

  private static void writeJson(OutputStream out, int code, String reason, String body)
      throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    writeHeaders(out, code, reason, "application/json; charset=utf-8", bytes.length);
    out.write(bytes);
    out.flush();
  }

  private static void writeHeaders(
      OutputStream out, int code, String reason, String contentType, int contentLength)
      throws IOException {
    StringBuilder sb = new StringBuilder();
    sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
    sb.append("Content-Type: ").append(contentType).append("\r\n");
    sb.append("Content-Length: ").append(contentLength).append("\r\n");
    sb.append("Access-Control-Allow-Origin: *\r\n");
    sb.append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
    sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
    sb.append("Cache-Control: no-store\r\n");
    sb.append("Connection: close\r\n\r\n");
    out.write(sb.toString().getBytes(StandardCharsets.US_ASCII));
  }
}
