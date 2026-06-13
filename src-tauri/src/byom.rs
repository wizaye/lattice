//! BYOM (Bring Your Own Model) - Unified AI provider interface
//!
//! Supports multiple AI providers:
//! - Ollama (local)
//! - OpenAI
//! - Anthropic
//! - Azure OpenAI
//! - Hugging Face

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelProvider {
    Ollama,
    OpenAI,
    Anthropic,
    Gemini,
    AzureOpenAI,
    HuggingFace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub provider: ModelProvider,
    pub model_name: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub parameters: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system", "user", "assistant"
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<usize>,
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    pub finish_reason: Option<String>,
}

// ── Ollama Provider ─────────────────────────────────────────────────────

pub struct OllamaProvider {
    base_url: String,
}

impl OllamaProvider {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url: base_url.unwrap_or_else(|| "http://localhost:11434".to_string()),
        }
    }

    pub async fn is_available(&self) -> bool {
        // Check if Ollama is running
        let url = format!("{}/api/tags", self.base_url);
        match reqwest::get(&url).await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/api/tags", self.base_url);
        let resp = reqwest::get(&url)
            .await
            .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Ollama returned status {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct TagsResponse {
            models: Vec<ModelInfo>,
        }

        #[derive(Deserialize)]
        struct ModelInfo {
            name: String,
        }

        let data: TagsResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(data.models.into_iter().map(|m| m.name).collect())
    }

    pub async fn chat(&self, config: &ModelConfig, request: ChatRequest) -> Result<ChatResponse, String> {
        let url = format!("{}/api/chat", self.base_url);

        #[derive(Serialize)]
        struct OllamaChatRequest {
            model: String,
            messages: Vec<OllamaMessage>,
            stream: bool,
            options: Option<HashMap<String, serde_json::Value>>,
        }

        #[derive(Serialize)]
        struct OllamaMessage {
            role: String,
            content: String,
        }

        let messages: Vec<OllamaMessage> = request
            .messages
            .into_iter()
            .map(|m| OllamaMessage {
                role: m.role,
                content: m.content,
            })
            .collect();

        let mut options = HashMap::new();
        if let Some(temp) = request.temperature {
            options.insert("temperature".to_string(), serde_json::json!(temp));
        }
        if let Some(max_tokens) = request.max_tokens {
            options.insert("num_predict".to_string(), serde_json::json!(max_tokens));
        }

        let ollama_request = OllamaChatRequest {
            model: config.model_name.clone(),
            messages,
            stream: false,
            options: Some(options),
        };

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&ollama_request)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Ollama returned status {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct OllamaChatResponse {
            message: OllamaMessageResponse,
        }

        #[derive(Deserialize)]
        struct OllamaMessageResponse {
            content: String,
        }

        let data: OllamaChatResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(ChatResponse {
            content: data.message.content,
            model: config.model_name.clone(),
            finish_reason: Some("stop".to_string()),
        })
    }
}

// ── OpenAI Provider (full implementation) ───────────────────────────────

pub struct OpenAIProvider {
    api_key: String,
    base_url: String,
}

impl OpenAIProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            base_url: "https://api.openai.com/v1".to_string(),
        }
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        Self { api_key, base_url }
    }

    pub async fn chat(&self, config: &ModelConfig, request: ChatRequest) -> Result<ChatResponse, String> {
        use reqwest::Client;
        use serde_json::json;

        let client = Client::new();
        let url = format!("{}/chat/completions", self.base_url);

        // Convert our ChatRequest messages to OpenAI format
        let messages: Vec<serde_json::Value> = request
            .messages
            .iter()
            .map(|msg| {
                json!({
                    "role": msg.role,
                    "content": msg.content
                })
            })
            .collect();

        let mut body = json!({
            "model": config.model_name,
            "messages": messages,
        });

        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenAI HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("OpenAI API error {}: {}", status, error_text));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;

        // Extract the assistant's message
        let content = result["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| "No content in OpenAI response".to_string())?
            .to_string();

        Ok(ChatResponse {
            content,
            model: config.model_name.clone(),
            finish_reason: Some("stop".to_string()),
        })
    }
}

// ── Anthropic Provider (full implementation) ────────────────────────────

