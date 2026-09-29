package kr.funnet.tvcontroller.display;

import java.util.Locale;

public final class SamsungDisplayCapabilities {
    private static final String[] TWO_HDMI = {"HDMI1", "HDMI2"};
    private static final String[] THREE_HDMI = {"HDMI1", "HDMI2", "HDMI3"};

    private SamsungDisplayCapabilities() {}

    public static String[] inputsForModel(String model) {
        String normalized = model == null ? "" : model.toUpperCase(Locale.ROOT);
        // QBC is the current Windows Agent contract. QB75B remains supported for
        // Android PoC settings created before the QBC model list was introduced.
        return (normalized.contains("QBC") || normalized.contains("QB75B"))
                ? THREE_HDMI.clone() : TWO_HDMI.clone();
    }

    public static boolean supportsInput(String model, String input) {
        String requested = input == null ? "" : input.trim().toUpperCase(Locale.ROOT);
        for (String supported : inputsForModel(model)) {
            if (supported.equals(requested)) return true;
        }
        return false;
    }
}
