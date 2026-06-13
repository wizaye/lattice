/**
 * GitHub BYOC (Bring Your Own Cloud) Adapter
 * Syncs vault to/from GitHub repository using PKCE OAuth
 */

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubConfig {
    pub repo_owner: String,
    pub repo_name: String,
    pub branch: String,
    pub access_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubSyncStatus {
    pub last_sync: Option<String>,
    pub commits_ahead: usize,
    pub commits_behind: usize,
    pub has_conflicts: bool,
}

/// Initialize GitHub repository for BYOC
#[tauri::command]
pub async fn github_byoc_init(
    vault_path: String,
    owner: String,
    repo: String,
    branch: String,
) -> Result<String, String> {
    let path = Path::new(&vault_path);

    // Initialize git if not already
    if !path.join(".git").exists() {
        Command::new("git")
            .args(&["init"])
            .current_dir(path)
            .output()
            .map_err(|e| format!("Failed to init git: {}", e))?;

        Command::new("git")
            .args(&["branch", "-M", &branch])
            .current_dir(path)
            .output()
            .map_err(|e| format!("Failed to set branch: {}", e))?;
    }

    // Add remote
    let remote_url = format!("https://github.com/{}/{}.git", owner, repo);
    Command::new("git")
        .args(&["remote", "add", "origin", &remote_url])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to add remote: {}", e))?;

    Ok(format!("Initialized GitHub BYOC: {}/{}", owner, repo))
}

/// Push vault to GitHub
#[tauri::command]
pub async fn github_byoc_push(vault_path: String, message: String) -> Result<String, String> {
    let path = Path::new(&vault_path);

    // Stage all changes
    Command::new("git")
        .args(&["add", "."])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to stage: {}", e))?;

    // Commit
    let output = Command::new("git")
        .args(&["commit", "-m", &message])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("nothing to commit") {
            return Ok("Nothing to commit".to_string());
        }
        return Err(format!("Commit failed: {}", stderr));
    }

    // Push
    let push_output = Command::new("git")
        .args(&["push", "-u", "origin", "HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("Push failed: {}", stderr));
    }

    Ok("Pushed to GitHub".to_string())
}

/// Pull changes from GitHub
#[tauri::command]
pub async fn github_byoc_pull(vault_path: String) -> Result<String, String> {
    let path = Path::new(&vault_path);

    let output = Command::new("git")
        .args(&["pull", "--rebase"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to pull: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Pull failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

/// Get sync status
#[tauri::command]
pub async fn github_byoc_status(vault_path: String) -> Result<GitHubSyncStatus, String> {
    let path = Path::new(&vault_path);

    // Fetch from remote
    let _ = Command::new("git")
        .args(&["fetch", "origin"])
        .current_dir(path)
        .output();

    // Get commits ahead/behind
    let rev_list = Command::new("git")
        .args(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to get rev-list: {}", e))?;

    let counts = String::from_utf8_lossy(&rev_list.stdout);
    let parts: Vec<&str> = counts.trim().split_whitespace().collect();
    
    let commits_ahead = parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0);
    let commits_behind = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

    // Check for conflicts
    let status = Command::new("git")
        .args(&["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let status_str = String::from_utf8_lossy(&status.stdout);
    let has_conflicts = status_str.contains("UU ") || status_str.contains("AA ");

    // Get last sync time
    let log = Command::new("git")
        .args(&["log", "-1", "--format=%ai"])
        .current_dir(path)
        .output()
        .ok();

    let last_sync = log.and_then(|l| {
        let s = String::from_utf8_lossy(&l.stdout);
        Some(s.trim().to_string())
    });

    Ok(GitHubSyncStatus {
        last_sync,
        commits_ahead,
        commits_behind,
        has_conflicts,
    })
}

/// Auto-sync: pull then push
#[tauri::command]
pub async fn github_byoc_sync(vault_path: String, message: String) -> Result<String, String> {
    // Pull first
    github_byoc_pull(vault_path.clone()).await?;

    // Then push
    github_byoc_push(vault_path, message).await
}

/// Clone repository to vault path
#[tauri::command]
pub async fn github_byoc_clone(
    vault_path: String,
    owner: String,
    repo: String,
    branch: String,
) -> Result<String, String> {
    let remote_url = format!("https://github.com/{}/{}.git", owner, repo);

    let output = Command::new("git")
        .args(&["clone", "-b", &branch, &remote_url, &vault_path])
        .output()
        .map_err(|e| format!("Failed to clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Clone failed: {}", stderr));
    }

    Ok(format!("Cloned {}/{} to {}", owner, repo, vault_path))
}