pub struct AnthropicProvider {
    api_key: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    pub async fn chat(&self, config: &ModelConfig, request: ChatRequest) -> Result<ChatResponse, String> {
        use reqwest::Client;
        use serde_json::json;

        let client = Client::new();
        let url = "https://api.anthropic.com/v1/messages";

        // Anthropic requires system messages to be separated
        let mut system_message = String::new();
        let mut messages: Vec<serde_json::Value> = Vec::new();

        for msg in &request.messages {
            if msg.role == "system" {
                if !system_message.is_empty() {
                    system_message.push_str("\n\n");
                }
                system_message.push_str(&msg.content);
            } else {
                messages.push(json!({
                    "role": msg.role,
                    "content": msg.content
                }));
            }
        }

        let mut body = json!({
            "model": config.model_name,
            "messages": messages,
            "max_tokens": request.max_tokens.unwrap_or(4096),
        });

        if !system_message.is_empty() {
            body["system"] = json!(system_message);
        }

        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }

        let response = client
            .post(url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Anthropic HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Anthropic API error {}: {}", status, error_text));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Anthropic response: {}", e))?;

        // Extract the assistant's message
        let content = result["content"][0]["text"]
            .as_str()
            .ok_or_else(|| "No content in Anthropic response".to_string())?
            .to_string();

        Ok(ChatResponse {
            content,
            model: config.model_name.clone(),
            finish_reason: Some("end_turn".to_string()),
        })
    }
}

// ── Google Gemini Provider (full implementation) ───────────────────────────

pub struct GeminiProvider {
    api_key: String,
}

impl GeminiProvider {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    pub async fn chat(&self, config: &ModelConfig, request: ChatRequest) -> Result<ChatResponse, String> {
        use reqwest::Client;
        use serde_json::json;

        let client = Client::new();
        // Google Gemini API endpoint
        let model = &config.model_name; // e.g. "gemini-1.5-pro" or "gemini-1.5-flash"
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, self.api_key
        );

        // Convert messages to Gemini format
        // Gemini uses "contents" array with "role" (user/model) and "parts" (array of text)
        let mut contents: Vec<serde_json::Value> = Vec::new();
        let mut system_instruction: Option<String> = None;

        for msg in &request.messages {
            if msg.role == "system" {
                // Gemini handles system messages separately as systemInstruction
                system_instruction = Some(msg.content.clone());
            } else {
                let gemini_role = if msg.role == "assistant" { "model" } else { "user" };
                contents.push(json!({
                    "role": gemini_role,
                    "parts": [{ "text": msg.content }]
                }));
            }
        }

        let mut body = json!({
            "contents": contents,
        });

        if let Some(sys) = system_instruction {
            body["systemInstruction"] = json!({
                "parts": [{ "text": sys }]
            });
        }

        // Gemini uses generationConfig for parameters
        let mut gen_config = json!({});
        if let Some(temp) = request.temperature {
            gen_config["temperature"] = json!(temp);
        }
        if let Some(max_tokens) = request.max_tokens {
            gen_config["maxOutputTokens"] = json!(max_tokens);
        }
        if !gen_config.as_object().unwrap().is_empty() {
            body["generationConfig"] = gen_config;
        }

        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Gemini API error {}: {}", status, error_text));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gemini response: {}", e))?;

        // Extract content from candidates[0].content.parts[0].text
        let content = result["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| "No content in Gemini response".to_string())?
            .to_string();

        let finish_reason = result["candidates"][0]["finishReason"]
            .as_str()
            .map(|s| s.to_string());

        Ok(ChatResponse {
            content,
            model: config.model_name.clone(),
            finish_reason,
        })
    }
}

// ── Azure OpenAI Provider (full implementation) ─────────────────────────────

pub struct AzureOpenAIProvider {
    api_key: String,
    endpoint: String, // e.g., "https://YOUR_RESOURCE.openai.azure.com/"
    deployment: String, // deployment name
}

impl AzureOpenAIProvider {
    pub fn new(api_key: String, endpoint: String, deployment: String) -> Self {
        Self {
            api_key,
            endpoint,
            deployment,
        }
    }

    pub async fn chat(&self, config: &ModelConfig, request: ChatRequest) -> Result<ChatResponse, String> {
        use reqwest::Client;
        use serde_json::json;

        let client = Client::new();
        // Azure OpenAI uses a different URL structure with api-version query param
        let url = format!(
            "{}/openai/deployments/{}/chat/completions?api-version=2024-02-01",
            self.endpoint.trim_end_matches('/'),
            self.deployment
        );

        // Message format is same as OpenAI
        let messages: Vec<serde_json::Value> = request
            .messages
            .iter()
            .map(|msg| {
                json!({
                    "role": msg.role,
                    "content": msg.content
                })
            })
            .collect();

        let mut body = json!({
            "messages": messages,
        });

        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }

