//! Publishing UI — Complete layouts and settings
//! 
//! Implements impl-v2 publishing UI features:
//! - Layout picker (Garden, Docs, Notebook)
//! - Publish panel with host selection
//! - Theme configuration

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri;

// ── Publishing Layouts ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublishLayout {
    Garden,   // Default: casual blog/wiki style
    Docs,     // Documentation site with sidebar nav
    Notebook, // Academic/research notebook style
}

impl PublishLayout {
    pub fn description(&self) -> &str {
        match self {
            PublishLayout::Garden => "Casual blog/digital garden with tag navigation",
            PublishLayout::Docs => "Documentation site with sidebar and search",
            PublishLayout::Notebook => "Academic notebook with citations and footnotes",
        }
    }
    
    pub fn quartz_preset(&self) -> &str {
        match self {
            PublishLayout::Garden => "garden",
            PublishLayout::Docs => "docs",
            PublishLayout::Notebook => "academic",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTheme {
    pub primary_color: String,      // "#3b82f6"
    pub background_color: String,   // "#ffffff"
    pub text_color: String,         // "#1f2937"
    pub accent_color: String,       // "#f59e0b"
    pub font_family: String,        // "Inter, sans-serif"
    pub code_font_family: String,   // "JetBrains Mono, monospace"
}

impl Default for PublishTheme {
    fn default() -> Self {
        Self {
            primary_color: "#3b82f6".to_string(),
            background_color: "#ffffff".to_string(),
            text_color: "#1f2937".to_string(),
            accent_color: "#f59e0b".to_string(),
            font_family: "Inter, sans-serif".to_string(),
            code_font_family: "JetBrains Mono, monospace".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishConfig {
    pub enabled: bool,
    pub layout: PublishLayout,
    pub theme: PublishTheme,
    pub site_title: String,
    pub site_description: String,
    pub author: String,
    pub host: String, // "github-pages", "vercel", "cloudflare"
    pub custom_domain: Option<String>,
    pub exclude_patterns: Vec<String>, // ["**/*.private.md", "drafts/**"]
}

impl Default for PublishConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            layout: PublishLayout::Garden,
            theme: PublishTheme::default(),
            site_title: "My Digital Garden".to_string(),
            site_description: "Personal knowledge base".to_string(),
            author: String::new(),
            host: "github-pages".to_string(),
            custom_domain: None,
            exclude_patterns: vec![
                "**/*.private.md".to_string(),
                "drafts/**".to_string(),
                ".obsidian/**".to_string(),
                ".lattice/**".to_string(),
            ],
        }
    }
}

// ── Host Configurations ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishHost {
    pub id: String,
    pub name: String,
    pub description: String,
    pub supports_custom_domain: bool,
    pub build_command: String,
    pub output_dir: String,
}

impl PublishHost {
    pub fn all() -> Vec<Self> {
        vec![
            Self {
                id: "github-pages".to_string(),
                name: "GitHub Pages".to_string(),
                description: "Free hosting for public repos".to_string(),
                supports_custom_domain: true,
                build_command: "quartz build".to_string(),
                output_dir: "public".to_string(),
            },
            Self {
                id: "vercel".to_string(),
                name: "Vercel".to_string(),
                description: "Fast CDN with automatic deployments".to_string(),
                supports_custom_domain: true,
                build_command: "quartz build".to_string(),
                output_dir: "public".to_string(),
            },
            Self {
                id: "cloudflare".to_string(),
                name: "Cloudflare Pages".to_string(),
                description: "Global edge network".to_string(),
                supports_custom_domain: true,
                build_command: "quartz build".to_string(),
                output_dir: "public".to_string(),
            },
        ]
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────

/// Get available publish layouts
#[tauri::command]
pub async fn publish_list_layouts() -> Result<Vec<LayoutInfo>, String> {
    Ok(vec![
        LayoutInfo {
            id: "garden".to_string(),
            name: "Garden".to_string(),
            description: PublishLayout::Garden.description().to_string(),
            preview_image: "/assets/layouts/garden.png".to_string(),
        },
        LayoutInfo {
            id: "docs".to_string(),
            name: "Documentation".to_string(),
            description: PublishLayout::Docs.description().to_string(),
            preview_image: "/assets/layouts/docs.png".to_string(),
        },
        LayoutInfo {
            id: "notebook".to_string(),
            name: "Notebook".to_string(),
            description: PublishLayout::Notebook.description().to_string(),
            preview_image: "/assets/layouts/notebook.png".to_string(),
        },
    ])
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub preview_image: String,
}

/// Get available publish hosts
#[tauri::command]
pub async fn publish_list_available_hosts() -> Result<Vec<PublishHost>, String> {
    Ok(PublishHost::all())
}

/// Get publish configuration
#[tauri::command]
pub async fn publish_get_config(vault_path: String) -> Result<PublishConfig, String> {
    let config_path = PathBuf::from(&vault_path)
        .join(".lattice")
        .join("publish.json");
    
    if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse config: {}", e))
    } else {
        Ok(PublishConfig::default())
    }
}

/// Save publish configuration
#[tauri::command]
pub async fn publish_save_config(
    vault_path: String,
    config: PublishConfig,
) -> Result<(), String> {
    let config_path = PathBuf::from(&vault_path)
        .join(".lattice")
        .join("publish.json");
    
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    std::fs::write(&config_path, json)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    
    Ok(())
}

/// Apply theme to publish site
#[tauri::command]
pub async fn publish_apply_theme(
    vault_path: String,
    theme: PublishTheme,
) -> Result<(), String> {
    // Generate CSS variables from theme
    let css = format!(
        r#":root {{
  --primary: {};
  --background: {};
  --text: {};
  --accent: {};
  --font-family: {};
  --code-font-family: {};
}}"#,
        theme.primary_color,
        theme.background_color,
        theme.text_color,
        theme.accent_color,
        theme.font_family,
        theme.code_font_family
    );
    
    let theme_path = PathBuf::from(&vault_path)
        .join(".lattice")
        .join("publish")
        .join("custom.css");
    
    if let Some(parent) = theme_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create theme dir: {}", e))?;
    }
    
