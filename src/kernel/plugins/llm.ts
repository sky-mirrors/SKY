import type { LLMPort } from '../types'

let _llmPort: LLMPort | null = null

export function registerLLM(port: LLMPort): void {
  _llmPort = port
}

export function getLLM(): LLMPort {
  if (!_llmPort) {
    throw new Error('[kernel] LLM plugin not registered. Call kernel.registerLLM() first.')
  }
  return _llmPort
}

export function hasLLM(): boolean {
  return _llmPort !== null
}

export function unregisterLLM(): void {
  _llmPort = null
}
