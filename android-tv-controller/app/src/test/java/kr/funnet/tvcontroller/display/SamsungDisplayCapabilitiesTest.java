package kr.funnet.tvcontroller.display;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SamsungDisplayCapabilitiesTest {
    @Test public void qbcFamilyIncludesHdmi3() {
        assertArrayEquals(new String[]{"HDMI1", "HDMI2", "HDMI3"},
                SamsungDisplayCapabilities.inputsForModel("LH75QBCEBGCXKR"));
        assertTrue(SamsungDisplayCapabilities.supportsInput("LH75QBC", "HDMI3"));
        assertTrue(SamsungDisplayCapabilities.supportsInput("QB75C", "HDMI3"));
    }

    @Test public void qmcFamilyIncludesHdmi3() {
        assertArrayEquals(new String[]{"HDMI1", "HDMI2", "HDMI3"},
                SamsungDisplayCapabilities.inputsForModel("LH75QMCEBGCXKR"));
        assertTrue(SamsungDisplayCapabilities.supportsInput("QM75C", "HDMI3"));
    }

    @Test public void qetFamilyRemainsLimitedToTwoHdmiInputs() {
        assertArrayEquals(new String[]{"HDMI1", "HDMI2"},
                SamsungDisplayCapabilities.inputsForModel("LH75QET"));
        assertFalse(SamsungDisplayCapabilities.supportsInput("LH75QET", "HDMI3"));
    }

    @Test public void legacyQb75bSettingsKeepThreeHdmiInputs() {
        assertTrue(SamsungDisplayCapabilities.supportsInput("QB75B", "HDMI3"));
    }
}
