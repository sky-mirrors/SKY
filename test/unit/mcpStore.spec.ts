import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'

vi.mock('@/stores/memoryStore', () => ({
  useMemoryStore: () => ({
    addMcpRequestLog: vi.fn(),
    addAuditLog: vi.fn()
  })
}))

vi.mock('@/data/mcpCatalog', () => ({
  MCP_CATALOG: [
    { id: 'cat-fetch', name: 'Fetch', command: 'npx', args: ['mcp-fetch'], env: {}, description: 'HTTP fetch' }
  ]
}))

import { useMcpStore } from '@/stores/mcpStore'

function createStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return useMcpStore()
}

describe('mcpStore', () => {
  let store: ReturnType<typeof useMcpStore>

  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
        mcpSpawn: vi.fn().mockResolvedValue({ success: false }),
        mcpStop: vi.fn().mockResolvedValue(undefined),
        mcpListTools: vi.fn().mockResolvedValue([]),
        mcpCallTool: vi.fn().mockResolvedValue(null),
      }
    })
    store = createStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('addConnection', () => {
    it('adds a connection and saves', () => {
      const conn = store.addConnection('Test', 'http://localhost:3000/')
      expect(conn.name).toBe('Test')
      expect(conn.url).toBe('http://localhost:3000')
      expect(conn.isConnected).toBe(false)
      expect(store.connections.length).toBe(1)
    })

    it('strips trailing slashes from URL', () => {
      const conn = store.addConnection('Slash', 'http://host///')
      expect(conn.url).toBe('http://host')
    })
  })

  describe('removeConnection', () => {
    it('removes a connection', () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      store.removeConnection(conn.id)
      expect(store.connections.length).toBe(0)
    })
  })

  describe('isCatalogItemInstalled', () => {
    it('returns false for uninstalled item', () => {
      expect(store.isCatalogItemInstalled('cat-fetch')).toBe(false)
    })

    it('returns true after install', () => {
      store.addConnection('Fetch', '')
      store.connections[0].catalogId = 'cat-fetch'
      expect(store.isCatalogItemInstalled('cat-fetch')).toBe(true)
    })
  })

  describe('mcpToolsAsNodes', () => {
    it('reflects connected tools after loadFromStorage', async () => {
      const saved = [{
        id: 'mcp-1', name: 'Test', url: 'http://test', isConnected: false,
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: {}, isAutoAllowed: false, permission: 'execute' }],
        lastTestedAt: 0, isWhitelisted: false
      }]
      vault.writeCache('mcp', 'holo-mcp-connections', JSON.stringify(saved))
      await store.loadFromStorage()
      expect(store.connections[0].tools.length).toBe(1)
    })

    it('starts empty when no connections', () => {
      expect(store.mcpToolsAsNodes.length).toBe(0)
    })
  })

  describe('toggleToolAutoAllow', () => {
    it('toggles auto-allow on a tool', () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.tools = [{ name: 'tool1', description: '', inputSchema: {}, isAutoAllowed: false, permission: 'execute' }]
      store.toggleToolAutoAllow(conn.id, 'tool1')
      expect(conn.tools[0].isAutoAllowed).toBe(true)
      store.toggleToolAutoAllow(conn.id, 'tool1')
      expect(conn.tools[0].isAutoAllowed).toBe(false)
    })
  })

  describe('setToolPermission', () => {
    it('sets permission on a tool', () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.tools = [{ name: 'tool1', description: '', inputSchema: {}, isAutoAllowed: false, permission: 'execute' }]
      store.setToolPermission(conn.id, 'tool1', 'readonly')
      expect(conn.tools[0].permission).toBe('readonly')
    })
  })

  describe('setWhitelist', () => {
    it('sets whitelist on a connection', () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      store.setWhitelist(conn.id, true)
      expect(conn.isWhitelisted).toBe(true)
    })
  })

  describe('callTool', () => {
    it('throws when MCP not connected', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      await expect(store.callTool(conn.id, 'tool1')).rejects.toThrow('MCP not connected')
    })

    it('throws when tool not found', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.isConnected = true
      await expect(store.callTool(conn.id, 'nonexistent')).rejects.toThrow('not found')
    })

    it('throws when tool requires authorization', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.isConnected = true
      conn.tools = [{ name: 'secure_tool', description: '', inputSchema: {}, isAutoAllowed: false, permission: 'execute' }]
      await expect(store.callTool(conn.id, 'secure_tool')).rejects.toThrow('authorization')
    })

    it('throws when readonly tool used for write operation', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.isConnected = true
      conn.isWhitelisted = true
      conn.tools = [{ name: 'write_data', description: '', inputSchema: {}, isAutoAllowed: false, permission: 'readonly' }]
      await expect(store.callTool(conn.id, 'write_data')).rejects.toThrow('read-only')
    })

    it('throws when readwrite tool used for exec operation', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.isConnected = true
      conn.isWhitelisted = true
      conn.tools = [{ name: 'run_script', description: '', inputSchema: {}, isAutoAllowed: false, permission: 'readwrite' }]
      await expect(store.callTool(conn.id, 'run_script')).rejects.toThrow('execute operations not permitted')
    })

    it('calls tool via electronAPI for catalog connection', async () => {
      const conn = store.addConnection('Test', 'http://localhost:3000')
      conn.isConnected = true
      conn.isWhitelisted = true
      conn.catalogCommand = 'npx'
      conn.tools = [{ name: 'read_file', description: '', inputSchema: {}, isAutoAllowed: true, permission: 'execute' }]

      vi.stubGlobal('window', {
        electronAPI: {
          mcpCallTool: vi.fn().mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: 'file content' }] } }),
          mcpSpawn: vi.fn().mockResolvedValue({ success: false }),
          mcpStop: vi.fn().mockResolvedValue(undefined),
          mcpListTools: vi.fn().mockResolvedValue([]),
          vaultRead: vi.fn().mockResolvedValue(null),
          vaultWrite: vi.fn().mockResolvedValue(undefined),
          vaultDelete: vi.fn().mockResolvedValue(undefined),
          vaultList: vi.fn().mockResolvedValue([]),
        }
      })

      const result = await store.callTool(conn.id, 'read_file', {})
      expect(result).toBe('file content')
    })
  })

  describe('loadFromStorage', () => {
    it('loads connections from vault cache', async () => {
      const saved = [{ id: 'mcp-1', name: 'Saved', url: 'http://saved', isConnected: true, tools: [{ name: 't', description: '', inputSchema: {}, isAutoAllowed: false }], lastTestedAt: 0, isWhitelisted: false }]
      vault.writeCache('mcp', 'holo-mcp-connections', JSON.stringify(saved))
      await store.loadFromStorage()
      expect(store.connections.length).toBe(1)
      expect(store.connections[0].name).toBe('Saved')
      expect(store.connections[0].isConnected).toBe(false)
    })

    it('sets default permission on tools without one', async () => {
      const saved = [{ id: 'mcp-1', name: 'Saved', url: 'http://saved', isConnected: true, tools: [{ name: 't', description: '', inputSchema: {}, isAutoAllowed: false }], lastTestedAt: 0, isWhitelisted: false }]
      vault.writeCache('mcp', 'holo-mcp-connections', JSON.stringify(saved))
      await store.loadFromStorage()
      expect(store.connections[0].tools[0].permission).toBe('execute')
    })
  })
})