        let response = client
            .post(&url)
            .header("api-key", &self.api_key) // Azure uses "api-key" header, not Bearer
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Azure OpenAI HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Azure OpenAI API error {}: {}", status, error_text));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Azure OpenAI response: {}", e))?;

        let content = result["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| "No content in Azure OpenAI response".to_string())?
            .to_string();

        Ok(ChatResponse {
            content,
            model: format!("{} ({})", self.deployment, config.model_name),
            finish_reason: Some("stop".to_string()),
        })
    }
}

// ── Unified Model Manager ───────────────────────────────────────────────

pub struct ModelManager {
    configs: HashMap<String, ModelConfig>,
    default_model: Option<String>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            configs: HashMap::new(),
            default_model: None,
        }
    }

    pub fn add_model(&mut self, name: String, config: ModelConfig) {
        if self.default_model.is_none() {
            self.default_model = Some(name.clone());
        }
        self.configs.insert(name, config);
    }

    pub fn set_default(&mut self, name: String) {
        if self.configs.contains_key(&name) {
            self.default_model = Some(name);
        }
    }

    pub async fn chat(&self, model_name: Option<String>, request: ChatRequest) -> Result<ChatResponse, String> {
        let name = model_name
            .or_else(|| self.default_model.clone())
            .ok_or_else(|| "No model specified and no default model set".to_string())?;

        let config = self
            .configs
            .get(&name)
            .ok_or_else(|| format!("Model '{}' not found", name))?;

        match config.provider {
            ModelProvider::Ollama => {
                let provider = OllamaProvider::new(config.base_url.clone());
                provider.chat(config, request).await
            }
            ModelProvider::OpenAI => {
                let api_key = config
                    .api_key
                    .clone()
                    .ok_or_else(|| "OpenAI requires api_key".to_string())?;
                let provider = OpenAIProvider::new(api_key);
                provider.chat(config, request).await
            }
            ModelProvider::Anthropic => {
                let api_key = config
                    .api_key
                    .clone()
                    .ok_or_else(|| "Anthropic requires api_key".to_string())?;
                let provider = AnthropicProvider::new(api_key);
                provider.chat(config, request).await
            }
            ModelProvider::Gemini => {
                let api_key = config
                    .api_key
                    .clone()
                    .ok_or_else(|| "Gemini requires api_key".to_string())?;
                let provider = GeminiProvider::new(api_key);
                provider.chat(config, request).await
            }
            ModelProvider::AzureOpenAI => {
                let api_key = config
                    .api_key
                    .clone()
                    .ok_or_else(|| "Azure OpenAI requires api_key".to_string())?;
                
                // Azure requires endpoint and deployment in parameters
                let endpoint = config
                    .parameters
                    .get("endpoint")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Azure OpenAI requires 'endpoint' parameter".to_string())?
                    .to_string();
                
                let deployment = config
                    .parameters
                    .get("deployment")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Azure OpenAI requires 'deployment' parameter".to_string())?
                    .to_string();
                
                let provider = AzureOpenAIProvider::new(api_key, endpoint, deployment);
                provider.chat(config, request).await
            }
            ModelProvider::HuggingFace => {
                Err("HuggingFace provider not yet implemented".to_string())
            }
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn byom_check_ollama_available() -> Result<bool, String> {
    let provider = OllamaProvider::new(None);
    Ok(provider.is_available().await)
}

#[tauri::command]
pub async fn byom_list_ollama_models() -> Result<Vec<String>, String> {
    let provider = OllamaProvider::new(None);
    provider.list_models().await
}

#[tauri::command]
pub async fn byom_chat(
    model_name: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<usize>,
) -> Result<ChatResponse, String> {
    // For now, assume Ollama provider
    let config = ModelConfig {
        provider: ModelProvider::Ollama,
        model_name: model_name.clone(),
        api_key: None,
        base_url: None,
        parameters: HashMap::new(),
    };

    let request = ChatRequest {
        messages,
        temperature,
        max_tokens,
        stream: false,
    };

    let provider = OllamaProvider::new(None);
    provider.chat(&config, request).await
}
