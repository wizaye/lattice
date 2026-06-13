use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteFolder {
    Inbox,
    Quick,
    Archive,
    Trash,
    Daily,
    Root,
}

impl NoteFolder {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Quick => "quick",
            Self::Archive => "archive",
            Self::Trash => "trash",
            Self::Daily => "Daily Notes",
            Self::Root => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultSettings {
    pub primary_notes_location: NoteFolder,
    pub daily_notes: DailyNotesConfig,
    pub folder_labels: HashMap<String, String>,
    pub folder_icons: HashMap<String, String>,
    pub default_new_note_folder: NoteFolder,
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self {
            primary_notes_location: NoteFolder::Inbox,
            daily_notes: DailyNotesConfig::default(),
            folder_labels: HashMap::new(),
            folder_icons: HashMap::new(),
            default_new_note_folder: NoteFolder::Inbox,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyNotesConfig {
    pub enabled: bool,
    pub dir: String,
    pub template: Option<String>,
}

impl Default for DailyNotesConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            dir: "Daily Notes".to_string(),
            template: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub size: u64,
    pub tags: Vec<String>,
    pub frontmatter: HashMap<String, serde_json::Value>,
    pub word_count: usize,
    pub folder: NoteFolder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteContent {
    pub meta: NoteMeta,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub note_path: String,
    pub line_number: usize,
    pub text: String,
    pub checked: bool,
    pub priority: Option<String>,
    pub due: Option<String>,
    pub marker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum VaultChangeEvent {
    Created {
        path: String,
        scope: ChangeScope,
    },
    Modified {
        path: String,
        scope: ChangeScope,
    },
    Deleted {
        path: String,
        scope: ChangeScope,
    },
    Renamed {
        old_path: String,
        new_path: String,
        scope: ChangeScope,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeScope {
    Note,
    Asset,
    Folder,
    VaultSettings,
}
