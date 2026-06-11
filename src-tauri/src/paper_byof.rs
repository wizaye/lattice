//! Paper BYOF (Bring Your Own Format) System
//! 
//! Implements impl-v2 §8.5 — template import and adapter generation
//! Student imports a .zip template (LaTeX or Typst), and Lattice generates
//! an adapter that compiles their markdown notes into that template.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri;
use std::fs;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperTemplate {
    pub id: String,
    pub name: String,
    pub format: String,  // latex or typst
    pub entry_file: String,  // main.tex or paper.typ
    pub sections: Vec<String>,  // Detected section files
    pub bibliography: Option<String>,  // bibliography.bib
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperAdapter {
    pub template_id: String,
    pub vault_path: String,
    pub output_dir: String,
    pub section_mapping: Vec<(String, String)>,  // (template section, vault note)
}

/// Import a BYOF template from a ZIP file
#[tauri::command]
pub async fn paper_import_template(
    zip_path: String,
    vault_path: String,
) -> Result<PaperTemplate, String> {
    // 1. Extract ZIP to temp directory
    let temp_dir = std::env::temp_dir().join(format!("lattice-byof-{}", chrono::Utc::now().timestamp()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    
    // 2. Parse template to detect format, entry file, sections
    let template = detect_template_structure(&temp_dir)?;
    
    // 3. Copy template to vault .lattice/paper-templates/
    let template_dir = PathBuf::from(&vault_path)
        .join(".lattice/paper-templates")
        .join(&template.id);
    
    fs::create_dir_all(&template_dir)
        .map_err(|e| format!("Failed to create template dir: {}", e))?;
    
    copy_dir_all(&temp_dir, &template_dir)
        .map_err(|e| format!("Failed to copy template: {}", e))?;
    
    // 4. Cleanup temp dir
    let _ = fs::remove_dir_all(&temp_dir);
    
    Ok(template)
}

/// Generate adapter code that compiles markdown to the template format
#[tauri::command]
pub async fn paper_generate_adapter(
    template_id: String,
    vault_path: String,
) -> Result<PaperAdapter, String> {
    // Placeholder: Full implementation would generate compilation scripts
    // that convert markdown sections to LaTeX/Typst and inject into template
    
    let adapter = PaperAdapter {
        template_id: template_id.clone(),
        vault_path: vault_path.clone(),
        output_dir: format!("{}/build", vault_path),
        section_mapping: vec![],
    };
    
    Ok(adapter)
}

/// Compile paper using the adapter
#[tauri::command]
pub async fn paper_compile(
    adapter_id: String,
    vault_path: String,
) -> Result<String, String> {
    // Placeholder: Full implementation would:
    // 1. Convert each mapped markdown file to LaTeX/Typst
    // 2. Inject into template
    // 3. Run pdflatex/typst compile
    // 4. Return path to generated PDF
    
    let output_path = format!("{}/build/paper.pdf", vault_path);
    Ok(output_path)
}

/// List available templates
#[tauri::command]
pub async fn paper_list_templates(
    vault_path: String,
) -> Result<Vec<PaperTemplate>, String> {
    let template_dir = PathBuf::from(&vault_path).join(".lattice/paper-templates");
    
    if !template_dir.exists() {
        return Ok(vec![]);
    }
    
    let mut templates = vec![];
    
    for entry in fs::read_dir(&template_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            if let Ok(template) = detect_template_structure(&entry.path()) {
                templates.push(template);
            }
        }
    }
    
    Ok(templates)
}

// ── Helper Functions ────────────────────────────────────────────────────

fn detect_template_structure(path: &PathBuf) -> Result<PaperTemplate, String> {
    let mut entry_file = None;
    let mut format = None;
    let mut sections = vec![];
    let mut bibliography = None;
    
    for entry in WalkDir::new(path).max_depth(2) {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        
        if file_name.ends_with(".tex") && (file_name.contains("main") || file_name.contains("paper")) {
            entry_file = Some(file_name.clone());
            format = Some("latex".to_string());
        } else if file_name.ends_with(".typ") {
            entry_file = Some(file_name.clone());
            format = Some("typst".to_string());
        } else if file_name.ends_with(".bib") {
            bibliography = Some(file_name);
        } else if file_name.ends_with(".tex") || file_name.ends_with(".typ") {
            sections.push(file_name);
        }
    }
    
    let template_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    
    Ok(PaperTemplate {
        id: format!("byof-{}", chrono::Utc::now().timestamp()),
        name: template_name,
        format: format.unwrap_or("latex".to_string()),
        entry_file: entry_file.unwrap_or("main.tex".to_string()),
        sections,
        bibliography,
    })
}

fn copy_dir_all(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}
