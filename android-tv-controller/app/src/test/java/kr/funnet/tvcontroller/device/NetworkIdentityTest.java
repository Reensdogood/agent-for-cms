package kr.funnet.tvcontroller.device;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class NetworkIdentityTest {
    @Test public void ethernetAddressWinsOverWireGuardTunnelAddress() {
        int ethernet = NetworkIdentity.score("eth0", "192.168.128.6");
        int wireGuard = NetworkIdentity.score("tun0", "10.77.0.2");

        assertTrue(ethernet > wireGuard);
    }

    @Test public void wifiAddressWinsOverVpnAddress() {
        int wifi = NetworkIdentity.score("wlan0", "192.168.80.67");
        int vpn = NetworkIdentity.score("wg0", "10.77.0.2");

        assertTrue(wifi > vpn);
    }
}
