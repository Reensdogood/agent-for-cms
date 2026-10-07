package kr.funnet.tvcontroller.network;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kr.funnet.tvcontroller.device.NetworkIdentity;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Checks only the A10's own local web portal. It never sends administrator credentials. */
public final class AdminPageProbe {
    private static final int MAX_BODY_CHARS = 65_536;
    private static final Pattern TITLE = Pattern.compile("<title[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private AdminPageProbe() {}

    public static JSONObject run(Context context) throws Exception {
        String localIp = NetworkIdentity.localIpv4Address();
        JSONArray attempts = new JSONArray();
        String[] candidates = localIp == null || localIp.isBlank()
                ? new String[]{"https://127.0.0.1/", "http://127.0.0.1/"}
                : new String[]{"https://127.0.0.1/", "https://" + localIp + "/", "http://127.0.0.1/", "http://" + localIp + "/"};
        for (String candidate : candidates) {
            JSONObject attempt = probe(candidate, null, localIp);
            attempts.put(attempt);
            if (attempt.optBoolean("reachable")) {
                return new JSONObject()
                        .put("reachable", true)
                        .put("selectedUrl", candidate)
                        .put("localIpAddress", localIp)
                        .put("status", attempt.optInt("status"))
                        .put("contentType", attempt.optString("contentType"))
                        .put("server", attempt.optString("server"))
                        .put("title", attempt.optString("title"))
                        .put("attempts", attempts);
            }
        }
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        if (connectivity != null && localIp != null && !localIp.isBlank()) {
            for (Network network : connectivity.getAllNetworks()) {
                NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
                if (capabilities == null || (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                        && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))) continue;
                for (String candidate : new String[]{"https://" + localIp + "/", "http://" + localIp + "/"}) {
                    JSONObject attempt = probe(candidate, network, localIp);
                    attempts.put(attempt);
                    if (attempt.optBoolean("reachable")) {
                        return new JSONObject()
                                .put("reachable", true)
                                .put("selectedUrl", candidate)
                                .put("selectedNetwork", network.toString())
                                .put("localIpAddress", localIp)
                                .put("status", attempt.optInt("status"))
                                .put("contentType", attempt.optString("contentType"))
                                .put("server", attempt.optString("server"))
                                .put("title", attempt.optString("title"))
                                .put("attempts", attempts);
                    }
                }
            }
        }
        return new JSONObject()
                .put("reachable", false)
                .put("localIpAddress", localIp)
                .put("attempts", attempts);
    }

    private static JSONObject probe(String address, Network network, String localIp) {
        JSONObject result = new JSONObject();
        try {
            result.put("url", address);
            result.put("network", network == null ? "default" : network.toString());
            URL url = new URL(address);
            HttpURLConnection connection = (HttpURLConnection) (network == null ? url.openConnection() : network.openConnection(url));
            if (connection instanceof HttpsURLConnection https) {
                SSLContext context = SSLContext.getInstance("TLS");
                context.init(null, new TrustManager[]{new LocalTrustManager()}, new SecureRandom());
                https.setSSLSocketFactory(context.getSocketFactory());
                HostnameVerifier localOnly = (hostname, session) -> "127.0.0.1".equals(hostname) || hostname.equals(localIp);
                https.setHostnameVerifier(localOnly);
            }
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(5_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            connection.setRequestProperty("User-Agent", "Funnet-A10-Agent/1.0");
            int status = connection.getResponseCode();
            result.put("status", status);
            result.put("contentType", String.valueOf(connection.getContentType()));
            result.put("server", String.valueOf(connection.getHeaderField("Server")));
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = readLimited(stream);
            Matcher title = TITLE.matcher(body);
            if (title.find()) result.put("title", title.group(1).replaceAll("\\s+", " ").trim());
            result.put("reachable", status >= 200 && status < 500);
            connection.disconnect();
        } catch (Exception error) {
            try {
                result.put("reachable", false);
                result.put("error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
            } catch (Exception ignored) {}
        }
        return result;
    }

    private static String readLimited(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[2048];
            int read;
            while ((read = reader.read(buffer)) >= 0 && output.length() < MAX_BODY_CHARS) {
                output.append(buffer, 0, Math.min(read, MAX_BODY_CHARS - output.length()));
            }
        }
        return output.toString();
    }

    private static final class LocalTrustManager implements X509TrustManager {
        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }
}
