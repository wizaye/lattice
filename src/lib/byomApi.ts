/**
 * BYOM (Bring Your Own Model) - TypeScript API
 * 
 * Client-side interface for AI model providers
 */

import { invoke } from '@tauri-apps/api/core';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  finishReason?: string;
}

/**
 * Check if Ollama is running locally
 */
export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('byom_check_ollama_available');
  } catch (error) {
    console.error('Failed to check Ollama availability:', error);
    return false;
  }
}

/**
 * List available Ollama models
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    return await invoke<string[]>('byom_list_ollama_models');
  } catch (error) {
    console.error('Failed to list Ollama models:', error);
    return [];
  }
}

/**
 * Send chat request to model
 */
export async function chat(
  modelName: string,
  messages: ChatMessage[],
  options?: {
    temperature?: number;
    maxTokens?: number;
  }
): Promise<ChatResponse> {
  return await invoke<ChatResponse>('byom_chat', {
    modelName,
    messages,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
  });
}

/**
 * Quick helper for single-prompt generation
 */
export async function generate(
  modelName: string,
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  const messages: ChatMessage[] = [];
  
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  
  messages.push({ role: 'user', content: prompt });
  
  const response = await chat(modelName, messages);
  return response.content;
}

/**
 * Generate commit message using AI
 */
export async function generateCommitMessage(
  vaultPath: string,
  useAi: boolean = true
): Promise<{ message: string; aiGenerated: boolean }> {
  return await invoke('vcs_generate_commit_message', {
    vaultPath,
    useAi,
  });
}
