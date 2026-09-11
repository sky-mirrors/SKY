<template>
  <div class="preview-stage" v-if="message">
    <div class="preview-header">
      <h3>结果预览</h3>
      <span class="preview-modified-count" v-if="modifiedCount > 0">{{ modifiedCount }} 处已修改</span>
      <button class="preview-close" @click="$emit('close')" title="关闭预览">✕</button>
    </div>
    <div class="preview-blocks">
      <div v-for="(block, idx) in astBlocks" :key="idx"
           class="preview-block"
           :class="{ modified: block.isModified, editing: editingBlockIdx === idx }">
        <div class="block-toolbar">
          <span class="block-type">{{ blockLabel(block) }}</span>
          <template v-if="editingBlockIdx !== idx">
            <button class="edit-btn" @click="startEdit(idx)" title="编辑此块">✏️</button>
          </template>
          <template v-else>
            <button class="save-btn" @click="saveEdit(idx)" title="保存">✅</button>
            <button class="cancel-btn" @click="cancelEdit" title="取消">❌</button>
          </template>
        </div>
        <div v-if="editingBlockIdx !== idx" class="block-content" v-html="block.html"></div>
        <textarea v-else class="block-editor" v-model="editText" @keydown.escape="cancelEdit"></textarea>
        <span v-if="block.isModified" class="modified-badge">已修改</span>
      </div>
    </div>
    <div class="preview-footer" v-if="modifiedCount > 0">
      <button class="diff-summary-btn" @click="showDiffSummary = !showDiffSummary">
        📋 变更摘要
      </button>
      <div v-if="showDiffSummary" class="diff-summary">
        <div v-for="(d, idx) in diffs" :key="idx" class="diff-entry">
          <span class="diff-block-label">{{ d.label }}</span>
          <div class="diff-old"><del>{{ d.oldText }}</del></div>
          <div class="diff-new"><ins>{{ d.newText }}</ins></div>
        </div>
      </div>
    </div>
    <div class="preview-empty" v-if="astBlocks.length === 0">
      此消息无可预览内容
    </div>
  </div>
  <div class="preview-stage preview-empty" v-else>
    <p>请从对话中选择一条结果进行预览</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { DialogMessage } from '@/models'
import { parseMarkdownAstWithRanges, renderToHtml, MarkdownNodeWithRange } from '@/domains/dialog'
import { useDialogStore } from '@/domains/dialog'
import DOMPurify from 'dompurify'

interface PreviewBlock {
  node: MarkdownNodeWithRange
  originalMarkdown: string
  html: string
  isEditing: boolean
  isModified: boolean
  currentMarkdown: string
}

interface DiffEntry {
  label: string
  oldText: string
  newText: string
}

const props = defineProps<{
  message: DialogMessage | null
}>()

defineEmits<{
  close: []
}>()

const dialogStore = useDialogStore()

const astBlocks = ref<PreviewBlock[]>([])
const editingBlockIdx = ref<number | null>(null)
const editText = ref('')
const showDiffSummary = ref(false)

const modifiedCount = computed(() => astBlocks.value.filter(b => b.isModified).length)

const diffs = computed<DiffEntry[]>(() => {
  return astBlocks.value
    .filter(b => b.isModified)
    .map(b => ({
      label: blockLabelFromNode(b.node),
      oldText: b.originalMarkdown.length > 200 ? b.originalMarkdown.substring(0, 200) + '...' : b.originalMarkdown,
      newText: b.currentMarkdown.length > 200 ? b.currentMarkdown.substring(0, 200) + '...' : b.currentMarkdown
    }))
})

function blockLabel(block: PreviewBlock): string {
  return blockLabelFromNode(block.node)
}

function blockLabelFromNode(node: MarkdownNodeWithRange): string {
  switch (node.type) {
    case 'heading': return `标题 H${node.level}`
    case 'paragraph': return '段落'
    case 'list': return node.ordered ? '有序列表' : '列表'
    case 'blockquote': return '引用'
    case 'code': return `代码 (${node.language || 'text'})`
    case 'hr': return '分隔线'
    default: return '内容'
  }
}

function rebuildBlocks() {
  if (!props.message) {
    astBlocks.value = []
    return
  }
  const content = props.message.content
  const lines = content.split('\n')
  const doc = parseMarkdownAstWithRanges(content)
  const blocks: PreviewBlock[] = []
  for (const node of doc.children) {
    const rawMd = lines.slice(node.startLine, node.endLine).join('\n')
    const html = DOMPurify.sanitize(renderToHtml({ type: 'document', children: [node] }))
    blocks.push({
      node,
      originalMarkdown: rawMd,
      html,
      isEditing: false,
      isModified: false,
      currentMarkdown: rawMd
    })
  }
  astBlocks.value = blocks
  editingBlockIdx.value = null
  showDiffSummary.value = false
}

function startEdit(idx: number) {
  editingBlockIdx.value = idx
  editText.value = astBlocks.value[idx].currentMarkdown
}

function cancelEdit() {
  editingBlockIdx.value = null
  editText.value = ''
}

