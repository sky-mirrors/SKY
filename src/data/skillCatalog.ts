import { SkillCatalogItem } from '@/models'

export const SKILL_CATALOG: SkillCatalogItem[] = [
  {
    id: 'skill-web-research',
    name: '深度网络研究',
    description: '使用Brave Search搜索网络+Jina Reader提取网页内容，自动完成多源信息采集与全文摘要',
    category: '研究',
    version: '1.0.0',
    author: '研究社区',
    nodes: [
      { toolId: 'l1-task-translator', params: { mode: 'search' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-task-translator', 'l1-result-beautifier'],
    tags: ['搜索', '研究', '网页', '信息采集'],
    mcpServerId: 'mcp-brave-search',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    mcpEnvKeys: ['BRAVE_API_KEY'],
    mcpTools: ['brave_web_search', 'brave_local_search'],
    homepage: 'https://github.com/brave/brave-search-mcp-server'
  },
  {
    id: 'skill-knowledge-base',
    name: '知识库问答',
    description: '基于MCP Memory知识图谱构建持久化记忆，存储实体关系并检索相关上下文回答问题',
    category: '知识管理',
    version: '1.0.0',
    author: '效率社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'memory' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'query' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['知识图谱', '记忆', '问答', '持久化'],
    mcpServerId: 'mcp-memory',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-memory'],
    mcpEnvKeys: [],
    mcpTools: ['create_entities', 'create_relations', 'search_nodes', 'open_nodes', 'read_graph'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    id: 'skill-file-analysis',
    name: '文件智能分析',
    description: '读取本地文件内容+Sequential Thinking深度推理，自动分析文档/代码/数据并生成报告',
    category: '开发',
    version: '1.0.0',
    author: '开发者社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'filesystem' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'analyze' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['文件', '分析', '代码审查', '报告'],
    mcpServerId: 'mcp-filesystem',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    mcpEnvKeys: [],
    mcpTools: ['read_file', 'write_file', 'search_files', 'list_directory', 'get_file_info'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'skill-deep-reasoning',
    name: '深度推理分析',
    description: 'Sequential Thinking思维链+Memory上下文记忆，支持多步骤复杂推理和反思验证',
    category: '推理',
    version: '1.0.0',
    author: '研究社区',
    nodes: [
      { toolId: 'l1-workspace-memory', params: { context: 'reasoning' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'reason' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-workspace-memory', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-workspace-memory', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['推理', '思维链', '逻辑', '反思'],
    mcpServerId: 'mcp-sequential-thinking',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    mcpEnvKeys: [],
    mcpTools: ['sequentialthinking'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  {
    id: 'skill-github-codereview',
    name: 'GitHub代码审查',
    description: '读取GitHub仓库PR/Issue+深度推理审查代码变更，自动识别Bug、安全漏洞和性能问题',
    category: '开发',
    version: '1.0.0',
    author: '开发者社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'github' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'review' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['GitHub', '代码审查', 'PR', '安全'],
    mcpServerId: 'mcp-github',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-github'],
    mcpEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    mcpTools: ['create_or_update_file', 'search_repositories', 'create_issue', 'get_file_contents', 'push_files', 'create_pull_request', 'search_code', 'list_commits'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github'
  },
  {
    id: 'skill-gitlab-ci',
    name: 'GitLab项目管理',
    description: '管理GitLab项目、合并请求和CI/CD流水线，追踪Issue和代码变更',
    category: '开发',
    version: '1.0.0',
    author: '开发者社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'gitlab' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'manage' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'report' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['GitLab', 'CI/CD', '项目管理', '合并请求'],
    mcpServerId: 'mcp-gitlab',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    mcpEnvKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    mcpTools: ['create_or_update_file', 'search_repositories', 'create_issue', 'merge_request', 'get_file_contents', 'list_commits'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gitlab'
  },
  {
    id: 'skill-web-scraping',
    name: '网页内容提取',
    description: 'Puppeteer浏览器自动化+Jina Reader网页转Markdown，抓取和提取任意网页内容',
    category: '自动化',
    version: '1.0.0',
    author: '效率社区',
    nodes: [
      { toolId: 'l1-task-translator', params: { mode: 'extract' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-task-translator', 'l1-result-beautifier'],
    tags: ['网页', '抓取', '自动化', '提取'],
    mcpServerId: 'mcp-puppeteer',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
    mcpEnvKeys: [],
    mcpTools: ['puppeteer_navigate', 'puppeteer_screenshot', 'puppeteer_click', 'puppeteer_fill', 'puppeteer_evaluate'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer'
  },
  {
    id: 'skill-playwright-auto',
    name: 'Playwright自动化测试',
    description: '微软Playwright驱动Chromium/Firefox/WebKit，自动化表单填写、截图、端到端测试',
    category: '自动化',
    version: '1.0.0',
    author: '测试社区',
    nodes: [
      { toolId: 'l1-task-translator', params: { mode: 'test' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'report' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-task-translator', 'l1-result-beautifier'],
    tags: ['测试', '自动化', '浏览器', 'E2E'],
    mcpServerId: 'mcp-playwright',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@playwright/mcp@latest'],
    mcpEnvKeys: [],
    mcpTools: ['browser_navigate', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_evaluate'],
    homepage: 'https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-playwright'
  },
  {
    id: 'skill-gdrive-docs',
    name: 'Google Drive文档管理',
    description: '搜索和读取Google Drive中的文件，自动提取文档内容用于分析和报告生成',
    category: '云存储',
    version: '1.0.0',
    author: '效率社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'gdrive' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'summarize' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'docx' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Google', '云盘', '文档', '搜索'],
    mcpServerId: 'mcp-gdrive',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-gdrive'],
    mcpEnvKeys: ['GDRIVE_OAUTH_TOKEN'],
    mcpTools: ['search', 'read_file', 'list_files'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive'
  },
  {
    id: 'skill-slack-collab',
    name: 'Slack协作助手',
    description: '搜索Slack频道消息、发送通知、管理频道，团队协作信息自动汇总',
    category: '协作',
    version: '1.0.0',
    author: '协作社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'slack' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'compose' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'email' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Slack', '消息', '协作', '通知'],
    mcpServerId: 'mcp-slack',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-slack'],
    mcpEnvKeys: ['SLACK_BOT_TOKEN'],
    mcpTools: ['slack_list_channels', 'slack_post_message', 'slack_search_messages', 'slack_get_thread_replies'],
    homepage: 'https://github.com/zencoderai/slack-mcp-server'
  },
  {
    id: 'skill-context7-docs',
    name: '开源库文档查询',
    description: 'Context7实时获取开源库最新文档和代码示例，无需手动复制粘贴',
    category: '开发',
    version: '1.0.0',
    author: '开发者社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'docs' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-result-beautifier'],
    tags: ['文档', 'API', '开源', '代码示例'],
    mcpServerId: 'mcp-context7',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@upstash/context7-mcp@latest'],
    mcpEnvKeys: [],
    mcpTools: ['resolve-library-id', 'get-library-docs'],
    homepage: 'https://github.com/upstash/context7'
  },
  {
    id: 'skill-supabase-data',
    name: 'Supabase数据管理',
    description: 'Supabase数据库SQL查询、表操作和存储管理，快速构建数据应用',
    category: '数据库',
    version: '1.0.0',
    author: '数据社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'database' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'query' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'csv' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Supabase', '数据库', 'SQL', 'BaaS'],
    mcpServerId: 'mcp-supabase',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@supabase/mcp-server-supabase'],
    mcpEnvKeys: ['SUPABASE_ACCESS_TOKEN'],
    mcpTools: ['list_tables', 'execute_sql', 'list_projects'],
    homepage: 'https://github.com/supabase-community/supabase-mcp'
  },
  {
    id: 'skill-notion-workspace',
    name: 'Notion工作空间',
    description: '搜索和操作Notion页面与数据库，自动创建/更新笔记和任务',
    category: '协作',
    version: '1.0.0',
    author: '效率社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'notion' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'compose' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Notion', '笔记', '协作', '知识管理'],
    mcpServerId: 'mcp-notion',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@notionhq/notion-mcp-server'],
    mcpEnvKeys: ['NOTION_API_KEY'],
    mcpTools: ['search', 'create_page', 'update_page', 'get_page', 'query_database'],
    homepage: 'https://github.com/makenotion/notion-mcp-server'
  },
  {
    id: 'skill-gmail-assistant',
    name: 'Gmail邮件助手',
    description: '搜索Gmail邮件、发送邮件、管理标签和草稿，自动化邮件处理流程',
    category: '协作',
    version: '1.0.0',
    author: '效率社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'email' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'compose' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'email' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Gmail', '邮件', '自动化', '搜索'],
    mcpServerId: 'mcp-gmail',
    mcpCommand: 'npx',
    mcpArgs: ['-y', 'gogcli-mcp-gmail'],
    mcpEnvKeys: ['GMAIL_CREDENTIALS_PATH'],
    mcpTools: ['gmail_search', 'gmail_send', 'gmail_draft', 'gmail_list_labels', 'gmail_read_thread'],
    homepage: 'https://github.com/chrischall/gogcli-mcp'
  },
  {
    id: 'skill-obsidian-vault',
    name: 'Obsidian笔记管理',
    description: '读写搜索Obsidian Vault笔记，自动整理和关联知识卡片',
    category: '知识管理',
    version: '1.0.0',
    author: '知识社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'obsidian' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'organize' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['Obsidian', '笔记', '知识管理', '双链'],
    mcpServerId: 'mcp-obsidian',
    mcpCommand: 'npx',
    mcpArgs: ['-y', 'obsidian-mcp-server'],
    mcpEnvKeys: ['OBSIDIAN_VAULT_PATH'],
    mcpTools: ['read_note', 'write_note', 'search_notes', 'list_notes', 'edit_note'],
    homepage: 'https://github.com/cyanheads/obsidian-mcp-server'
  },
  {
    id: 'skill-git-version',
    name: 'Git版本控制',
    description: '完整的Git操作：提交、分支、合并、暂存，代码版本管理自动化',
    category: '开发',
    version: '1.0.0',
    author: '开发者社区',
    nodes: [
      { toolId: 'l1-task-translator', params: { mode: 'git' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'report' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-task-translator', 'l1-result-beautifier'],
    tags: ['Git', '版本控制', '分支', '合并'],
    mcpServerId: 'mcp-git',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@cyanheads/git-mcp-server'],
    mcpEnvKeys: [],
    mcpTools: ['git_commit', 'git_branch', 'git_merge', 'git_stash', 'git_log', 'git_diff', 'git_status'],
    homepage: 'https://github.com/cyanheads/git-mcp-server'
  },
  {
    id: 'skill-postgres-query',
    name: 'PostgreSQL数据查询',
    description: '只读访问PostgreSQL数据库，Schema检查和SQL查询，数据分析和报表生成',
    category: '数据库',
    version: '1.0.0',
    author: '数据社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'database' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'query' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'csv' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['PostgreSQL', 'SQL', '数据库', '报表'],
    mcpServerId: 'mcp-postgres',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    mcpEnvKeys: [],
    mcpTools: ['query', 'list_tables', 'describe_table'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres'
  },
  {
    id: 'skill-clickup-pm',
    name: 'ClickUp项目管理',
    description: 'ClickUp任务/冲刺/文档管理，团队项目进度追踪和自动化',
    category: '项目管理',
    version: '1.0.0',
    author: 'PM社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'project' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'manage' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'report' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['ClickUp', '项目管理', '任务', '冲刺'],
    mcpServerId: 'mcp-clickup',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@taazkareem/clickup-mcp-server'],
    mcpEnvKeys: ['CLICKUP_API_TOKEN'],
    mcpTools: ['get_task', 'create_task', 'update_task', 'list_tasks', 'get_space'],
    homepage: 'https://github.com/taazkareem/clickup-mcp-server'
  },
  {
    id: 'skill-ai-image',
    name: 'AI图像生成',
    description: 'EverArt多模型图像生成（DALL-E/Stable Diffusion），文生图和风格迁移',
    category: '创意',
    version: '1.0.0',
    author: '创意社区',
    nodes: [
      { toolId: 'l1-task-translator', params: { mode: 'generate' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'html' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-task-translator', 'l1-result-beautifier'],
    tags: ['图像', 'AI绘画', 'DALL-E', '创意'],
    mcpServerId: 'mcp-everart',
    mcpCommand: 'npx',
    mcpArgs: ['-y', '@modelcontextprotocol/server-everart'],
    mcpEnvKeys: ['EVERART_API_KEY'],
    mcpTools: ['generate_image'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/everart'
  },
  {
    id: 'skill-exa-search',
    name: 'AI语义搜索',
    description: 'Exa AI驱动的语义搜索，支持网页搜索、代码搜索和公司研究',
    category: '研究',
    version: '1.0.0',
    author: '研究社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'web' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-task-translator', params: { mode: 'research' }, position: { x: 1, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 2, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-task-translator', type: 'data' },
      { from: 'l1-task-translator', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier'],
    tags: ['搜索', 'AI', '语义', '研究'],
    mcpServerId: 'mcp-exa',
    mcpCommand: 'npx',
    mcpArgs: ['-y', 'exa-mcp-server'],
    mcpEnvKeys: ['EXA_API_KEY'],
    mcpTools: ['web_search', 'research_papers', 'company_research', 'code_search'],
    homepage: 'https://github.com/exa-labs/exa-mcp-server'
  },
  {
    id: 'skill-jina-reader',
    name: '网页转Markdown',
    description: 'Jina AI Reader将任意URL转换为LLM友好的Markdown，支持网页搜索和内容提取',
    category: '研究',
    version: '1.0.0',
    author: '研究社区',
    nodes: [
      { toolId: 'l1-knowledge-feeder', params: { scope: 'web' }, position: { x: 0, y: 0 } },
      { toolId: 'l1-result-beautifier', params: { format: 'markdown' }, position: { x: 1, y: 0 } }
    ],
    edges: [
      { from: 'l1-knowledge-feeder', to: 'l1-result-beautifier', type: 'data' }
    ],
    dependencies: ['l1-knowledge-feeder', 'l1-result-beautifier'],
    tags: ['网页', 'Markdown', '提取', 'Jina'],
    mcpServerId: 'mcp-jina',
    mcpCommand: 'npx',
    mcpArgs: ['-y', 'jina-mcp-tools'],
    mcpEnvKeys: ['JINA_API_KEY'],
    mcpTools: ['read_url', 'search', 'reason'],
    homepage: 'https://github.com/PsychArch/jina-mcp-tools'
  }
]
