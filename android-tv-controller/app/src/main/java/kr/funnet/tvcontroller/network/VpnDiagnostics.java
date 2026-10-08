package kr.funnet.tvcontroller.network;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Diagnostics for the WireGuard engine embedded in this APK. */
public final class VpnDiagnostics {
    private VpnDiagnostics() {}

    public static JSONObject snapshot(Context context) throws JSONException {
        kr.funnet.tvcontroller.data.SettingsStore store = new kr.funnet.tvcontroller.data.SettingsStore(context);
        JSONObject result = new JSONObject()
                .put("provider", "embedded-wireguard")
                .put("engineBundled", true)
                .put("rootRequired", false)
                .put("permissionStatus", store.vpnPermissionStatus())
                .put("permissionUpdatedAt", store.vpnPermissionUpdatedAt() == 0L ? JSONObject.NULL : store.vpnPermissionUpdatedAt())
                .put("tunnelConfigured", !kr.funnet.tvcontroller.BuildConfig.WIREGUARD_CONFIG_BASE64.isBlank())
                .put("tunnelStatus", store.vpnTunnelStatus())
                .put("tunnelUpdatedAt", store.vpnTunnelUpdatedAt() == 0L ? JSONObject.NULL : store.vpnTunnelUpdatedAt())
                .put("vpnTransportActive", false)
                .put("addresses", new JSONArray());
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return result;
        JSONArray addresses = result.getJSONArray("addresses");
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            result.put("vpnTransportActive", true);
            LinkProperties properties = manager.getLinkProperties(network);
            if (properties == null) continue;
            result.put("interfaceName", properties.getInterfaceName());
            for (LinkAddress address : properties.getLinkAddresses()) {
                String host = address.getAddress().getHostAddress();
                if (host != null && !host.isBlank() && !host.startsWith("fe80:")) addresses.put(host);
            }
        }
        result.put("primaryAddress", addresses.length() == 0 ? JSONObject.NULL : addresses.getString(0));
        return result;
    }

    public static String summary(Context context) {
        String status = new kr.funnet.tvcontroller.data.SettingsStore(context).vpnPermissionStatus();
        String tunnel = new kr.funnet.tvcontroller.data.SettingsStore(context).vpnTunnelStatus();
        if ("interface_up".equals(tunnel)) return "내장 WireGuard 시작됨 · 10.77.0.2 · handshake 확인 대기";
        if (tunnel.startsWith("failed:")) return "내장 WireGuard 연결 실패 · " + tunnel.substring(7);
        if ("granted".equals(status)) return "내장 WireGuard 엔진 준비됨 · VPN 권한 승인 완료";
        if ("denied".equals(status)) return "내장 WireGuard 엔진 포함 · VPN 권한 거부/차단됨";
        if ("requesting".equals(status)) return "내장 WireGuard 엔진 포함 · 시스템 승인 대기 중";
        return "내장 WireGuard 엔진 포함 · VPN 권한 테스트 필요";
    }
}
