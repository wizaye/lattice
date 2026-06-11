use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;

fn no_update_info(current_version: String) -> UpdateInfo {
    UpdateInfo {
        current_version: current_version.clone(),
        latest_version: current_version,
        update_available: false,
        release_notes: None,
        download_url: None,
        published_at: None,
    }
}

fn is_unconfigured_updater_error(error: &str) -> bool {
    error.contains("Updater does not have any endpoints set.")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub check_interval_hours: u64,
    pub notify_on_update: bool,
    pub auto_download: bool,
    pub channel: UpdateChannel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum UpdateChannel {
    Stable,
    Beta,
    Nightly,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            check_interval_hours: 6, // Check every 6 hours
            notify_on_update: true,
            auto_download: false,
            channel: UpdateChannel::Stable,
        }
    }
}

/// Check for updates without downloading
#[tauri::command]
pub async fn ota_check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    
    // Build updater
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    
    // Check for updates
    match updater.check().await {
        Ok(Some(update)) => {
            let latest_version = update.version.clone();
            
            Ok(UpdateInfo {
                current_version,
                latest_version: latest_version.clone(),
                update_available: true,
                release_notes: update.body.clone(),
                download_url: Some(update.download_url.to_string()),
                published_at: update.date.map(|d| d.to_string()),
            })
        }
        Ok(None) => Ok(no_update_info(current_version)),
        Err(e) => {
            let error = e.to_string();
            if is_unconfigured_updater_error(&error) {
                Ok(no_update_info(current_version))
            } else {
                Err(format!("Update check failed: {}", error))
            }
        }
    }
}

/// Download and install update
#[tauri::command]
pub async fn ota_download_and_install(app: AppHandle) -> Result<String, String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            
            // Download and install
            update
                .download_and_install(
                    |chunk_length, content_length| {
                        // Emit progress event
                        let progress = if let Some(total) = content_length {
                            (chunk_length as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        };
                        
                        let _ = app.emit("update-download-progress", progress);
                    },
                    || {
                        // Download finished
                        let _ = app.emit("update-download-complete", ());
                    }
                )
                .await
                .map_err(|e| e.to_string())?;

            Ok(format!("Update {} downloaded. Restart to apply.", version))
        }
        Ok(None) => Err("No updates available".to_string()),
        Err(e) => {
            let error = e.to_string();
            if is_unconfigured_updater_error(&error) {
                Err("Updater is not configured for this build".to_string())
            } else {
                Err(format!("Update download failed: {}", error))
            }
        }
    }
}

/// Get update settings
#[tauri::command]
pub fn ota_get_settings() -> Result<UpdateSettings, String> {
    // In production, load from disk
    // For now, return defaults
    Ok(UpdateSettings::default())
}

/// Save update settings
#[tauri::command]
pub fn ota_set_settings(settings: UpdateSettings) -> Result<(), String> {
    // In production, save to disk
    // For now, just validate
    if settings.check_interval_hours < 1 {
        return Err("Check interval must be at least 1 hour".to_string());
    }
    
    Ok(())
}

/// Background update checker that runs periodically
pub async fn start_update_checker(app: AppHandle) {
    // Get settings
    let settings = ota_get_settings().unwrap_or_default();
    
    if !settings.auto_check {
        return;
    }
    
    let interval = Duration::from_secs(settings.check_interval_hours * 3600);
    let app_clone = app.clone();
    
    // Spawn background task
    tokio::spawn(async move {
        let mut interval_timer = tokio::time::interval(interval);
        
        loop {
            interval_timer.tick().await;
            
            // Check for updates
            match ota_check_for_updates(app_clone.clone()).await {
                Ok(update_info) => {
                    if update_info.update_available {
                        // Emit event to frontend
                        let _ = app_clone.emit("update-available", update_info.clone());
                        
                        // Auto-download if enabled
                        let settings = ota_get_settings().unwrap_or_default();
                        if settings.auto_download {
                            let _ = ota_download_and_install(app_clone.clone()).await;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Update check failed: {}", e);
                }
            }
        }
    });
}

/// Check for updates on app startup
#[tauri::command]
pub async fn ota_startup_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let settings = ota_get_settings().unwrap_or_default();
    
    if !settings.auto_check {
        return Err("Auto-check disabled".to_string());
    }
    
    ota_check_for_updates(app).await
}

/// Get release notes for a specific version
#[tauri::command]
pub async fn ota_get_release_notes(_app: AppHandle, version: String) -> Result<String, String> {
    // Fetch from GitHub releases API
    let owner = "vijaygatla";
    let repo = "lattice";
    let url = format!("https://api.github.com/repos/{}/{}/releases/tags/v{}", owner, repo, version);
    
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "Lattice")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release notes: {}", e))?;
    
    let release: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    let body = release["body"]
        .as_str()
        .unwrap_or("No release notes available")
        .to_string();
    
    Ok(body)
}
