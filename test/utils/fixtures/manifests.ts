export const MOCK_L2_MANIFEST = {
  identity: {
    id: 'mock-l2-tool',
    name: 'Mock L2 Tool',
    version: '1.0.0',
    level: 'L2' as const,
    category: 'analysis',
    description: 'A mock L2 tool manifest for testing',
    icon: 'mock-icon',
    apiRole: 'analyzer'
  },
  visual: {
    position: { x: 0, y: 0, z: 0 },
    gridIndex: [1, 1, 0] as [number, number, number],
    color: '#00ff00',
    size: 1.0
  },
  routing: {
    keywords: ['mock', 'test', 'analyze'],
    domains: ['general'],
    tier: 'standard' as const,
    priority: 50
  },
  execution: {
    type: 'llm' as const,
    timeout: 30000,
    retries: 1,
    params: {}
  },
  cacheMeta: {
    ttl: 3600,
    keyPattern: 'mock-{{hash}}',
    invalidationTriggers: []
  },
  ruleBasedFallback: {
    rules: [
      {
        id: 'mock-rule-1',
        pattern: 'test',
        output: 'mock-output',
        priority: 10,
        tags: ['test']
      }
    ],
    defaultOutput: 'No result found'
  }
}

export const MOCK_L2_MANIFEST_MINIMAL = {
  identity: {
    id: 'minimal-tool',
    name: 'Minimal Tool',
    version: '1.0.0',
    level: 'L2' as const,
    category: 'utility',
    description: 'Minimal manifest',
    icon: '',
    apiRole: ''
  },
  visual: {
    position: { x: 0, y: 0, z: 0 },
    gridIndex: [0, 0, 0] as [number, number, number],
    color: '#ffffff',
    size: 1.0
  },
  routing: {
    keywords: [],
    domains: [],
    tier: 'nano' as const,
    priority: 0
  },
  execution: {
    type: 'direct' as const,
    timeout: 10000,
    retries: 0,
    params: {}
  },
  cacheMeta: {
    ttl: 0,
    keyPattern: '',
    invalidationTriggers: []
  }
}
