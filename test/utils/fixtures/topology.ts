import type { ToolNode } from '@/models'

export const MOCK_L0_NODE: ToolNode = {
  id: 'l0-core',
  name: 'Core',
  level: 'L0',
  position: { x: 0, y: 0, z: 0 },
  gridIndex: [0, 0, 0],
  description: 'Central orchestrator node',
  enabled: true,
  locked: false
}

export const MOCK_L1_NODE: ToolNode = {
  id: 'l1-analyzer',
  name: 'Analyzer',
  level: 'L1',
  position: { x: 10, y: 0, z: 0 },
  gridIndex: [1, 0, 0],
  description: 'Analysis capability node',
  enabled: true,
  locked: false,
  apiRole: 'analyzer'
}

export const MOCK_L2_NODE: ToolNode = {
  id: 'l2-translator',
  name: 'Translator',
  level: 'L2',
  position: { x: 20, y: 0, z: 0 },
  gridIndex: [2, 0, 0],
  description: 'Translation tool node',
  enabled: true,
  locked: false,
  parentL1Id: 'l1-analyzer'
}

export const MOCK_L3_NODE: ToolNode = {
  id: 'l3-custom',
  name: 'Custom Tool',
  level: 'L3',
  position: { x: 30, y: 0, z: 0 },
  gridIndex: [3, 0, 0],
  description: 'Custom user tool node',
  enabled: true,
  locked: false,
  communityHeat: 0.5,
  gravityWeight: 1.0
}

export const MOCK_NODES = [MOCK_L0_NODE, MOCK_L1_NODE, MOCK_L2_NODE, MOCK_L3_NODE]

export const MOCK_ADJACENCY_MAP: Record<string, string[]> = {
  'l0-core': ['l1-analyzer'],
  'l1-analyzer': ['l2-translator'],
  'l2-translator': ['l3-custom']
}

export const MOCK_PIPELINE = {
  id: 'pipe-1',
  name: 'Test Pipeline',
  steps: [
    { toolId: 'l2-translator', params: { input: '{{userInput}}' }, outputKey: 'translation' },
    { toolId: 'l2-summarizer', params: { text: '{{translation}}' }, outputKey: 'summary' }
  ],
  mode: 'serial' as const,
  createdAt: Date.now(),
  attachedEntryIds: []
}

export const MOCK_DAG_PIPELINE = {
  id: 'dag-1',
  name: 'DAG Pipeline',
  steps: [],
  mode: 'serial' as const,
  createdAt: Date.now(),
  attachedEntryIds: [],
  dagNodes: [
    { id: 'dn-1', toolId: 'l2-translator', toolName: 'Translator', toolLevel: 'L2', position: { x: 0, y: 0 }, params: { input: '{{userInput}}' }, outputKey: 'translation', status: 'pending' as const },
    { id: 'dn-2', toolId: 'l2-summarizer', toolName: 'Summarizer', toolLevel: 'L2', position: { x: 200, y: 0 }, params: { text: '{{translation}}' }, outputKey: 'summary', status: 'pending' as const }
  ],
  dagEdges: [
    { id: 'de-1', sourceNodeId: 'dn-1', sourceOutputKey: 'translation', targetNodeId: 'dn-2', targetParamName: 'text' }
  ]
}

export const MOCK_CONSTRAINT = {
  id: 'finance-001',
  domain: 'finance',
  category: 'amount_validation',
  description: 'Validate monetary amounts in financial documents',
  severity: 'error' as const,
  applicability: { domains: ['finance'], outputTypes: ['report', 'summary'] },
  reliability: { level: 'high' as const, confidence: 0.95 },
  testCases: [
    { description: 'Amount should match', input: '100万元', expected: true },
    { description: 'Missing amount', input: '无金额', expected: false }
  ],
  status: 'active' as const,
  triggerCount: 0,
  falsePositiveCount: 0,
  lastTriggeredAt: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  automationLevel: 'full' as const,
  reviewType: 'auto' as const,
  check: () => null
}

export const MOCK_MCP_CONNECTION = {
  id: 'mcp-mock-1',
  name: 'Mock MCP Server',
  url: 'http://localhost:8080',
  isConnected: true,
  tools: [
    { name: 'mock_tool', description: 'A mock tool', inputSchema: { type: 'object', properties: {} }, isAutoAllowed: false, permission: 'readwrite' as const }
  ],
  lastTestedAt: Date.now(),
  isWhitelisted: false
}

export const MOCK_KNOWLEDGE_GROUP = {
  id: 'kg-1',
  name: 'Test Knowledge Group',
  sharedEntryIds: ['entry-1', 'entry-2'],
  createdAt: Date.now(),
  updatedAt: Date.now()
}

export const MOCK_PROJECT_MEMORY = {
  id: 'proj-1',
  name: 'Test Project',
  fileFingerprints: ['fp-abc123'],
  knowledgeEntryIds: ['entry-1'],
  vectorIndex: {},
  updatedAt: Date.now()
}

export const MOCK_SKILL = {
  id: 'skill-1',
  name: 'Test Skill',
  description: 'A test skill',
  version: '1.0.0',
  nodes: [{ toolId: 'l2-translator', params: { input: '{{text}}' }, position: { x: 0, y: 0 } }],
  edges: [],
  dependencies: [],
  author: 'test',
  createdAt: Date.now(),
  isInstalled: true,
  isFromMarket: false
}

export const MOCK_WORKFLOW_LOG = {
  id: 'wf-1',
  name: 'Test Workflow',
  nodes: [
    { toolId: 'l2-translator', toolName: 'Translator', startedAt: Date.now(), completedAt: Date.now() + 100, status: 'completed' as const }
  ],
  edges: [],
  timestamps: [Date.now()],
  ioSnapshots: [{ toolId: 'l2-translator', input: 'test input', output: 'test output', timestamp: Date.now() }],
  startedAt: Date.now(),
  completedAt: Date.now() + 1000,
  status: 'completed' as const
}
