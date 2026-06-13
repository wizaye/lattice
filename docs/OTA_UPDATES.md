# OTA Update System Documentation

## Overview

Lattice includes an Over-The-Air (OTA) update system that automatically checks for updates, downloads them in the background, and notifies users when new versions are available.

## Features

### 1. Automatic Update Checks
- Background service checks for updates periodically
- Configurable check intervals (1 hour to weekly)
- Runs on app startup and at scheduled intervals
- Non-blocking - doesn't interrupt user workflow

### 2. Update Channels
- **Stable**: Production releases (recommended)
- **Beta**: Preview releases with new features
- **Nightly**: Daily development builds (bleeding edge)

### 3. Smart Downloading
- Optional auto-download
- Progress tracking with percentage
- Downloads in background without blocking UI
- Resume support for interrupted downloads

### 4. User Notifications
- Toast notifications when updates are available
- Release notes display
- Manual install or dismiss options
- Progress bar during download

## Architecture

### Backend (Rust)

**Location:** `src-tauri/src/ota_updater.rs`

**Components:**
1. `ota_check_for_updates()` - Check for new versions
2. `ota_download_and_install()` - Download and prepare update
3. `ota_get_settings()` / `ota_set_settings()` - Settings management
4. `ota_startup_check()` - Run on app launch
5. `start_update_checker()` - Background service
6. `ota_get_release_notes()` - Fetch release notes from GitHub

**Update Flow:**
```
App Startup
  ↓
ota_startup_check()
  ↓
Background Service (tokio::spawn)
  ↓
Check every N hours
  ↓
Update available?
  ├─ Yes → Emit 'update-available' event
  │         ↓
  │      Auto-download enabled?
  │         ├─ Yes → Download automatically
  │         └─ No → Show notification
  └─ No → Continue checking
```

### Frontend (TypeScript/React)

**Location:** `src/lib/ota-updater.ts`, `src/components/common/UpdateNotification.tsx`

**Components:**
1. `checkForUpdates()` - Manual check
2. `downloadAndInstall()` - Install update
3. `useUpdateNotifications()` - React hook for updates
4. `UpdateNotification` - Toast component
5. `UpdateSettingsPanel` - Settings UI

**Event Listeners:**
- `update-available` - New version detected
- `update-download-progress` - Download percentage
- `update-download-complete` - Download finished

## Configuration

### Update Settings

```typescript
interface UpdateSettings {
  auto_check: boolean;              // Enable automatic checks
  check_interval_hours: number;     // 1, 3, 6, 12, 24, or 168 (weekly)
  notify_on_update: boolean;        // Show notifications
  auto_download: boolean;           // Auto-download updates
  channel: 'Stable' | 'Beta' | 'Nightly';
}
```

### Default Settings
```json
{
  "auto_check": true,
  "check_interval_hours": 6,
  "notify_on_update": true,
  "auto_download": false,
  "channel": "Stable"
}
```

## Usage

### Manual Check

```typescript
import { checkForUpdates } from '../lib/ota-updater';

const updateInfo = await checkForUpdates();

if (updateInfo.update_available) {
  console.log(`Update available: ${updateInfo.latest_version}`);
  console.log(`Release notes: ${updateInfo.release_notes}`);
}
```

### React Component

```tsx
import { useUpdateNotifications } from '../lib/ota-updater';

function MyComponent() {
  const { updateInfo, downloadProgress, isDownloading, installUpdate } = useUpdateNotifications();

  return (
    <div>
      {updateInfo?.update_available && (
        <div>
          <p>Version {updateInfo.latest_version} available</p>
          <button onClick={installUpdate}>Install</button>
        </div>
      )}
      
      {isDownloading && <progress value={downloadProgress} max={100} />}
    </div>
  );
}
```

### Settings Panel

```tsx
import { UpdateSettingsPanel } from '../components/settings/UpdateSettingsPanel';

function SettingsView() {
  return (
    <div>
      <h1>Settings</h1>
      <UpdateSettingsPanel />
    </div>
  );
}
```

## Update Manifest

