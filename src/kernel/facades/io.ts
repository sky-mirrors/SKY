import type { IOPort } from '../types'

export const electronIOPort: IOPort = {
  async storeRead(key: string): Promise<string | null> {
    return window.electronAPI?.storeRead(key) ?? null
  },
  async storeWrite(key: string, value: string): Promise<void> {
    window.electronAPI?.storeWrite(key, value)
  },
  async storeDelete(key: string): Promise<void> {
    window.electronAPI?.storeDelete(key)
  },
  async vectorWriteBin(key: string, base64Data: string): Promise<boolean> {
    return window.electronAPI?.vectorWriteBin(key, base64Data) ?? false
  },
  async vectorReadBin(key: string): Promise<string | null> {
    return window.electronAPI?.vectorReadBin(key) ?? null
  },
  async vectorListKeys(): Promise<string[]> {
    return window.electronAPI?.vectorListKeys() ?? []
  },
  async shellExec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return window.electronAPI?.shellExec(command, cwd)
  },
  async fileWrite(path: string, content: string): Promise<boolean> {
    return window.electronAPI?.fileWrite(path, content)
  },
  async fileRead(path: string): Promise<string | null> {
    return window.electronAPI?.fileRead(path)
  },
  async createDirectory(path: string): Promise<boolean> {
    return window.electronAPI?.createDirectory(path)
  },
  async createDocx(path: string, content: string): Promise<boolean> {
    return window.electronAPI?.createDocx(path, content)
  },
  async httpFetch(url: string, options: Record<string, unknown>): Promise<{ status: number; body: string }> {
    return window.electronAPI?.httpFetch(url, options)
  },
  async mcpSpawn(id: string, config: unknown): Promise<boolean> {
    return window.electronAPI?.mcpSpawn(id, config)
  },
  async mcpStop(id: string): Promise<void> {
    window.electronAPI?.mcpStop(id)
  },
  async mcpListTools(id: string): Promise<Array<{ name: string; description: string }>> {
    return window.electronAPI?.mcpListTools(id)
  },
  async mcpCallTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return window.electronAPI?.mcpCallTool(id, toolName, args)
  },
  async llmChatCompletion(params: unknown): Promise<unknown> {
    return window.electronAPI?.llmChatCompletion(params)
  },
  async llmChatCompletionStream(params: unknown): Promise<unknown> {
    return window.electronAPI?.llmChatCompletionStream(params)
  },
  async llmListModels(params: unknown): Promise<unknown> {
    return window.electronAPI?.llmListModels(params)
  },
  async safeStorageEncrypt(value: string): Promise<string> {
    return window.electronAPI?.safeStorageEncrypt(value)
  },
  async safeStorageDecrypt(value: string): Promise<string> {
    return window.electronAPI?.safeStorageDecrypt(value)
  },
  async openFile(options?: unknown): Promise<string | null> {
    return window.electronAPI?.openFile(options)
  },
  async openDirectory(options?: unknown): Promise<string | null> {
    return window.electronAPI?.openDirectory(options)
  },
  async backupCreate(): Promise<string> {
    return window.electronAPI?.backupCreate()
  },
  async backupRestore(zipPath: string): Promise<boolean> {
    return window.electronAPI?.backupRestore(zipPath)
  },
  async knowledgeIngest(params: unknown): Promise<unknown> {
    return window.electronAPI?.knowledgeIngest(params)
  },
  async knowledgeSearch(params: unknown): Promise<unknown> {
    return window.electronAPI?.knowledgeSearch(params)
  },
  async watchfsSetDir(dir: string): Promise<void> {
    window.electronAPI?.watchfsSetDir(dir)
  },
  async watchfsGetDir(): Promise<string | null> {
    return window.electronAPI?.watchfsGetDir()
  },
  async getPlatform(): Promise<string> {
    return window.electronAPI?.getPlatform()
  },
  async getVersion(): Promise<string> {
    return window.electronAPI?.getVersion()
  },
  async getUserDataPath(): Promise<string> {
    return window.electronAPI?.getUserDataPath()
  },
}
