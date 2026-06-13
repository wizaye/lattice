//! Intelligent commit message generation using BYOM
//!
//! Generates meaningful commit messages automatically by analyzing:
//! - File changes (added, modified, deleted)
//! - Diff statistics
//! - File types and patterns
//! - Optional AI enhancement via BYOM providers

use std::path::Path;
use serde::{Serialize, Deserialize};

/// Commit message generator
pub struct CommitMessageGenerator {
    /// Optional AI provider for enhanced messages
    ai_provider: Option<Box<dyn AIProvider>>,
}

/// Analysis of changes in the vault
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeAnalysis {
    pub added_files: Vec<String>,
    pub modified_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub renamed_files: Vec<(String, String)>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

/// Generated commit message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitMessage {
    pub message: String,
    pub ai_generated: bool,
}

/// Trait for AI providers (Ollama, OpenAI, etc.)
pub trait AIProvider: Send + Sync {
    fn generate_commit_message(
        &self,
        analysis: &ChangeAnalysis,
        diff_preview: &str,
    ) -> Result<String, String>;
}

impl CommitMessageGenerator {
    pub fn new() -> Self {
        Self { ai_provider: None }
    }

    pub fn with_ai_provider(provider: Box<dyn AIProvider>) -> Self {
        Self {
            ai_provider: Some(provider),
        }
    }

    /// Generate commit message from change analysis
    pub async fn generate(
        &self,
        analysis: &ChangeAnalysis,
        diff_preview: Option<&str>,
    ) -> CommitMessage {
        // Try AI-powered generation first if available
        if let Some(provider) = &self.ai_provider {
            if let Some(diff) = diff_preview {
                if let Ok(msg) = provider.generate_commit_message(analysis, diff) {
                    return CommitMessage {
                        message: msg,
                        ai_generated: true,
                    };
                }
            }
        }

        // Fallback to heuristic generation
        let message = self.generate_heuristic(analysis);
        CommitMessage {
            message,
            ai_generated: false,
        }
    }

    /// Heuristic-based message generation (no AI required)
    fn generate_heuristic(&self, analysis: &ChangeAnalysis) -> String {
        let total_files = analysis.added_files.len()
            + analysis.modified_files.len()
            + analysis.deleted_files.len()
            + analysis.renamed_files.len();

        // Single file operations
        if total_files == 1 {
            if let Some(file) = analysis.added_files.first() {
                return format!("Create {}", file);
            }
            if let Some(file) = analysis.deleted_files.first() {
                return format!("Delete {}", file);
            }
            if let Some((old, new)) = analysis.renamed_files.first() {
                return format!("Rename {} → {}", old, new);
            }
            if let Some(file) = analysis.modified_files.first() {
                // Try to be more specific for modified files
                if analysis.total_additions > 0 && analysis.total_deletions == 0 {
                    return format!("Add content to {}", file);
                } else if analysis.total_deletions > 0 && analysis.total_additions == 0 {
                    return format!("Remove content from {}", file);
                } else {
                    return format!("Edit {}", file);
                }
            }
        }

        // Multiple files - try to find patterns
        if analysis.added_files.len() > 0 && analysis.modified_files.is_empty() && analysis.deleted_files.is_empty() {
            if analysis.added_files.len() <= 3 {
                let files = analysis.added_files.join(", ");
                return format!("Create {}", files);
            } else {
                return format!("Create {} new files", analysis.added_files.len());
            }
        }

        if analysis.deleted_files.len() > 0 && analysis.modified_files.is_empty() && analysis.added_files.is_empty() {
            if analysis.deleted_files.len() <= 3 {
                let files = analysis.deleted_files.join(", ");
                return format!("Delete {}", files);
            } else {
                return format!("Delete {} files", analysis.deleted_files.len());
            }
        }

        // Check if files are in the same folder
        if let Some(common_folder) = find_common_folder(&analysis.modified_files) {
            return format!("Edit {} files in {}", analysis.modified_files.len(), common_folder);
        }

        // Mixed changes - generic message
        if total_files <= 5 {
            let mut parts = Vec::new();
            if !analysis.added_files.is_empty() {
                parts.push(format!("{} added", analysis.added_files.len()));
            }
            if !analysis.modified_files.is_empty() {
                parts.push(format!("{} modified", analysis.modified_files.len()));
            }
            if !analysis.deleted_files.is_empty() {
                parts.push(format!("{} deleted", analysis.deleted_files.len()));
            }
            return format!("Update {} files ({})", total_files, parts.join(", "));
        } else {
            return format!("Update {} files in vault", total_files);
        }
    }
}

/// Find common folder for a list of files
fn find_common_folder(files: &[String]) -> Option<String> {
    if files.is_empty() {
        return None;
    }

    // Split paths and find common prefix
    let paths: Vec<Vec<&str>> = files
        .iter()
        .map(|f| f.split('/').collect())
        .collect();

    let mut common = Vec::new();
    for i in 0.. {
        let segment = paths[0].get(i)?;
        if paths.iter().all(|p| p.get(i) == Some(segment)) {
            common.push(*segment);
        } else {
            break;
        }
    }

    if common.len() > 0 {
        Some(common.join("/"))
    } else {
        None
    }
}

