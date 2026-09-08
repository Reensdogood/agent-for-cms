# P2 Dependency Review

## System.IO.Ports 8.0.0

- Purpose: provide the supported .NET serial-port adapter behind the P2 `ISerialTransport` boundary.
- Source/maintainer: Microsoft/.NET runtime package on NuGet.
- License: MIT.
- Runtime impact: loaded only when Samsung display serial communication is initialized; no background worker is added by the package itself.
- Native impact: uses operating-system serial APIs; no vendor driver is bundled or installed.
- Maintenance/update risk: version 8.0.0 matches the Agent's `net8.0-windows` target. Updates should follow the existing .NET runtime servicing policy.
- Security impact: opens only the explicitly selected/detected COM port. It does not download drivers or use network credentials.

## Test-only packages

- `Microsoft.NET.Test.Sdk` 17.11.1, `xunit` 2.9.3, and `xunit.runner.visualstudio` 2.8.2 are private test/build dependencies for the new Agent unit-test project.
- They are not referenced by the shipping Agent and are not included in its single-file runtime payload.

## System.Management 8.0.0

- Purpose: enumerate Windows `Win32_PnPEntity` metadata needed to distinguish a present COM port from a Prolific/NEXT-340PL candidate and to read `ConfigManagerErrorCode` for missing/error driver states.
- Source/maintainer: Microsoft/.NET runtime package on NuGet.
- License: MIT.
- Runtime impact: WMI is queried only during discovery/re-discovery, not on a one-second background loop. Query objects are disposed immediately.
- Native impact: uses the Windows WMI/CIM infrastructure already present in Windows; it does not install a service or driver.
- Security impact: read-only local hardware inventory. No credentials, downloads, or device writes occur during enumeration.
