import { ChatMessage, MemoryAdapter } from '@/models'
import { useMemoryStore } from '@/stores/memoryStore'

function getStore() {
  return useMemoryStore()
}

export function getConversations() {
  return getStore().conversations
}

export function getOrCreateConversation(projectId: string) {
  return getStore().getOrCreateConversation(projectId)
}

export function addMessage(projectId: string, message: ChatMessage): void {
  getStore().addConvMessage(projectId, message)
}

export function addFileFingerprint(projectId: string, fingerprint: string): void {
  getStore().addConvFileFingerprint(projectId, fingerprint)
}

export function getRecentMessages(projectId: string, limit: number = 20): ChatMessage[] {
  return getStore().getRecentMessages(projectId, limit)
}

export function getContextWindow(projectId: string, tokenBudget: number = 4000): { messages: ChatMessage[]; summary: string } {
  return getStore().getContextWindow(projectId, tokenBudget)
}

export function summarizeOld(projectId: string, tokenBudget: number = 4000): string {
  return getStore().summarizeOld(projectId, tokenBudget)
}

export const memoryAdapter: MemoryAdapter = {
  getRecent(projectId, tokenBudget) {
    return getStore().memoryAdapter.getRecent(projectId, tokenBudget)
  },
  addMessage(projectId, role, content) {
    getStore().memoryAdapter.addMessage(projectId, role, content)
  },
  summarizeOld(projectId, tokenBudget) {
    return getStore().memoryAdapter.summarizeOld(projectId, tokenBudget)
  }
}
