mod commands;
mod git;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::read_file_bytes,
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
            // VCS — system `git` via subprocess.  Opt-in per vault:
            // `git_check_installed` drives the onboarding install
            // prompt; everything else assumes git is on PATH and the
            // vault is initialised (or will return `initialized=false`
            // so the UI can show the Enable CTA).
            git::git_check_installed,
            git::vcs_status,
            git::vcs_preview_untracked_count,
            git::vcs_init,
            git::vcs_stage,
            git::vcs_unstage,
            git::vcs_discard,
            git::vcs_commit,
            git::vcs_commit_all,
            git::vcs_log,
            git::vcs_diff_file,
            git::vcs_checkout_file,
            // Slice B: branches + graph view.
            git::vcs_branches,
            git::vcs_branch_create,
            git::vcs_branch_switch,
            git::vcs_branch_delete,
            git::vcs_log_graph,
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
