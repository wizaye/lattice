use regex::Regex;
use lazy_static::lazy_static;
use std::collections::HashMap;
use crate::error::Result;
use crate::types::Task;

lazy_static! {
    /// Matches wikilinks: [[Note]] or [[Note|alias]] or ![[embed]]
    static ref WIKILINK_RE: Regex = Regex::new(r"(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]").unwrap();
    
    /// Matches embeds specifically: ![[image.png]]
    static ref EMBED_RE: Regex = Regex::new(r"!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]").unwrap();
    
    /// Matches tags: #tag or #nested/tag
    static ref TAG_RE: Regex = Regex::new(r"(?:^|\s)#([A-Za-z][\w\-/]*)").unwrap();
    
    /// Matches YAML frontmatter block
    static ref FRONTMATTER_RE: Regex = Regex::new(r"(?s)\A---\n(.*?)\n---\n?").unwrap();
    
    /// Matches task lines: - [ ] task or - [x] task
    static ref TASK_LINE_RE: Regex = Regex::new(r"^\s*-\s+\[(.)\]\s+(.*)$").unwrap();
    
    /// Matches inline due dates: due:2024-12-31
    static ref INLINE_DUE_RE: Regex = Regex::new(r"due:(\S+)").unwrap();
    
    /// Matches inline priorities: !high !med !low !h !m !l
    static ref INLINE_PRI_RE: Regex = Regex::new(r"!(high|med|medium|low|h|m|l)").unwrap();
    
    /// Matches fenced code blocks to skip
    static ref FENCED_BLOCK_RE: Regex = Regex::new(r"(?s)```[\s\S]*?```").unwrap();
}

/// Extract all wikilinks from markdown content (skips fenced code blocks)
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    let without_fenced = remove_fenced_blocks(content);
    
    WIKILINK_RE
        .captures_iter(&without_fenced)
        .filter_map(|cap| {
            // cap[1] is "!" for embeds, cap[2] is the link text
            let is_embed = &cap[1] == "!";
            if !is_embed {
                Some(cap[2].trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Extract all embeds from markdown content
pub fn extract_embeds(content: &str) -> Vec<String> {
    let without_fenced = remove_fenced_blocks(content);
    
    EMBED_RE
        .captures_iter(&without_fenced)
        .map(|cap| cap[1].trim().to_string())
        .collect()
}

/// Extract all tags from markdown content
pub fn extract_tags(content: &str) -> Vec<String> {
    let without_fenced = remove_fenced_blocks(content);
    
    TAG_RE
        .captures_iter(&without_fenced)
        .map(|cap| format!("#{}", &cap[1]))
        .collect()
}

/// Extract YAML frontmatter as JSON object
pub fn extract_frontmatter(content: &str) -> Result<HashMap<String, serde_json::Value>> {
    if let Some(cap) = FRONTMATTER_RE.captures(content) {
        let yaml_str = &cap[1];
        
        // Simple YAML to JSON conversion for common cases
        // For production, use serde_yaml crate
        let mut result = HashMap::new();
        
        for line in yaml_str.lines() {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim().to_string();
                let value = value.trim();
                
                // Try to parse as JSON value
                let json_value = if value == "true" || value == "false" {
                    serde_json::Value::Bool(value == "true")
                } else if let Ok(num) = value.parse::<i64>() {
                    serde_json::Value::Number(num.into())
                } else {
                    serde_json::Value::String(value.to_string())
                };
                
                result.insert(key, json_value);
            }
        }
        
        Ok(result)
    } else {
        Ok(HashMap::new())
    }
}

/// Extract all tasks from markdown content
pub fn extract_tasks(content: &str, note_path: &str) -> Vec<Task> {
    let without_fenced = remove_fenced_blocks(content);
    let mut tasks = Vec::new();
    
    for (line_num, line) in without_fenced.lines().enumerate() {
        if let Some(cap) = TASK_LINE_RE.captures(line) {
            let check_char = &cap[1];
            let task_text = cap[2].trim().to_string();
            
            // Extract priority
            let priority = INLINE_PRI_RE.captures(&task_text).and_then(|cap| {
                match &cap[1] {
                    "high" | "h" => Some("high".to_string()),
                    "med" | "medium" | "m" => Some("medium".to_string()),
                    "low" | "l" => Some("low".to_string()),
                    _ => None,
                }
            });
            
            // Extract due date
            let due = INLINE_DUE_RE.captures(&task_text)
                .map(|cap| cap[1].to_string());
            
            tasks.push(Task {
                id: format!("{}:{}", note_path, line_num + 1),
                note_path: note_path.to_string(),
                line_number: line_num + 1,
                text: task_text,
                checked: check_char == "x" || check_char == "X",
                priority,
                due,
            });
        }
    }
    
    tasks
}

/// Remove fenced code blocks from content
fn remove_fenced_blocks(content: &str) -> String {
    FENCED_BLOCK_RE.replace_all(content, "").to_string()
}

/// Count words in content (excludes frontmatter and code blocks)
pub fn count_words(content: &str) -> usize {
    let without_frontmatter = FRONTMATTER_RE.replace(content, "");
    let without_fenced = remove_fenced_blocks(&without_frontmatter);
    
    without_fenced
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_wikilinks() {
        let content = "See [[Note 1]] and [[Note 2|alias]] but not ![[embed.png]]";
        let links = extract_wikilinks(content);
        assert_eq!(links, vec!["Note 1", "Note 2"]);
    }

    #[test]
    fn test_extract_embeds() {
        let content = "Here is ![[image.png]] and ![[diagram.svg]]";
        let embeds = extract_embeds(content);
        assert_eq!(embeds, vec!["image.png", "diagram.svg"]);
    }

    #[test]
    fn test_extract_tags() {
        let content = "This has #tag1 and #nested/tag2";
        let tags = extract_tags(content);
        assert_eq!(tags, vec!["#tag1", "#nested/tag2"]);
    }

    #[test]
    fn test_extract_tasks() {
        let content = "- [ ] Todo item !high due:2024-12-31\n- [x] Done item";
        let tasks = extract_tasks(content, "test.md");
        assert_eq!(tasks.len(), 2);
        assert!(!tasks[0].checked);
        assert_eq!(tasks[0].priority, Some("high".to_string()));
        assert_eq!(tasks[0].due, Some("2024-12-31".to_string()));
        assert!(tasks[1].checked);
    }

    #[test]
    fn test_skip_fenced_blocks() {
        let content = "# Header\n[[link1]]\n```\n[[not_a_link]]\n```\n[[link2]]";
        let links = extract_wikilinks(content);
        assert_eq!(links, vec!["link1", "link2"]);
    }

    #[test]
    fn test_count_words() {
        let content = "---\ntitle: Test\n---\nThis is a test with seven words.";
        assert_eq!(count_words(content), 7);
    }
}
