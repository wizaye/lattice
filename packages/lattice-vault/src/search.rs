use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::Path;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub backend: SearchBackend,
    pub ripgrep_path: Option<String>,
    pub fzf_path: Option<String>,
    pub case_sensitive: bool,
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SearchBackend {
    Ripgrep,
    Fzf,
    Native,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            backend: SearchBackend::Ripgrep, // Try ripgrep first
            ripgrep_path: None, // Auto-detect
            fzf_path: None,     // Auto-detect
            case_sensitive: false,
            max_results: 1000,
        }
    }
}

/// Detect available search backends
pub fn detect_search_backends() -> Vec<SearchBackend> {
    let mut backends = Vec::new();

    // Check for ripgrep
    if Command::new("rg").arg("--version").output().is_ok() {
        backends.push(SearchBackend::Ripgrep);
        info!("Detected ripgrep");
    }

    // Check for fzf
    if Command::new("fzf").arg("--version").output().is_ok() {
        backends.push(SearchBackend::Fzf);
        info!("Detected fzf");
    }

    // Native is always available
    backends.push(SearchBackend::Native);

    backends
}

/// Search using ripgrep
fn search_with_ripgrep(
    vault_path: &Path,
    query: &str,
    config: &SearchConfig,
) -> Result<Vec<SearchResult>, String> {
    let rg_cmd = config.ripgrep_path.as_deref().unwrap_or("rg");

    let mut cmd = Command::new(rg_cmd);
    cmd.arg("--json")
        .arg("--no-heading")
        .arg("--line-number")
        .arg("--column");

    if !config.case_sensitive {
        cmd.arg("--ignore-case");
    }

    cmd.arg("--max-count")
        .arg(config.max_results.to_string());

    // Only search markdown files
    cmd.arg("--type").arg("md");

    cmd.arg(query).arg(vault_path);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ripgrep: {}", e))?;

    if !output.status.success() && !output.stdout.is_empty() {
        // ripgrep returns exit code 1 when no matches, which is fine
    }

    let mut results = Vec::new();
    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if json["type"] == "match" {
                if let Some(data) = json["data"].as_object() {
                    let file_path = data["path"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    let line_number = data["line_number"].as_u64().unwrap_or(0) as usize;
                    let line_content = data["lines"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    // Extract match positions
                    let empty_vec = vec![];
                    let submatches = data["submatches"].as_array().unwrap_or(&empty_vec);
                    for submatch in submatches {
                        let match_start = submatch["start"].as_u64().unwrap_or(0) as usize;
                        let match_end = submatch["end"].as_u64().unwrap_or(0) as usize;

                        results.push(SearchResult {
                            file_path: file_path.clone(),
                            line_number,
                            line_content: line_content.clone(),
                            match_start,
                            match_end,
                        });
                    }
                }
            }
        }
    }

    Ok(results)
}

/// Search using fzf (fallback)
fn search_with_fzf(
    vault_path: &Path,
    query: &str,
    config: &SearchConfig,
) -> Result<Vec<SearchResult>, String> {
    // fzf doesn't search content directly, so use native search with fzf scoring
    search_with_native(vault_path, query, config)
}

/// Native search implementation (slowest, but always available)
fn search_with_native(
    vault_path: &Path,
    query: &str,
    config: &SearchConfig,
) -> Result<Vec<SearchResult>, String> {
    use walkdir::WalkDir;
    use std::fs;

    let mut results = Vec::new();
    let query_lower = query.to_lowercase();

    for entry in WalkDir::new(vault_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Only search .md files
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }

        if let Ok(content) = fs::read_to_string(path) {
            for (line_num, line) in content.lines().enumerate() {
                let search_line = if config.case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };

                let search_query = if config.case_sensitive {
                    query.to_string()
                } else {
                    query_lower.clone()
                };

                if let Some(pos) = search_line.find(&search_query) {
                    results.push(SearchResult {
                        file_path: path.to_string_lossy().to_string(),
                        line_number: line_num + 1,
                        line_content: line.trim().to_string(),
                        match_start: pos,
                        match_end: pos + query.len(),
                    });

                    if results.len() >= config.max_results {
                        return Ok(results);
                    }
                }
            }
        }
    }

    Ok(results)
}

/// Main search function with fallback chain
pub fn search(
    vault_path: &Path,
    query: &str,
    config: &SearchConfig,
) -> Result<Vec<SearchResult>, String> {
    info!(
        "Searching vault with backend {:?}: {}",
        config.backend, query
    );

    match config.backend {
        SearchBackend::Ripgrep => search_with_ripgrep(vault_path, query, config).or_else(|e| {
            warn!("Ripgrep search failed: {}, falling back to native", e);
            search_with_native(vault_path, query, config)
        }),
        SearchBackend::Fzf => search_with_fzf(vault_path, query, config).or_else(|e| {
            warn!("Fzf search failed: {}, falling back to native", e);
            search_with_native(vault_path, query, config)
        }),
        SearchBackend::Native => search_with_native(vault_path, query, config),
    }
}