// ── Ollama Provider (stub for BYOM integration) ─────────────────────────

/// Ollama AI provider for commit message generation
pub struct OllamaProvider {
    base_url: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(model: String) -> Self {
        Self {
            base_url: "http://localhost:11434".to_string(),
            model,
        }
    }

    pub async fn is_available(&self) -> bool {
        let url = format!("{}/api/tags", self.base_url);
        match reqwest::get(&url).await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }
}

impl AIProvider for OllamaProvider {
    fn generate_commit_message(
        &self,
        analysis: &ChangeAnalysis,
        diff_preview: &str,
    ) -> Result<String, String> {
        // Build context-aware prompt
        let prompt = format!(
            "You are a git commit message generator. Generate a concise, meaningful commit message.\n\n\
            Changes:\n\
            - Added: {} files\n\
            - Modified: {} files\n\
            - Deleted: {} files\n\
            - Lines added: {}\n\
            - Lines removed: {}\n\n\
            Diff preview:\n{}\n\n\
            Generate ONLY the commit message (one line, max 72 chars). No explanations.",
            analysis.added_files.len(),
            analysis.modified_files.len(),
            analysis.deleted_files.len(),
            analysis.total_additions,
            analysis.total_deletions,
            diff_preview
        );

        // Synchronous HTTP call (blocking)
        let client = reqwest::blocking::Client::new();
        let url = format!("{}/api/generate", self.base_url);
        
        let body = serde_json::json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
            "options": {
                "temperature": 0.7,
                "num_predict": 100
            }
        });

        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| format!("Ollama request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Ollama returned status {}", resp.status()));
        }

        #[derive(serde::Deserialize)]
        struct OllamaResponse {
            response: String,
        }

        let data: OllamaResponse = resp
            .json()
            .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

        Ok(data.response.trim().to_string())
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────

/// Generate commit message for current changes
#[tauri::command]
pub async fn vcs_generate_commit_message(
    vault_path: String,
    use_ai: bool,
) -> Result<CommitMessage, String> {
    let vault = std::path::PathBuf::from(&vault_path);
    
    // Get git status and analyze changes
    let analysis = analyze_changes(&vault).await?;
    
    let generator = if use_ai {
        // Try to use Ollama if available
        CommitMessageGenerator::with_ai_provider(Box::new(OllamaProvider::new(
            "llama2".to_string(),
        )))
    } else {
        CommitMessageGenerator::new()
    };
    
    // Get diff preview (first 2KB for AI)
    let diff_preview = get_diff_preview(&vault)?;
    
    Ok(generator.generate(&analysis, Some(&diff_preview)).await)
}

/// Check if Ollama is available
#[tauri::command]
pub async fn byom_check_ollama() -> Result<bool, String> {
    let provider = OllamaProvider::new("llama2".to_string());
    Ok(provider.is_available().await)
}

// ── Helper Functions ────────────────────────────────────────────────────

async fn analyze_changes(vault: &Path) -> Result<ChangeAnalysis, String> {
    // Use existing git module's vcs_status
    let vault_path = vault.to_string_lossy().to_string();
    let status = crate::git::vcs_status(vault_path).await?;

    let mut analysis = ChangeAnalysis {
        added_files: vec![],
        modified_files: vec![],
        deleted_files: vec![],
        renamed_files: vec![],
        total_additions: 0,
        total_deletions: 0,
    };

    // Parse staged changes (these will be committed)
    for change in status.staged.iter().chain(status.unstaged.iter()) {
        match change.status.as_str() {
            "A" | "AM" => analysis.added_files.push(change.path.clone()),
            "M" | "MM" => analysis.modified_files.push(change.path.clone()),
            "D" => analysis.deleted_files.push(change.path.clone()),
            "R" | "RM" => {
                if let Some(orig) = &change.orig_path {
                    analysis.renamed_files.push((orig.clone(), change.path.clone()));
                }
            }
            _ => {}
        }
    }

    // Get diff stats using git module
    if let Ok(diff) = get_diff_preview(vault) {
        // Count additions/deletions from diff
        for line in diff.lines() {
            if line.starts_with('+') && !line.starts_with("+++") {
                analysis.total_additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                analysis.total_deletions += 1;
            }
        }
    }

    Ok(analysis)
}

fn get_diff_preview(vault: &Path) -> Result<String, String> {
    use std::process::Command;

    let git_dir = vault.join(".lattice").join("git");
    
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(&git_dir)
        .arg("--work-tree")
        .arg(vault)
        .arg("diff")
        .arg("HEAD")
        .output()
        .map_err(|e| format!("Failed to get diff: {}", e))?;

    if !output.status.success() {
        return Ok(String::new());
    }

    let diff = String::from_utf8_lossy(&output.stdout);
    
    // Take first 2KB for AI context
    let preview = if diff.len() > 2048 {
        &diff[..2048]
    } else {
        &diff[..]
    };

    Ok(preview.to_string())
}