function saveEdit(idx: number) {
  if (!props.message) return
  const block = astBlocks.value[idx]
  const newMd = editText.value
  if (newMd === block.originalMarkdown) {
    block.isModified = false
    block.currentMarkdown = newMd
  } else {
    block.isModified = true
    block.currentMarkdown = newMd
  }
  const updatedDoc = parseMarkdownAstWithRanges(newMd)
  block.html = DOMPurify.sanitize(renderToHtml({ type: 'document', children: updatedDoc.children }))
  block.node = updatedDoc.children[0] || block.node

  const fullLines = props.message.content.split('\n')
  fullLines.splice(block.node.startLine, block.node.endLine - block.node.startLine, ...newMd.split('\n'))
  dialogStore.updateMessageContent(props.message.id, fullLines.join('\n'))

  editingBlockIdx.value = null
  editText.value = ''
}

watch(() => props.message?.id, () => {
  rebuildBlocks()
})

rebuildBlocks()
</script>

<style scoped>
.preview-stage {
  position: fixed;
  top: 28px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(8, 10, 20, 0.92);
  backdrop-filter: blur(12px);
  z-index: 50;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.preview-header {
  display: flex;
  align-items: center;
  padding: 10px 20px;
  border-bottom: 1px solid rgba(100, 160, 220, 0.2);
  gap: 12px;
}
.preview-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: #8cf;
}
.preview-modified-count {
  font-size: 11px;
  color: #fc8;
  background: rgba(200, 140, 40, 0.15);
  padding: 2px 8px;
  border-radius: 10px;
}
.preview-close {
  margin-left: auto;
  background: none;
  border: 1px solid rgba(180, 80, 80, 0.4);
  color: #c88;
  font-size: 14px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.preview-close:hover {
  background: rgba(200, 60, 60, 0.2);
  border-color: #c66;
}
.preview-blocks {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.preview-block {
  position: relative;
  background: rgba(20, 25, 45, 0.6);
  border: 1px solid rgba(80, 120, 180, 0.15);
  border-radius: 8px;
  padding: 12px 16px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.preview-block:hover {
  border-color: rgba(80, 120, 180, 0.3);
}
.preview-block.modified {
  border-left: 3px solid #fc8;
  box-shadow: 0 0 8px rgba(240, 180, 60, 0.1);
}
.preview-block.editing {
  border-color: rgba(80, 200, 120, 0.4);
  box-shadow: 0 0 12px rgba(60, 200, 100, 0.1);
}
.block-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.block-type {
  font-size: 10px;
  color: #68a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.edit-btn, .save-btn, .cancel-btn {
  background: none;
  border: 1px solid rgba(100, 140, 200, 0.3);
  color: #8bf;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: auto;
}
.edit-btn:hover {
  background: rgba(80, 140, 220, 0.15);
}
.save-btn {
  border-color: rgba(80, 180, 80, 0.4);
  color: #8c8;
}
.save-btn:hover {
  background: rgba(60, 160, 60, 0.15);
}
.cancel-btn {
  border-color: rgba(180, 80, 80, 0.3);
  color: #c88;
}
.cancel-btn:hover {
  background: rgba(200, 60, 60, 0.15);
}
.block-content {
  color: #c8d4e8;
  font-size: 13px;
  line-height: 1.7;
}
.block-content :deep(h1), .block-content :deep(h2), .block-content :deep(h3),
.block-content :deep(h4), .block-content :deep(h5), .block-content :deep(h6) {
  color: #8cf;
  margin: 4px 0;
}
.block-content :deep(p) {
  margin: 4px 0;
}
.block-content :deep(ul), .block-content :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}
.block-content :deep(blockquote) {
  border-left: 3px solid #48a;
  padding: 4px 12px;
  margin: 4px 0;
  color: #9ab;
}
.block-content :deep(pre) {
  background: rgba(10, 12, 25, 0.6);
  padding: 10px 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 12px;
}
.block-content :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
}
.block-editor {
  width: 100%;
  min-height: 120px;
  background: rgba(10, 12, 25, 0.8);
  color: #c8d4e8;
  border: 1px solid rgba(80, 200, 120, 0.3);
  border-radius: 4px;
  padding: 10px 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}
.block-editor:focus {
  outline: none;
  border-color: rgba(80, 200, 120, 0.6);
}
.modified-badge {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 9px;
  color: #fc8;
  background: rgba(200, 140, 40, 0.15);
  padding: 1px 6px;
  border-radius: 8px;
}
.preview-footer {
  padding: 10px 24px;
  border-top: 1px solid rgba(100, 160, 220, 0.15);
}
.diff-summary-btn {
  background: none;
  border: 1px solid rgba(100, 160, 220, 0.3);
  color: #8cf;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.diff-summary-btn:hover {
  background: rgba(80, 140, 220, 0.15);
}
.diff-summary {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.diff-entry {
  background: rgba(20, 25, 45, 0.5);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
}
.diff-block-label {
  color: #8cf;
  font-weight: 500;
}
.diff-old {
  color: #c88;
  margin: 4px 0;
}
.diff-old del {
  text-decoration: line-through;
  opacity: 0.7;
}
.diff-new {
  color: #8c8;
  margin: 4px 0;
}
.diff-new ins {
  text-decoration: none;
  border-bottom: 1px dashed #8c8;
}
.preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #568;
  font-size: 14px;
  flex: 1;
}
</style>
