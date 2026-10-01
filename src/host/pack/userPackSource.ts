import type { PackSource, PackKnowledgeFile, PackEvaluatorModule, PackExecution } from './types'

/**
 * 2026-10-01（用户诉求：「领域包应该**用户下载后**自动接到路由」）：
 * 把 pack 数据源从「编译期内置」扩到「内置 + 用户目录」。
 *
 * 存放约定：`{userData}/holostarmap-packs/<packId>/…`，目录结构与内置 `src/packs/<packId>/` 一致：
 *   pack.json · boundary/constraints.json · knowledge/*.json · execution/*.json
 *
 * 能力边界（有意）：用户 pack 是**纯数据**。`boundary/evaluators/*.ts` 是编译期模块
 * （内置源用 `import.meta.glob('*.ts')` 收集），运行时无法从磁盘加载 TS 代码，
 * 故用户 pack 的 `listEvaluators` 恒为空 —— 需要自定义评测逻辑时请用 constraints 的 DSL。
 *
 * 时序约束：`PackSource` 的 6 个方法全是**同步**的，而 IPC 读盘是异步的。
 * 因此采用「启动时一次性预加载进内存 → 之后提供同步视图」：见 `loadUserPackTree`。
 */

/** packId → { 相对路径（'/' 分隔）: 文件原文 } */
export type UserPackTree = Record<string, Record<string, string>>

const MAX_DEPTH = 4
const MAX_FILE_BYTES = 512 * 1024

interface FileEntryLike {
  name: string
  isDir: boolean
}

function parseJson(text: string | undefined): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`
}

/**
 * 经 electronAPI 递归读用户 pack 根目录，返回内存树。
 * fail-safe：无 IPC 能力 / 目录不存在 / 任一层读失败 ⇒ 该层跳过（返回 {} 或部分），**从不抛**。
 */
export async function loadUserPackTree(rootDir: string): Promise<UserPackTree> {
  const tree: UserPackTree = {}
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api?.fileList || !api?.fileRead || !rootDir) return tree

  // 顶层每个子目录 = 一个 packId
  const top = await api.fileList(rootDir)
  if (!top?.success || !top.entriesWithMeta) return tree

  for (const packEntry of top.entriesWithMeta as FileEntryLike[]) {
    if (!packEntry.isDir) continue
    // file:list 对目录返回的 name **带尾斜杠**（electron/fileListing.ts:69，便于模型识别目录），
    // 必须剥掉——否则 packId 会变成 'demo/'，与 manifest.id 不匹配导致挂载失败（真机实测踩到）。
    const packId = packEntry.name.replace(/\/+$/, '')
    const packDir = joinPath(rootDir, packId)
    const files: Record<string, string> = {}

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return
      let listing
      try { listing = await api.fileList(dir) } catch { return }
      if (!listing?.success || !listing.entriesWithMeta) return
      for (const e of listing.entriesWithMeta as FileEntryLike[]) {
        const name = e.name.replace(/\/+$/, '') // 同上：目录名带尾斜杠，统一剥掉
        const childRel = rel ? `${rel}/${name}` : name
        if (e.isDir) {
          await walk(joinPath(dir, name), childRel, depth + 1)
        } else if (name.endsWith('.json')) {
          try {
            const f = await api.fileRead(joinPath(dir, name), MAX_FILE_BYTES)
            if (f?.success && typeof f.content === 'string') files[childRel] = f.content
          } catch { /* 单文件读失败不拖垮整包 */ }
        }
      }
    }

    await walk(packDir, '', 0)
    if (Object.keys(files).length > 0) tree[packId] = files
  }

  return tree
}

/** 用内存树构造同步 PackSource（用户 pack：纯数据，无 evaluator）。 */
export function createUserPackSource(tree: UserPackTree): PackSource {
  const packIds = Object.keys(tree)
  const filesOf = (packId: string): Record<string, string> => tree[packId] ?? {}

  return {
    listPackIds: () => [...packIds],
    readManifest: (packId) => parseJson(filesOf(packId)['pack.json']),
    readConstraints: (packId) => parseJson(filesOf(packId)['boundary/constraints.json']),
    listKnowledge(packId) {
      const files: PackKnowledgeFile[] = []
      for (const [rel, text] of Object.entries(filesOf(packId))) {
        if (!rel.startsWith('knowledge/') || !rel.endsWith('.json')) continue
        const obj = parseJson(text) as { filename?: unknown; text?: unknown } | null
        if (obj && typeof obj.filename === 'string' && typeof obj.text === 'string') {
          files.push({ filename: obj.filename, text: obj.text })
        }
      }
      return files
    },
    listEvaluators(): Record<string, PackEvaluatorModule> {
      // 有意为空：TS evaluator 是编译期能力，运行时无法从磁盘加载（见文件头「能力边界」）
      return {}
    },
    readExecution(packId) {
      const merged: PackExecution = {}
      let found = false
      for (const [rel, text] of Object.entries(filesOf(packId))) {
        if (!rel.startsWith('execution/') || !rel.endsWith('.json')) continue
        const section = rel.slice('execution/'.length, -'.json'.length)
        const data = parseJson(text)
        if (data === null || typeof data !== 'object') continue
        found = true
        if (section === 'routing') merged.routing = data as PackExecution['routing']
        else if (section === 'terminology') merged.terminology = data as PackExecution['terminology']
        else if (section === 'manifests') merged.manifests = data as PackExecution['manifests']
        else if (section === 'cases') merged.cases = data as unknown[]
      }
      return found ? merged : null
    }
  }
}

/**
 * 混合源：内置优先、用户补齐。
 * 内置优先是**有意的**——用户 pack 不能顶掉内置 finance/hr/legal，
 * 否则一个同名目录就能改写既有行为。
 */
export function createHybridPackSource(builtin: PackSource, user: PackSource): PackSource {
  const pick = <T>(f: (src: PackSource) => T | null | undefined): T | null =>
    (f(builtin) ?? f(user) ?? null) as T | null

  return {
    listPackIds: () => Array.from(new Set([...builtin.listPackIds(), ...user.listPackIds()])),
    readManifest: (packId) => pick(s => s.readManifest(packId)),
    readConstraints: (packId) => pick(s => s.readConstraints(packId)),
    listKnowledge: (packId) => {
      const merged = [...builtin.listKnowledge(packId), ...user.listKnowledge(packId)]
      return merged
    },
    listEvaluators: (packId) => ({
      ...user.listEvaluators(packId),
      ...builtin.listEvaluators(packId) // 内置覆盖同名（同样内置优先）
    }),
    readExecution: (packId) => pick(s => s.readExecution(packId))
  }
}
