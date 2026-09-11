import { McpCatalogItem } from '@/models'

export const MCP_CATALOG: McpCatalogItem[] = [
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    description: '安全文件操作，支持可配置的访问控制，读取/写入/搜索文件和目录',
    category: '文件系统',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envKeys: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    source: 'official',
    tags: ['文件', '读写', '目录']
  },
  {
    id: 'mcp-memory',
    name: 'Memory',
    description: '基于知识图谱的持久化记忆系统，存储和检索实体关系',
    category: '记忆',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    source: 'official',
    tags: ['知识图谱', '记忆', '持久化']
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    description: '动态反思式问题解决，通过思维链序列进行推理和验证',
    category: '推理',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envKeys: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    source: 'official',
    tags: ['推理', '思维链', '逻辑']
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'GitHub API集成，仓库管理、Issue、PR操作、文件读写',
    category: '开发',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
    source: 'official',
    tags: ['GitHub', 'Issue', 'PR']
  },
  {
    id: 'mcp-context7',
    name: 'Context7',
    description: '实时获取开源库最新文档和代码示例，无需手动粘贴',
    category: '开发',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    envKeys: [],
    homepage: 'https://github.com/upstash/context7',
    source: 'community',
    tags: ['文档', 'API', '开源']
  }
]
