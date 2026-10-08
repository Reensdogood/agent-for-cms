package kr.funnet.tvcontroller.device;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

public final class NetworkIdentity {
    private NetworkIdentity() {}

    public static String localIpv4Address() {
        String selected = null;
        int selectedScore = Integer.MIN_VALUE;
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                String interfaceName = network.getName() == null ? "" : network.getName().toLowerCase();
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) {
                        String hostAddress = address.getHostAddress();
                        int score = score(interfaceName, hostAddress);
                        if (score > selectedScore) {
                            selected = hostAddress;
                            selectedScore = score;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return selected == null ? "미확인" : selected;
    }

    static int score(String interfaceName, String address) {
        int score = 0;
        if (interfaceName.startsWith("eth") || interfaceName.startsWith("en")) score += 300;
        else if (interfaceName.startsWith("wlan") || interfaceName.startsWith("wifi")) score += 200;
        if (address.startsWith("192.168.")) score += 50;
        if (interfaceName.startsWith("tun") || interfaceName.startsWith("wg")
                || interfaceName.contains("vpn") || address.startsWith("10.77.")) score -= 500;
        return score;
    }
}
