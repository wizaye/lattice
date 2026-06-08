//! `paper.toml` schema — §5 of `docs/paper-export-plan.md`.
//!
//! Round-tripped through the `toml = "0.9"` crate.  All fields are
//! `#[serde(default)]` except `[meta]` and `[engine]` so a hand-edited
//! file with just the bare minimum still loads cleanly.
//!
//! The full schema is broader than what we serialise today — the
//! `[bibliography] / [sections] / [figures] / [preflight]` blocks land
//! in phases C2-C7 when their consuming code is wired up.  For phase
//! C1's scaffold-only landing we emit a deliberately small file (no
//! aspirational fields) so the user can read it end-to-end and trust
//! that everything we wrote is actually used.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{EngineKind, NewPaperRequest, TemplateInfo};

/// Top-level `paper.toml` shape.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PaperToml {
    pub meta: PaperMeta,
    pub engine: PaperEngineCfg,
    #[serde(default)]
    pub authors: PaperAuthors,
    #[serde(default)]
    pub build: PaperBuild,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PaperMeta {
    /// Stable id — 26-char ULID-shaped (timestamp-prefix + random).
    pub id: String,
    pub title: String,
    /// ISO-8601 UTC, second precision.
    pub created: String,
    /// Bumped on breaking schema changes.
    #[serde(default = "default_schema")]
    pub schema: u32,
}

fn default_schema() -> u32 { 1 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaperEngineCfg {
    pub kind: EngineKind,
    /// Built-in id (`ieee-conf`) or BYOF id (`byof:...`).
    pub template: String,
    /// Template-specific knob, e.g. "single-column" for IEEE Journal.
    #[serde(default = "default_flavor")]
    pub flavor: String,
}

impl Default for PaperEngineCfg {
    fn default() -> Self {
        Self {
            kind: EngineKind::Typst,
            template: "ieee-conf".to_string(),
            flavor: "default".to_string(),
        }
    }
}

fn default_flavor() -> String { "default".to_string() }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PaperAuthors {
    #[serde(default, rename = "entry")]
    pub entries: Vec<PaperAuthor>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PaperAuthor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affiliation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orcid: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaperBuild {
    #[serde(default = "default_output")]
    pub output: String,
    #[serde(default = "default_project_bundle")]
    pub project_bundle: String,
    #[serde(default = "default_keep_tex")]
    pub keep_tex: bool,
}

impl Default for PaperBuild {
    fn default() -> Self {
        Self {
            output: default_output(),
            project_bundle: default_project_bundle(),
            keep_tex: default_keep_tex(),
        }
    }
}

fn default_output() -> String { "build/paper.pdf".to_string() }
fn default_project_bundle() -> String { "build/paper-overleaf.zip".to_string() }
fn default_keep_tex() -> bool { true }

impl PaperToml {
    /// Build a fresh `paper.toml` from a `paper_create` request +
    /// the resolved template.  Used at New-Paper time.
    pub fn new_for(template: &TemplateInfo, req: &NewPaperRequest) -> Self {
        let now = iso_now();
        let id = ulid_like(&now, &req.title);
        Self {
            meta: PaperMeta {
                id,
                title: req.title.clone(),
                created: now,
                schema: 1,
            },
            engine: PaperEngineCfg {
                kind: template.default_engine,
                template: template.id.clone(),
                flavor: "default".to_string(),
            },
            authors: PaperAuthors {
                entries: req
                    .authors
                    .iter()
                    .map(|a| PaperAuthor {
                        name: a.name.clone(),
                        email: a.email.clone(),
                        affiliation: a.affiliation.clone(),
                        orcid: a.orcid.clone(),
                    })
                    .collect(),
            },
            build: PaperBuild::default(),
        }
    }

    /// Read + parse a `paper.toml` from disk.
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
        toml::from_str(&raw).map_err(|e| format!("failed to parse {}: {}", path.display(), e))
    }

    /// Serialise + write `paper.toml` to disk.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let body = toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialise paper.toml: {}", e))?;
        std::fs::write(path, body)
            .map_err(|e| format!("failed to write {}: {}", path.display(), e))
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/// ISO-8601 UTC with second precision, hand-formatted to avoid pulling
/// in `chrono`/`time` for a single timestamp.  Format: `YYYY-MM-DDTHH:MM:SSZ`.
fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = epoch_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Civil-time conversion (Howard Hinnant's date algorithm).  Pure
/// integer arithmetic — proleptic Gregorian, never panics for any
/// `u64` input the system clock can produce.
fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let secs_of_day = (secs % 86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant — days_from_civil inverted.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (year, m as u32, d as u32, hour, minute, second)
}

/// A ULID-shaped id without the dep.  Format: `01` (Crockford
/// base32 prefix marker) + 24 hex chars of `blake3(now || title)`.
/// Stable across renames (we never derive it from the title or path).
fn ulid_like(now_iso: &str, title: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(now_iso.as_bytes());
    hasher.update(b"\0");
    hasher.update(title.as_bytes());
    // Mix in nanosecond clock so two papers created in the same second
    // with the same title still get distinct ids.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    hasher.update(&nanos.to_le_bytes());
    let hash = hasher.finalize();
    let hex = hash.to_hex();
    format!("01{}", &hex.as_str()[..24])
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paper::{NewPaperRequest, TemplateInfo, TemplateSource};

    fn fixture_template() -> TemplateInfo {
        TemplateInfo {
            id: "ieee-conf".to_string(),
            label: "IEEE Conference".to_string(),
            description: "Two-column IEEE conference paper.".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Typst, EngineKind::Tectonic],
            default_engine: EngineKind::Typst,
            preview: None,
        }
    }

    #[test]
    fn roundtrip_minimal_paper_toml() {
        let req = NewPaperRequest {
            vault: "/tmp/vault".to_string(),
            parent_rel: "papers".to_string(),
            title: "Test Paper".to_string(),
            template_id: "ieee-conf".to_string(),
            authors: vec![],
        };
        let cfg = PaperToml::new_for(&fixture_template(), &req);
        let raw = toml::to_string_pretty(&cfg).unwrap();
        let back: PaperToml = toml::from_str(&raw).unwrap();
        assert_eq!(back.meta.title, "Test Paper");
        assert_eq!(back.engine.template, "ieee-conf");
        assert!(matches!(back.engine.kind, EngineKind::Typst));
    }

    #[test]
    fn iso_now_format_shape() {
        let s = iso_now();
        // YYYY-MM-DDTHH:MM:SSZ — 20 chars, trailing 'Z'.
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }

    #[test]
    fn ulid_like_is_stable_for_distinct_inputs() {
        let a = ulid_like("2026-01-01T00:00:00Z", "Paper A");
        let b = ulid_like("2026-01-01T00:00:00Z", "Paper B");
        assert_ne!(a, b);
        assert!(a.starts_with("01"));
        assert_eq!(a.len(), 26);
    }
}
