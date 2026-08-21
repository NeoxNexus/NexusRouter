import type { HeuristicContext, ClassificationResult } from "../ollama/client.js";

/**
 * 分类层（Layer 2）后端抽象。任何能对 (prompt, context) 给出 tier 的服务
 * 都满足该接口：本地 Ollama（OllamaClient，/api/generate）与 OpenAI 兼容
 * 网关（OpenAICompatClassifier，/chat/completions，new-api / vLLM）皆然。
 * 靠 structural typing 匹配，OllamaClient 无需改动即天然满足。
 */
export interface AiClassifier {
  classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult>;
  healthCheck?(): Promise<boolean>;
}
