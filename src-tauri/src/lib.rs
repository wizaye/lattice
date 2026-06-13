#[allow(dead_code)]
mod byom;
#[allow(dead_code)]
mod calendar;
#[allow(dead_code)]
mod canvas;
mod commands;
mod fs_service;    // Repository + GraphService
mod importer;      // Strategy pattern importers
mod git;
mod journal;
mod paper;
mod publish;
#[allow(dead_code)]
mod publish_ui;
mod sync;
mod vcs_commit_ai;
#[allow(dead_code)]
mod vcs_auto_commit;
mod importers;
#[allow(dead_code)]
mod e2ee;
mod vault_commands;
mod updater;
#[allow(dead_code)]
mod github_byoc;
mod ota_updater;

use tauri::Manager;
use vault_commands::VaultState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Prepend Lattice's own bin dir to PATH only when it actually
    // contains at least one file (e.g. tectonic.exe placed there by
    // paper_engine_install).  This avoids mutating PATH for users who
    // never use the paper feature — and prevents the Lattice bin dir
    // from shadowing legitimate system binaries when it happens to
    // contain a file with the same name (e.g. a stale tectonic build
    // whose name collides with a user's own tectonic in /usr/local/bin).
    //
    // Bug 37 fix: the old code called prepend_bin_dir_to_path()
    // unconditionally on every launch regardless of whether the paper
    // feature had ever been used.
    if paper::engine_install::lattice_bin_dir_has_content() {
        paper::engine_install::prepend_bin_dir_to_path();
    }

    tauri::Builder::default()
        .manage(VaultState(std::sync::Arc::new(tokio::sync::RwLock::new(None))))
        // E2EE managed state — persists the unlocked key across IPC calls.
        // Must be registered before invoke_handler so every e2ee_* command
        // can receive tauri::State<e2ee::E2EEState>.
        .manage(e2ee::E2EEState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // Vault operations (new)
            vault_commands::open_vault,
            vault_commands::close_vault,
            vault_commands::list_notes,
            vault_commands::read_note,
            vault_commands::write_note,
            vault_commands::create_note,
            vault_commands::rename_note,
            vault_commands::move_to_trash,
            vault_commands::restore_from_trash,
            vault_commands::archive_note,
            vault_commands::unarchive_note,
            vault_commands::delete_note,
            vault_commands::scan_tasks,
            vault_commands::scan_tasks_for_note,
            vault_commands::toggle_task,
            vault_commands::get_vault_settings,
            vault_commands::set_vault_settings,
            vault_commands::get_backlinks,
            // Original commands
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
            commands::get_backlinks_legacy,
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
            calendar::cal_get_sync_state,
            calendar::cal_update_sync_state,
            // v2 §4 — VCS intelligent commit messages (BYOM-powered).
            vcs_commit_ai::vcs_generate_commit_message,
            vcs_commit_ai::byom_check_ollama,
            // v2 §4.1 — VCS auto-commit cadence (old IPC stubs removed;
            // the scheduler is now driven programmatically via
            // AutoCommitScheduler — no IPC surface in the refactored design).
            // v2 §5 — BYOM (Ollama / OpenAI / Anthropic).
            byom::byom_check_ollama_available,
            byom::byom_list_ollama_models,
            byom::byom_chat,
            // v2 §11 — Importers (Obsidian, Logseq, Notion)
            importers::import_obsidian_vault,
            importers::import_logseq_graph,
            importers::import_notion_export,
            // v2 §9 — E2EE (age/rage encryption)
            e2ee::e2ee_initialize,
            e2ee::e2ee_is_enabled,
            e2ee::e2ee_unlock,
            e2ee::e2ee_lock,
            e2ee::e2ee_is_unlocked,
            e2ee::e2ee_status,
            // Auto-updater
            updater::check_for_updates,
            updater::get_app_version,
            // GitHub BYOC
            github_byoc::github_byoc_init,
            github_byoc::github_byoc_push,
            github_byoc::github_byoc_pull,
            github_byoc::github_byoc_status,
            github_byoc::github_byoc_sync,
            github_byoc::github_byoc_clone,
            // OTA Updater
            ota_updater::ota_check_for_updates,
            ota_updater::ota_download_and_install,
            ota_updater::ota_get_settings,
            ota_updater::ota_set_settings,
            ota_updater::ota_startup_check,
            ota_updater::ota_get_release_notes,
            // v2 §3 — Canvas enhancements (export, snap, guides, stickies, images, embeds, arrows, layers, frames, minimap)
            canvas::canvas_export_svg,
            canvas::canvas_export_tikz,
            canvas::canvas_export_png,
            canvas::canvas_get_smart_guides,
            canvas::canvas_snap_to_grid,
            canvas::canvas_add_sticky,
            canvas::canvas_update_sticky,
            canvas::canvas_delete_sticky,
            canvas::canvas_add_image,
            canvas::canvas_add_embed,
            canvas::canvas_update_arrow_style,
            canvas::canvas_create_layer,
            canvas::canvas_toggle_layer_visibility,
            canvas::canvas_create_frame,
            canvas::canvas_export_frame,
            canvas::canvas_toggle_minimap,
            canvas::canvas_update_minimap_config,
            // v2 Publishing UI
            publish_ui::publish_list_layouts,
            publish_ui::publish_list_available_hosts,
            publish_ui::publish_get_config,
            publish_ui::publish_save_config,
            publish_ui::publish_apply_theme,
            publish_ui::publish_deploy_github_pages,
            publish_ui::publish_deploy_cloudflare,
            publish_ui::publish_deploy_vercel,
            publish_ui::publish_build_quartz,
        ])
        .setup(|app| {
            // Set a larger default window size for the PKM workspace
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Lattice");
                let _ = window.set_size(tauri::LogicalSize::new(1400.0, 900.0));
            }
            
            // Start OTA update checker using Tauri's async runtime
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ota_updater::start_update_checker(app_handle).await;
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
