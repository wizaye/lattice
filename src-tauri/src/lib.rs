mod calendar;
mod commands;
mod git;
mod journal;
mod paper;
mod publish;
mod sync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Prepend Lattice's own bin dir (where `paper_engine_install`
    // drops tectonic.exe) to PATH for the entire Lattice process.
    // Idempotent — safe to call on every launch.  Without this,
    // tectonic installed in a previous Lattice session would not
    // be on PATH until the user manually added it via the Windows
    // System Properties dialog.
    paper::engine_install::prepend_bin_dir_to_path();

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
            paper::paper_quick_pdf,
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
            // LaTeX-engine preflight (probe + install).  Backs the
            // New-Paper modal's inline "Install Tectonic" banner so
            // users on fresh boxes never dead-end with a folder + no
            // usable PDF.
            paper::engine_install::paper_engine_probe,
            paper::engine_install::paper_engine_install,
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
            publish::publish_set_theme,
            publish::publish_build,
            publish::publish_preview,
            publish::publish_preview_stop,
            publish::publish_deploy,
            publish::publish_disconnect,
            publish::publish_open_dashboard,
            publish::publish_open_live,
            // v2 §2 — Journaling (Logseq-style daily notes).
            // Storage: <vault>/journals/YYYY-MM-DD.md.  Settings live
            // at <vault>/.lattice/journal.json so each vault carries
            // its own folder / template / filename-format config.
            // Ctrl+Shift+D in App.tsx routes through journal_open_today.
            journal::journal_open_today,
            journal::journal_open_date,
            journal::journal_list_dates,
            journal::journal_streak,
            journal::journal_get_settings,
            journal::journal_set_settings,
            // v2 §1 — Calendar (unified internal model + Local provider).
            // The four network providers (Outlook A / Cal.com B /
            // Google C / Apple C) ship as stubs in `cal_list_providers`
            // today; their auth flows land in the next slice without
            // changing the IPC surface here.
            calendar::cal_list_events,
            calendar::cal_create_event,
            calendar::cal_update_event,
            calendar::cal_delete_event,
            calendar::cal_list_providers,
            calendar::cal_today_local,
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
