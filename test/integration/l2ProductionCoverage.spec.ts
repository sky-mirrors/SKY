import { describe, it, expect } from 'vitest'

/**
 * L2 端到端覆盖——**生产条件验证入口**（2026-09-30）
 *
 * 为什么单独成文件、且默认会跳过：本仓库的 L2 检索是「关键词 + 向量」混合，向量由
 * `@/services/embedder`（transformers.js，模型 `Xenova/all-MiniLM-L6-v2`）产出。
 * 实测环境（2026-09-30）：`~/.cache/huggingface` 为空、模型下载被证书问题阻断
 * （`unable to verify the first certificate`）⇒ **嵌入模型**不可用 ⇒ 向量退化为伪向量、
 * 分数是噪声 ⇒ **在该环境断言命中率毫无意义**（既可能假绿也可能假红）。
 *
 * ⚠ 措辞澄清（2026-09-30 用户指出）：不可用的是**嵌入模型**，不是"本地模型"。本项目主打
 * **本地 LLM**——`qwen2.5:3b`（Ollama，见 `src/services/ollamaProvider.ts` 与多处注释），
 * 承担生成/工具调用；而 `embedder.ts` **不接 Ollama**，L2 的向量只来自 transformers.js 的
 * MiniLM。两者角色不同，不能互相替代。注：本机的 `ollama` 命令亦不在 PATH、11434 无响应，
 * 但那是环境差异，与本文件要测的向量链无关。
 *
 * 因此本文件不做条件伪装：embedder 不可用时**明确跳过并打印原因**（跳过 ≠ 通过），
 * 只有 embedder 真正可用（有网或有本地缓存）时才执行断言——那才是生产条件。
 *
 * 注意：`toolRetrieval.spec.ts` 里 mock 了 embedder，所以那段判断必须在**本文件**做
 * （不 mock 任何模块，才能拿到真实的 isEmbedderReady）。
 */
describe('L2 端到端覆盖（生产条件：需真实 embedder）', () => {
  it('单步/多步 manifest 意图能被检索命中', async () => {
    const { isEmbedderReady } = await import('@/services/embedder')
    if (!isEmbedderReady()) {
      // eslint-disable-next-line no-console
      console.log('[skip] **嵌入模型**不可用（transformers.js 的 Xenova/all-MiniLM-L6-v2 无本地缓存' +
        '且下载受阻）——本用例未执行，非通过。注意：这与本地 LLM（qwen2.5:3b / Ollama）无关，' +
        'embedder 不接 Ollama；请在能加载该嵌入模型的环境重跑以完成 L2 生产验证')
      return
    }

    const { buildToolIndex, universalMatch } = await import('@/services/toolRetrieval')
    const l2 = (await import('@/data/l2Manifests')).default
    const index = await buildToolIndex([], l2 as never)

    const samples: Array<[string, string]> = [
      ['帮我审查这份合同的风险', '合同风险审查'],
      ['帮我生成本周周报草稿', '周报自动草稿'],
      ['帮我筛选这些简历', '简历初筛助手'],
      ['把这段会议记录整理成纪要', '会议纪要生成']
    ]
    for (const [input, want] of samples) {
      const r = await universalMatch(input, index, {})
      expect(r?.item?.manifest?.identity?.name).toBe(want)
    }
  }, 60000)
})
