import type { IOPort } from '../types'

type ElectronAPIRef = typeof window.electronAPI

export const electronIOPort: IOPort = {
  async storeRead(key: string): Promise<string | null> {
    const v = await window.electronAPI?.storeRead(key)
    return typeof v === 'string' ? v : null
  },
  async storeWrite(key: string, value: string): Promise<void> {
    await window.electronAPI?.storeWrite(key, value)
  },
  async storeDelete(key: string): Promise<void> {
    await window.electronAPI?.storeDelete(key)
  },
  async vectorWriteBin(key: string, base64Data: string): Promise<boolean> {
    return window.electronAPI?.vectorWriteBin(key, base64Data) ?? false
  },
  async vectorReadBin(key: string): Promise<ArrayBuffer | Uint8Array | null> {
    return window.electronAPI?.vectorReadBin(key) ?? null
  },
  async vectorListKeys(): Promise<string[]> {
    return window.electronAPI?.vectorListKeys() ?? []
  },
  async shellExec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const r = await window.electronAPI?.shellExec({ command, cwd })
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', code: r?.code ?? -1 }
  },
  async fileWrite(path: string, content: string): Promise<boolean> {
    const r = await window.electronAPI?.fileWrite({ filePath: path, content })
    return r?.success ?? false
  },
  async fileRead(path: string): Promise<string | null> {
    const r = await window.electronAPI?.fileRead(path)
    return r?.success && typeof r.content === 'string' ? r.content : null
  },
  async createDirectory(path: string): Promise<boolean> {
    const r = await window.electronAPI?.createDirectory(path)
    return r?.success ?? false
  },
  async createDocx(path: string, content: string): Promise<boolean> {
    const r = await window.electronAPI?.createDocx({ filePath: path, content })
    return r?.success ?? false
  },
  async httpFetch(url: string, options: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const r = await window.electronAPI?.httpFetch({
      url,
      method: typeof options.method === 'string' ? options.method : undefined,
      headers: typeof options.headers === 'object' && options.headers !== null
        ? options.headers as Record<string, string>
        : undefined,
      body: typeof options.body === 'string' ? options.body : undefined,
      timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
    })
    return { status: r?.status ?? 0, body: r?.body ?? '' }
  },
  async mcpSpawn(id: string, config: unknown): Promise<boolean> {
    const c = config as { command: string; args: string[]; env: Record<string, string> }
    const r = await window.electronAPI?.mcpSpawn({ id, command: c.command, args: c.args, env: c.env })
    return r?.success ?? false
  },
  async mcpStop(id: string): Promise<void> {
    await window.electronAPI?.mcpStop({ id })
  },
  async mcpListTools(id: string): Promise<Array<{ name: string; description: string }>> {
    const r = await window.electronAPI?.mcpListTools({ id })
    return r?.tools?.map(t => ({ name: t.name, description: t.description })) ?? []
  },
  async mcpCallTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await window.electronAPI?.mcpCallTool({ id, toolName, args })
    return r?.success ? (r.result ?? null) : null
  },
  async llmChatCompletion(params: unknown): Promise<unknown> {
    return window.electronAPI?.llmChatCompletion(params as Parameters<ElectronAPIRef['llmChatCompletion']>[0])
  },
  async llmChatCompletionStream(
    params: unknown,
    callbacks?: { onChunk: (chunk: unknown) => void; onDone: (final: unknown) => void; onError: (err: string) => void }
  ): Promise<unknown> {
    const cbs = callbacks ?? { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    return window.electronAPI?.llmChatCompletionStream(
      params as Parameters<ElectronAPIRef['llmChatCompletionStream']>[0],
      cbs as Parameters<ElectronAPIRef['llmChatCompletionStream']>[1],
    )
  },
  async llmListModels(params: unknown): Promise<unknown> {
    return window.electronAPI?.llmListModels(params as Parameters<ElectronAPIRef['llmListModels']>[0])
  },
  async safeStorageEncrypt(value: string): Promise<string> {
    return (await window.electronAPI?.safeStorageEncrypt(value)) ?? ''
  },
  async safeStorageDecrypt(value: string): Promise<string> {
    return (await window.electronAPI?.safeStorageDecrypt(value)) ?? ''
  },
  async openFile(options?: unknown): Promise<string | null> {
    const r = await window.electronAPI?.openFile(options as Parameters<ElectronAPIRef['openFile']>[0])
    return !r || r.canceled || !r.filePaths?.length ? null : r.filePaths[0]
  },
  async openDirectory(options?: unknown): Promise<string | null> {
    const r = await window.electronAPI?.openDirectory(options as Parameters<ElectronAPIRef['openDirectory']>[0])
    return !r || r.canceled || !r.filePaths?.length ? null : r.filePaths[0]
  },
  async backupCreate(): Promise<string> {
    const r = await window.electronAPI?.backupCreate()
    return r?.path ?? ''
  },
  async backupRestore(zipPath: string): Promise<boolean> {
    void zipPath
    const r = await window.electronAPI?.backupRestore()
    return r?.success ?? false
  },
  async knowledgeIngest(params: unknown): Promise<unknown> {
    return window.electronAPI?.knowledgeIngest(params as Parameters<ElectronAPIRef['knowledgeIngest']>[0])
  },
  async knowledgeSearch(params: unknown): Promise<unknown> {
    return window.electronAPI?.knowledgeSearch(params as Parameters<ElectronAPIRef['knowledgeSearch']>[0])
  },
  async watchfsSetDir(dir: string): Promise<void> {
    await window.electronAPI?.watchfsSetDir(dir)
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
