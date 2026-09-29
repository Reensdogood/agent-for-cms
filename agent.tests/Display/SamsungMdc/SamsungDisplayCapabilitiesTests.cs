using Funnet.Gwanak.Agent.Display.SamsungMdc;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.SamsungMdc;

public sealed class SamsungDisplayCapabilitiesTests
{
    [Fact]
    public void QbcFamilyIncludesHdmi3()
    {
        Assert.Equal([SamsungInput.Hdmi1, SamsungInput.Hdmi2, SamsungInput.Hdmi3],
            SamsungDisplayCapabilities.InputsForModel("LH75QBCEBGCXKR"));
        Assert.True(SamsungDisplayCapabilities.SupportsInput("LH75QBC", SamsungInput.Hdmi3));
    }

    [Fact]
    public void QetFamilyRemainsLimitedToTwoHdmiInputs()
    {
        Assert.Equal([SamsungInput.Hdmi1, SamsungInput.Hdmi2],
            SamsungDisplayCapabilities.InputsForModel("LH75QET"));
        Assert.False(SamsungDisplayCapabilities.SupportsInput("LH75QET", SamsungInput.Hdmi3));
    }
}
