package kr.funnet.tvcontroller.network;

import android.content.Context;
import android.net.VpnService;
import android.util.Base64;

import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

import kr.funnet.tvcontroller.BuildConfig;
import kr.funnet.tvcontroller.data.SettingsStore;

/** Starts the A10-only WireGuard peer without changing the device's default internet route. */
public final class EmbeddedWireGuardTunnel {
    private static GoBackend backend;
    private static final Tunnel TUNNEL = new Tunnel() {
        @Override public String getName() { return "funnet-a10"; }
        @Override public void onStateChange(State newState) { }
    };

    private EmbeddedWireGuardTunnel() {}

    public static boolean isConfigured() { return !BuildConfig.WIREGUARD_CONFIG_BASE64.isBlank(); }

    public static synchronized void start(Context context) {
        SettingsStore store = new SettingsStore(context);
        if (!isConfigured()) {
            store.vpnTunnelStatus("not_configured");
            return;
        }
        if (VpnService.prepare(context) != null) {
            store.vpnTunnelStatus("failed:vpn_permission_required");
            return;
        }
        try {
            byte[] decoded = Base64.decode(BuildConfig.WIREGUARD_CONFIG_BASE64, Base64.DEFAULT);
            Config config = Config.parse(new ByteArrayInputStream(decoded));
            if (backend == null) backend = new GoBackend(context.getApplicationContext());
            backend.setState(TUNNEL, Tunnel.State.UP, config);
            store.vpnTunnelStatus("interface_up");
        } catch (Exception error) {
            String message = error.getMessage();
            store.vpnTunnelStatus("failed:" + (message == null || message.isBlank()
                    ? error.getClass().getSimpleName() : message));
        }
    }
}
