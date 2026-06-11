use tauri::{AppHandle};
use tauri_plugin_updater::UpdaterExt;

fn is_unconfigured_updater_error(error: &str) -> bool {
    error.contains("Updater does not have any endpoints set.")
}

/// Check for updates and download silently in background
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<String, String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            
            // Download and install silently
            update
                .download_and_install(|_chunk_length, _content_length| {
                    // Progress callback - could emit events here
                }, || {
                    // Download finished callback
                })
                .await
                .map_err(|e| e.to_string())?;

            Ok(format!("Update {} downloaded successfully. Restart to apply.", version))
        }
        Ok(None) => Ok("No updates available".to_string()),
        Err(e) => {
            let error = e.to_string();
            if is_unconfigured_updater_error(&error) {
                Ok("Updater is not configured for this build".to_string())
            } else {
                Err(format!("Update check failed: {}", error))
            }
        }
    }
}

/// Get current app version
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}