Updates are delivered via Tauri's update manifest. The manifest is hosted on GitHub releases and follows this format:

```json
{
  "version": "0.2.0",
  "notes": "Release notes in markdown",
  "pub_date": "2026-06-11T16:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../lattice-0.2.0-setup.exe"
    },
    "darwin-universal": {
      "signature": "...",
      "url": "https://github.com/.../Lattice-0.2.0-universal.dmg"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../lattice_0.2.0_amd64.deb"
    }
  }
}
```

## Release Channels

### Stable Channel
- URL: `https://github.com/vijaygatla/lattice/releases/latest/download/latest.json`
- Frequency: Major/minor releases
- Testing: Full QA cycle
- Recommended for: All users

### Beta Channel
- URL: `https://github.com/vijaygatla/lattice/releases/download/beta/latest.json`
- Frequency: Weekly
- Testing: Basic QA
- Recommended for: Early adopters

### Nightly Channel
- URL: `https://github.com/vijaygatla/lattice/releases/download/nightly/latest.json`
- Frequency: Daily (automated builds)
- Testing: CI only
- Recommended for: Developers, testers

## Security

### Signature Verification
- All updates are cryptographically signed
- Tauri verifies signatures before installation
- Public key embedded in app binary
- Private key stored in CI secrets

### Transport Security
- All downloads over HTTPS
- GitHub CDN for reliability
- Checksum verification

### User Control
- Users must approve installation
- Auto-download optional
- Can disable OTA entirely
- Manual update fallback available

## Troubleshooting

### Update Check Fails
```typescript
try {
  const info = await checkForUpdates();
} catch (error) {
  console.error('Update check failed:', error);
  // Fallback: Show manual download link
}
```

### Download Fails
- Automatic retry (3 attempts)
- Resume from last position
- Fall back to manual download link
- Detailed error logging

### Installation Fails
- Rollback to previous version
- Error reported to user
- Option to download installer manually
- Logs saved for debugging

## Best Practices

### For Users
1. Keep auto-check enabled
2. Use Stable channel for production work
3. Read release notes before updating
4. Install updates during downtime

### For Developers
1. Tag releases with semantic versioning
2. Write clear release notes
3. Test on all platforms before release
4. Sign all release builds
5. Monitor update success rates

## API Reference

### Tauri Commands

```rust
// Check for updates
#[tauri::command]
pub async fn ota_check_for_updates(app: AppHandle) -> Result<UpdateInfo, String>

// Download and install
#[tauri::command]
pub async fn ota_download_and_install(app: AppHandle) -> Result<String, String>

// Get settings
#[tauri::command]
pub fn ota_get_settings() -> Result<UpdateSettings, String>

// Save settings
#[tauri::command]
pub fn ota_set_settings(settings: UpdateSettings) -> Result<(), String>

// Startup check
#[tauri::command]
pub async fn ota_startup_check(app: AppHandle) -> Result<UpdateInfo, String>

// Get release notes
#[tauri::command]
pub async fn ota_get_release_notes(app: AppHandle, version: String) -> Result<String, String>
```

### Events

```typescript
// Update available
listen<UpdateInfo>('update-available', (event) => {
  console.log('Update:', event.payload.latest_version);
});

// Download progress
listen<number>('update-download-progress', (event) => {
  console.log('Progress:', event.payload + '%');
});

// Download complete
listen('update-download-complete', () => {
  console.log('Download finished, ready to install');
});
```

## Performance

### Resource Usage
- Background checks: <1 MB network
- Memory: ~2 MB during check
- CPU: Minimal (async/non-blocking)
- Storage: Downloads cached until install

### Network Optimization
- Incremental downloads (delta updates planned)
- CDN for global distribution
- Compressed payloads
- Parallel downloads for faster speeds

## Future Enhancements

### Planned Features
1. Delta updates (download only changes)
2. P2P distribution for large files
3. Rollback to previous version
4. A/B testing for updates
5. Telemetry for update success rates
6. Scheduled installation windows
7. Network-aware downloading (pause on mobile)

---

**Last Updated:** 2026-06-11  
**Version:** 1.0  
**Author:** Lattice Team