    std::fs::write(&theme_path, css)
        .map_err(|e| format!("Failed to write theme: {}", e))?;
    
    Ok(())
}
// ── Publishing Adapters ─────────────────────────────────────────────────

/// GitHub Pages adapter - uses existing BYOC GitHub OAuth to push generated site
#[tauri::command]
pub async fn publish_deploy_github_pages(
    _vault_path: String,
    repo: String,
    _branch: String,
) -> Result<String, String> {
    // Placeholder: Full implementation would generate static site and push to gh-pages
    let url = format!("https://{}.github.io", repo.split('/').nth(1).unwrap_or("user"));
    Ok(url)
}

/// Cloudflare Pages adapter - Direct Upload API
#[tauri::command]
pub async fn publish_deploy_cloudflare(
    _vault_path: String,
    project_name: String,
    _api_token: String,
) -> Result<String, String> {
    // Placeholder: Full implementation would use Cloudflare Pages API
    let url = format!("https://{}.pages.dev", project_name);
    Ok(url)
}

/// Vercel adapter - OAuth PKCE + deployment API
#[tauri::command]
pub async fn publish_deploy_vercel(
    _vault_path: String,
    project_name: String,
    _team_id: Option<String>,
) -> Result<String, String> {
    // Placeholder: Full implementation would use Vercel deployment API
    let url = format!("https://{}.vercel.app", project_name);
    Ok(url)
}

/// Quartz SSG bundler - bundle Quartz v5 and build locally
#[tauri::command]
pub async fn publish_build_quartz(
    _vault_path: String,
    _output_path: String,
) -> Result<(), String> {
    // Placeholder: Full implementation would run `npx quartz build`
    Ok(())
}
