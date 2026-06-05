mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::list_directory,
            commands::create_file,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_file,
            commands::delete_folder,
            commands::open_new_window,
            commands::get_vault_graph,
            commands::get_backlinks,
        ])
        .setup(|app| {
            // Set a larger default window size for the PKM workspace
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Lattice");
                let _ = window.set_size(tauri::LogicalSize::new(1400.0, 900.0));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
