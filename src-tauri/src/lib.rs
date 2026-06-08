mod commands;
mod git;
mod paper;
mod publish;
mod sync;

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
            // BYOC sync layer — bring-your-own-cloud (slice B):
            // first iteration covers GitHub (Device Code Flow + git
            // push/pull) and Google Drive (PKCE + appDataFolder
            // upload).  OneDrive + Dropbox land in a later slice.
            sync::byoc_list_providers,
            sync::byoc_status,
            sync::byoc_connect,
            sync::byoc_disconnect,
            sync::byoc_push,
            sync::byoc_pull,
            sync::byoc_sync_now,
            // Storage-transparency + reveal helpers.  Pure read-only
            // metadata commands; no side effects.  UI uses these to
            // render "Tokens live in ..." + "Open remote" + "Reveal
            // local manifest" actions in the kebab menu.
            sync::byoc_storage_info,
            sync::byoc_remote_url,
            sync::byoc_manifest_path,
            // Slice C — paper export (markdown → PDF, Overleaf bundle).
            // Phase C1 ships paper_list_templates + paper_create end-to-end;
            // the rest of the surface is registered but returns a clear
            // "phase X — not yet implemented" error string until the
            // matching slice lands.  See docs/paper-export-plan.md.
            paper::paper_list_templates,
            paper::paper_create,
            paper::paper_status,
            paper::paper_set_compile_engine,
            paper::paper_compile,
            paper::paper_preflight,
            paper::paper_emit_bundle,
            paper::paper_open_overleaf,
            paper::paper_diff,
            paper::paper_byof_import,
            paper::paper_byof_re_import,
            paper::paper_byof_remove,
            // Slice D — publishing (vault → Quartz v5 site → host).
            // Phase D1 ships publish_probe + publish_list_hosts +
            // publish_list_templates + publish_status end-to-end;
            // every other publish_* is registered but returns a
            // "phase X — not yet implemented" error until the
            // matching slice lands.  See docs/publishing-plan.md.
            publish::publish_probe,
            publish::publish_list_hosts,
            publish::publish_list_templates,
            publish::publish_status,
            publish::publish_init,
            publish::publish_auth_start,
            publish::publish_auth_complete,
            publish::publish_auth_pick,
            publish::publish_build,
            publish::publish_preview,
            publish::publish_preview_stop,
            publish::publish_deploy,
            publish::publish_disconnect,
            publish::publish_open_dashboard,
            publish::publish_open_live,
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
