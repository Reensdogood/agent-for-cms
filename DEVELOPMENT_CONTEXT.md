# Development Context

## Project

Funnet Agent Integrated Management is a Windows Agent plus web server MVP for managing regional PCs that run UME video meetings and i-vision DID software.

Current public server:

- `https://agent.funnet.kr`
- Docker app runs on the Ubuntu development server at `/data/gwanak-agent`.
- nginx terminates HTTPS for `agent.funnet.kr` and proxies to `127.0.0.1:4170`.

## Version Policy

Current version: `0.9.0`.

From this point forward, every meaningful server, Agent, installer, or deployment package update should bump the minor version by `0.1.0`.

Examples:

- `0.3.0` -> `0.4.0`
- `0.4.0` -> `0.5.0`

Generated release artifact names must use the same version:

- `funnet-gwanak-agent-setup-{version}.exe`
- `funnet-gwanak-server-{version}.zip`

## Implemented Scope

- Admin login and session handling
- User management with role-based access control
- HTTPS production hosting through nginx
- Device registration and approval
- Region-specific enrollment keys
- Device rename and delete
- Agent heartbeat and health probe
- UME version/path/running status reporting
- i-vision running status reporting
- UME fullscreen/topmost activation command
- Green accept/join button detection and auto-click attempt after UME activation
- UME hide and i-vision foreground restore command
- UME release upload, download command, SHA-256 verification, and Authenticode verification
- Schedule registration, edit, enable/disable, delete, and all-device manual run for UME activation
- Per-device UME rerun command from device management, intended for site-level recovery when UME exits unexpectedly
- Green accept/join button detection scans every visible UME window on each attempt, including late-created invite windows.
- Apple-style management UI
- Windows Agent installer with default server URL `https://agent.funnet.kr`
- Installer closes after successful Agent launch so only the tray Agent remains
- Agent tray icon uses the Funnet logo-derived rounded icon
- Installer header logo has transparent-background cleanup applied in `0.8.0`.
- Installer bottom spacing after the remove button was restored in `0.9.0`.

## Important Decisions

- User roles are enforced at the API layer, not only by hiding UI controls.
- `admin` / 전체 시스템 can manage users, regions, devices, schedules, and releases.
- `operator` / 운영 can manage operational devices, schedules, and UME release distribution, but not users or region keys.
- `region_manager` / 지역 관리자 is scoped to the assigned region for device list, approval, rename, and health probe actions.

- UME installer deployment is download, verify, and store only. The Agent does not run the UME installer automatically.
- Code signing is deferred. The installer remains unsigned for pilot use.
- Enrollment keys are not device credentials. They are only used for first registration.
- After registration, each PC communicates with its own device token. Rotating a region enrollment key does not affect already registered devices.
- Schedules are global operational records for now. Recovery can be done per site/device by using the device-level `UME 실행` command, which queues the same `ume.activate` command for only that PC.
- Existing devices from earlier versions are automatically assigned to the default `관악` region.

## Operational Notes

- Server data is stored in the Docker volume configured by `FUNNET_DATA_DIR=/data`.
- UME release files are stored under the server data directory in `releases`.
- Agent identity/token is stored locally and protected with Windows DPAPI.
- Device deletion on the server removes device registration and queued command rows. That device must be re-registered if it should connect again.
