import { defineStore } from 'pinia'
import { ref } from 'vue'
import { McpConnection, McpTool, McpCatalogItem, McpToolPermission } from '@/models'
import { globalBus } from '@/kernel/bus'
import { MCP_CATALOG } from '@/data/mcpCatalog'
import { vault } from '@/vault'

export const useMcpStore = defineStore('mcp', () => {
  const connections = ref<McpConnection[]>([])
  const mcpToolsAsNodes = ref<{ id: string; name: string; description: string; mcpId: string }[]>([])
  const catalog = ref<McpCatalogItem[]>(MCP_CATALOG)
  const spawningId = ref<string | null>(null)
  const spawningCatalogId = ref<string | null>(null)
  const lastSpawnError = ref<string | null>(null)

  function addConnection(name: string, url: string): McpConnection {
    const conn: McpConnection = {
      id: `mcp-${Date.now()}`,
      name,
      url: url.replace(/\/+$/, ''),
      isConnected: false,
      tools: [],
      lastTestedAt: 0,
      isWhitelisted: false
    }
    connections.value.push(conn)
    saveToStorage()
    return conn
  }

  function removeConnection(id: string) {
    stopMcpProcess(id)
    connections.value = connections.value.filter(c => c.id !== id)
    rebuildMcpNodes()
    saveToStorage()
  }

  function isCatalogItemInstalled(catalogId: string): boolean {
    return connections.value.some(c => c.catalogId === catalogId)
  }

  async function installFromCatalog(item: McpCatalogItem, envValues: Record<string, string> = {}): Promise<McpConnection | null> {
    if (isCatalogItemInstalled(item.id)) {
      return connections.value.find(c => c.catalogId === item.id) || null
    }

    const conn: McpConnection = {
      id: `mcp-${Date.now()}`,
      name: item.name,
      url: '',
      isConnected: false,
      tools: [],
      lastTestedAt: 0,
      isWhitelisted: false,
      catalogId: item.id,
      catalogCommand: item.command,
      catalogArgs: [...item.args],
      catalogEnv: { ...envValues }
    }
    connections.value.push(conn)
    saveToStorage()

    await startMcpFromCatalog(conn.id)
    return conn
  }

  async function startMcpFromCatalog(connId: string): Promise<boolean> {
    const conn = connections.value.find(c => c.id === connId)
    if (!conn || !conn.catalogCommand) return false

    if (!window.electronAPI) {
      conn.isConnected = false
      saveToStorage()
      return false
    }

    spawningId.value = connId
    spawningCatalogId.value = conn.catalogId || null
    lastSpawnError.value = null

    try {
      let plainArgs = JSON.parse(JSON.stringify(conn.catalogArgs || [])) as string[]
      const plainEnv = JSON.parse(JSON.stringify(conn.catalogEnv || {})) as Record<string, string>

      const result = await window.electronAPI.mcpSpawn({
        id: connId,
        command: String(conn.catalogCommand),
        args: plainArgs,
        env: plainEnv
      })

      if (result.success) {
        conn.isConnected = true
        conn.lastTestedAt = Date.now()
        if (result.tools) {
          conn.tools = result.tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            isAutoAllowed: false
          }))
        }
        rebuildMcpNodes()
        saveToStorage()
        return true
      } else {
        conn.isConnected = false
        conn.lastTestedAt = Date.now()
        lastSpawnError.value = result.error || 'Unknown error'
        saveToStorage()
        return false
      }
    } catch (err) {
      conn.isConnected = false
      lastSpawnError.value = err instanceof Error ? err.message : String(err)
      saveToStorage()
      return false
    } finally {
      spawningId.value = null
      spawningCatalogId.value = null
    }
  }

  async function stopMcpProcess(id: string) {
    if (window.electronAPI) {
      await window.electronAPI.mcpStop({ id: String(id) })
    }
    const conn = connections.value.find(c => c.id === id)
    if (conn) {
      conn.isConnected = false
      rebuildMcpNodes()
      saveToStorage()
    }
  }

  async function refreshTools(id: string): Promise<boolean> {
    const conn = connections.value.find(c => c.id === id)
    if (!conn) return false

    if (conn.catalogCommand && window.electronAPI) {
      const result = await window.electronAPI.mcpListTools({ id: String(id) })
      if (result.success && result.tools) {
        conn.tools = result.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          isAutoAllowed: false
        }))
        rebuildMcpNodes()
        saveToStorage()
        return true
      }
      return false
    }

    return testConnection(id)
  }

  async function testConnection(id: string): Promise<boolean> {
    const conn = connections.value.find(c => c.id === id)
    if (!conn) return false

    if (conn.catalogCommand) {
      return startMcpFromCatalog(id)
    }

    try {
      const resp = await fetch(`${conn.url}/tools/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        signal: AbortSignal.timeout(15000)
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

      const data = await resp.json()
      const tools: McpTool[] = (data.result?.tools ?? []).map((t: Record<string, unknown>) => ({
        name: t.name as string,
        description: (t.description ?? '') as string,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        isAutoAllowed: false
      }))

      conn.tools = tools
      conn.isConnected = true
      conn.lastTestedAt = Date.now()

      globalBus.emit('memory:add-mcp-log', {
        mcpId: conn.id,
        toolName: 'tools/list',
        request: JSON.stringify({ method: 'tools/list' }),
        response: JSON.stringify(data.result ?? {}),
        success: true
      })

      rebuildMcpNodes()
      saveToStorage()
      return true
    } catch (err) {
      conn.isConnected = false
      conn.lastTestedAt = Date.now()

      globalBus.emit('memory:add-mcp-log', {
        mcpId: conn.id,
        toolName: 'tools/list',
        request: JSON.stringify({ method: 'tools/list' }),
        response: String(err),
        success: false
      })

      saveToStorage()
      return false
    }
  }

  async function callTool(mcpId: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    const conn = connections.value.find(c => c.id === mcpId)
    if (!conn || !conn.isConnected) throw new Error('MCP not connected')

    const tool = conn.tools.find(t => t.name === toolName)
    if (!tool) throw new Error(`Tool ${toolName} not found`)

    if (!tool.isAutoAllowed && !conn.isWhitelisted) {
      throw new Error(`Tool "${toolName}" requires authorization — enable auto-allow or whitelist the connection first`)
    }

    const perm = tool.permission || 'execute'
    const isWriteOperation = /write|create|delete|update|remove|insert|set|put|post|exec|run|spawn|shell/i.test(toolName)
    const isExecOperation = /exec|run|spawn|shell|command|script/i.test(toolName)
    if (perm === 'readonly' && isWriteOperation) {
      throw new Error(`Tool ${toolName} is read-only — write operations not permitted`)
    }
    if (perm === 'readwrite' && isExecOperation) {
      throw new Error(`Tool ${toolName} is read-write — execute operations not permitted (needs 'execute' permission)`)
    }

    if (conn.catalogCommand && window.electronAPI) {
      try {
        const result = await window.electronAPI.mcpCallTool({
          id: mcpId,
          toolName: String(toolName),
          args: JSON.parse(JSON.stringify(args))
        })

        if (!result.success) throw new Error(result.error || 'MCP call failed')

        let resultStr: string
        const raw = result.result as Record<string, unknown> | undefined
        if (raw && Array.isArray(raw.content)) {
          const textParts: string[] = []
          for (const item of raw.content as Record<string, unknown>[]) {
            if (item.type === 'text' && typeof item.text === 'string') {
              textParts.push(item.text)
            } else if (item.type === 'image') {
              textParts.push(`[图片数据]`)
            } else if (item.type === 'resource') {
              const res = item.resource as Record<string, unknown> | undefined
              textParts.push(res?.text ? String(res.text) : `[资源: ${res?.uri || 'unknown'}]`)
            }
          }
          resultStr = textParts.join('\n')
        } else if (raw && typeof raw === 'object') {
          resultStr = JSON.stringify(raw)
        } else {
          resultStr = String(raw ?? '')
        }

        globalBus.emit('memory:add-mcp-log', {
          mcpId: conn.id,
          toolName,
          request: JSON.stringify({ method: 'tools/call', name: toolName, arguments: args }),
          response: resultStr.substring(0, 2000),
          success: true
        })

        globalBus.emit('memory:add-audit-log', {
          userId: 'local',
          action: 'mcp_tool_call',
          toolId: toolName,
          mcpId: conn.id,
          details: `Called ${toolName} on ${conn.name}`
        })

        return resultStr
      } catch (err) {
        globalBus.emit('memory:add-mcp-log', {
          mcpId: conn.id,
          toolName,
          request: JSON.stringify({ method: 'tools/call', name: toolName }),
          response: String(err),
          success: false
        })
        throw err
      }
    }

    const requestPayload = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: Date.now()
    }

    try {
      const resp = await fetch(`${conn.url}/tools/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(120000)
      })

      const data = await resp.json()
      const resultStr = JSON.stringify(data.result ?? data)

      globalBus.emit('memory:add-mcp-log', {
        mcpId: conn.id,
        toolName,
        request: JSON.stringify(requestPayload),
        response: resultStr,
        success: resp.ok
      })

      globalBus.emit('memory:add-audit-log', {
        userId: 'local',
        action: 'mcp_tool_call',
        toolId: toolName,
        mcpId: conn.id,
        details: `Called ${toolName} on ${conn.name}`
      })

      return resultStr
    } catch (err) {
      globalBus.emit('memory:add-mcp-log', {
        mcpId: conn.id,
        toolName,
        request: JSON.stringify(requestPayload),
        response: String(err),
        success: false
      })
      throw err
    }
  }

  function toggleToolAutoAllow(mcpId: string, toolName: string) {
    const conn = connections.value.find(c => c.id === mcpId)
    if (!conn) return
    const tool = conn.tools.find(t => t.name === toolName)
    if (tool) tool.isAutoAllowed = !tool.isAutoAllowed
    saveToStorage()
  }

  function setWhitelist(mcpId: string, whitelisted: boolean) {
    const conn = connections.value.find(c => c.id === mcpId)
    if (conn) conn.isWhitelisted = whitelisted
    saveToStorage()
  }

  function rebuildMcpNodes() {
    const nodes: { id: string; name: string; description: string; mcpId: string }[] = []
    for (const conn of connections.value) {
      if (conn.isConnected) {
        for (const tool of conn.tools) {
          nodes.push({
            id: `mcp-${conn.id}-${tool.name}`,
            name: tool.name,
            description: tool.description,
            mcpId: conn.id
          })
        }
      }
    }
    mcpToolsAsNodes.value = nodes
  }

  function saveToStorage() {
    vault.writeThrough('mcp', 'holo-mcp-connections', JSON.stringify(connections.value))
  }

  async function loadFromStorage() {
    const saved = vault.readCache('mcp', 'holo-mcp-connections')
    if (saved) {
      try {
        connections.value = JSON.parse(saved) as McpConnection[]
        for (const conn of connections.value) {
          conn.isConnected = false
          for (const tool of conn.tools) {
            if (!tool.permission) tool.permission = 'execute'
          }
        }
        rebuildMcpNodes()
      } catch { /* ignore */ }
    }
  }

  async function autoRestartCatalogMcp() {
    const catalogConns = connections.value.filter(c => c.catalogCommand)
    for (const conn of catalogConns) {
      await startMcpFromCatalog(conn.id)
    }
    const httpConns = connections.value.filter(c => c.url && !c.catalogCommand)
    for (const conn of httpConns) {
      await testConnection(conn.id)
    }
  }

  function setToolPermission(mcpId: string, toolName: string, permission: McpToolPermission) {
    const conn = connections.value.find(c => c.id === mcpId)
    if (!conn) return
    const tool = conn.tools.find(t => t.name === toolName)
    if (!tool) return
    tool.permission = permission
    saveToStorage()
  }

  return {
    connections,
    mcpToolsAsNodes,
    catalog,
    spawningId,
    spawningCatalogId,
    lastSpawnError,
    addConnection,
    removeConnection,
    testConnection,
    callTool,
    toggleToolAutoAllow,
    setToolPermission,
    setWhitelist,
    loadFromStorage,
    autoRestartCatalogMcp,
    isCatalogItemInstalled,
    installFromCatalog,
    startMcpFromCatalog,
    stopMcpProcess,
    refreshTools
  }
})
