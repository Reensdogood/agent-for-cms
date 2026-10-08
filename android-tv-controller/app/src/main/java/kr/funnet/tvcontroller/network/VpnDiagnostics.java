package kr.funnet.tvcontroller.network;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class VpnDiagnostics {
    private VpnDiagnostics() {}

    public static JSONObject snapshot(Context context) throws JSONException {
        JSONObject result = new JSONObject()
                .put("provider", "tailscale")
                .put("packageName", TailscaleInstaller.PACKAGE_NAME)
                .put("installStatus", new kr.funnet.tvcontroller.data.SettingsStore(context).vpnInstallStatus())
                .put("installed", TailscaleInstaller.isInstalled(context))
                .put("active", false)
                .put("vpnTransportActive", false)
                .put("addresses", new JSONArray());
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(TailscaleInstaller.PACKAGE_NAME, 0);
            result.put("version", info.versionName == null ? JSONObject.NULL : info.versionName);
        } catch (PackageManager.NameNotFoundException ignored) {
            result.put("version", JSONObject.NULL);
        }

        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return result;
        int tailscaleUid = -1;
        try { tailscaleUid = context.getPackageManager().getApplicationInfo(TailscaleInstaller.PACKAGE_NAME, 0).uid; }
        catch (PackageManager.NameNotFoundException ignored) {}
        JSONArray addresses = result.getJSONArray("addresses");
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            result.put("vpnTransportActive", true);
            if (Build.VERSION.SDK_INT >= 30 && capabilities.getOwnerUid() != tailscaleUid) continue;
            result.put("active", true);
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
        try {
            JSONObject state = snapshot(context);
            String installStatus = new kr.funnet.tvcontroller.data.SettingsStore(context).vpnInstallStatus();
            if (!state.getBoolean("installed")) return "Tailscale 미설치 · " + installStatus;
            if (!state.getBoolean("active")) return "Tailscale 설치됨 · VPN 연결 대기";
            String address = state.optString("primaryAddress", "");
            return "VPN 연결됨" + (address.isBlank() ? "" : " · " + address);
        } catch (Exception error) {
            return "VPN 상태 확인 실패: " + error.getClass().getSimpleName();
        }
    }
}
