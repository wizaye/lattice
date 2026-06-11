use serde_json::{json, Value};
use std::sync::Arc;
use lattice_vault::{Vault, NoteFolder};

pub async fn vault_info(vault: Arc<Vault>) -> Result<Value, String> {
    let settings = vault.get_settings().await;
    let notes = vault.list_notes().await.map_err(|e| e.to_string())?;
    Ok(json!({"total_notes": notes.len()}))
}

pub fn get_tool_definitions() -> Vec<Value> {
    vec![json!({"name": "vault_info"})]
}
