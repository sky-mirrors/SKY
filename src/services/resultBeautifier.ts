import { MarkdownDocument, MarkdownNode } from '@/models'

export interface MarkdownNodeWithRange extends MarkdownNode {
  startLine: number
  endLine: number
}

export interface MarkdownDocumentWithRange {
  type: string
  children: MarkdownNodeWithRange[]
}

export function parseMarkdownAstWithRanges(markdown: string): MarkdownDocumentWithRange {
  const lines = markdown.split('\n')
  const children: MarkdownNodeWithRange[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const startLine = i

    if (line.match(/^#{1,6}\s/)) {
      const match = line.match(/^(#{1,6})\s+(.*)/)
      if (match) {
        children.push({ type: 'heading', content: match[2], level: match[1].length, startLine, endLine: i + 1 })
        i++
        continue
      }
    }

    if (line.match(/^>\s/)) {
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        i++
      }
      const content = lines.slice(startLine, i).map(l => l.replace(/^>\s?/, '')).join('\n')
      children.push({ type: 'blockquote', content, startLine, endLine: i })
      continue
    }

    if (line.match(/^[-*+]\s/)) {
      const items: MarkdownNode[] = []
      while (i < lines.length && lines[i].match(/^[-*+]\s/)) {
        items.push({ type: 'listItem', content: lines[i].replace(/^[-*+]\s/, '') })
        i++
      }
      children.push({ type: 'list', children: items, ordered: false, startLine, endLine: i })
      continue
    }

    if (line.match(/^\d+\.\s/)) {
      const items: MarkdownNode[] = []
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push({ type: 'listItem', content: lines[i].replace(/^\d+\.\s/, '') })
        i++
      }
      children.push({ type: 'list', children: items, ordered: true, startLine, endLine: i })
      continue
    }

    if (line.match(/^```/)) {
      const lang = line.replace(/^```\s*/, '') || 'text'
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].match(/^```/)) {
        codeLines.push(lines[i])
        i++
      }
      i++
      children.push({ type: 'code', content: codeLines.join('\n'), language: lang, startLine, endLine: i })
      continue
    }

    if (line.match(/^---/)) {
      children.push({ type: 'hr', startLine, endLine: i + 1 })
      i++
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    children.push({ type: 'paragraph', content: line, startLine, endLine: i + 1 })
    i++
  }

  return { type: 'document', children }
}

export function parseMarkdownAst(markdown: string): MarkdownDocument {
  const lines = markdown.split('\n')
  const children: MarkdownNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.match(/^#{1,6}\s/)) {
      const match = line.match(/^(#{1,6})\s+(.*)/)
      if (match) {
        children.push({ type: 'heading', content: match[2], level: match[1].length })
        i++
        continue
      }
    }

    if (line.match(/^>\s/)) {
      const content: string[] = []
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        content.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      children.push({ type: 'blockquote', content: content.join('\n') })
      continue
    }

    if (line.match(/^[-*+]\s/)) {
      const items: MarkdownNode[] = []
      while (i < lines.length && lines[i].match(/^[-*+]\s/)) {
        items.push({ type: 'listItem', content: lines[i].replace(/^[-*+]\s/, '') })
        i++
      }
      children.push({ type: 'list', children: items, ordered: false })
      continue
    }

    if (line.match(/^\d+\.\s/)) {
      const items: MarkdownNode[] = []
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push({ type: 'listItem', content: lines[i].replace(/^\d+\.\s/, '') })
        i++
      }
      children.push({ type: 'list', children: items, ordered: true })
      continue
    }

    if (line.match(/^```/)) {
      const lang = line.replace(/^```\s*/, '') || 'text'
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].match(/^```/)) {
        codeLines.push(lines[i])
        i++
      }
      i++
      children.push({ type: 'code', content: codeLines.join('\n'), language: lang })
      continue
    }

    if (line.match(/^---/)) {
      children.push({ type: 'hr' })
      i++
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    children.push({ type: 'paragraph', content: line })
    i++
  }

  return { type: 'document', children }
}

export function renderToHtml(ast: MarkdownDocument): string {
  const htmlParts: string[] = []
  for (const node of ast.children) {
    htmlParts.push(renderNodeHtml(node))
  }
  return htmlParts.join('\n')
}

function renderNodeHtml(node: MarkdownNode): string {
  switch (node.type) {
    case 'heading':
      return `<h${node.level}>${inlineFormat(node.content || '')}</h${node.level}>`
    case 'paragraph':
      return `<p>${inlineFormat(node.content || '')}</p>`
    case 'blockquote':
      return `<blockquote>${inlineFormat(node.content || '')}</blockquote>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const items = (node.children || []).map(c => `<li>${inlineFormat(c.content || '')}</li>`).join('')
      return `<${tag}>${items}</${tag}>`
    }
    case 'code':
      return `<pre><code class="language-${node.language || 'text'}">${escapeHtml(node.content || '')}</code></pre>`
    case 'hr':
      return '<hr/>'
    default:
      return `<p>${inlineFormat(node.content || '')}</p>`
  }
}

function inlineFormat(text: string): string {
  let result = escapeHtml(text)
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return result
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderToEmailHtml(markdown: string): string {
  const ast = parseMarkdownAst(markdown)
  const body = renderToHtml(ast)
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: 'Microsoft YaHei', Arial, sans-serif; color: #333; line-height: 1.6; max-width: 680px; margin: 0 auto; padding: 20px; }
h1 { color: #1a5276; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
h2 { color: #2c3e50; }
blockquote { border-left: 4px solid #3498db; padding: 8px 16px; background: #f8f9fa; margin: 12px 0; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
pre { background: #2c3e50; color: #ecf0f1; padding: 16px; border-radius: 6px; overflow-x: auto; }
hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
a { color: #3498db; }
</style></head>
<body>${body}</body>
</html>`
}

export function renderToDocxXml(markdown: string): string {
  const ast = parseMarkdownAst(markdown)
  const paragraphs: string[] = []

  for (const node of ast.children) {
    switch (node.type) {
      case 'heading':
        paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Heading${node.level}"/></w:pPr><w:r><w:t>${escapeXml(node.content || '')}</w:t></w:r></w:p>`)
        break
      case 'paragraph':
        paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(node.content || '')}</w:t></w:r></w:p>`)
        break
      case 'list': {
        for (const item of (node.children || [])) {
          const prefix = node.ordered ? '1. ' : '• '
          paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${prefix}${escapeXml(item.content || '')}</w:t></w:r></w:p>`)
        }
        break
      }
      case 'blockquote':
        paragraphs.push(`<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:i/><w:t xml:space="preserve">${escapeXml(node.content || '')}</w:t></w:r></w:p>`)
        break
      case 'code':
        paragraphs.push(`<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${escapeXml(node.content || '')}</w:t></w:r></w:p>`)
        break
      case 'hr':
        paragraphs.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`)
        break
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs.join('')}</w:body>
</w:document>`
}

export function renderToPptxOutline(markdown: string): { title: string; slides: { title: string; bullets: string[] }[] } {
  const ast = parseMarkdownAst(markdown)
  const slides: { title: string; bullets: string[] }[] = []
  let currentSlide: { title: string; bullets: string[] } | null = null

  for (const node of ast.children) {
    if (node.type === 'heading' && node.level === 1) {
      continue
    }
    if (node.type === 'heading' && (node.level === 2 || node.level === 3)) {
      currentSlide = { title: node.content || '', bullets: [] }
      slides.push(currentSlide)
      continue
    }
    if (node.type === 'list' && currentSlide) {
      for (const item of (node.children || [])) {
        currentSlide.bullets.push(item.content || '')
      }
      continue
    }
    if (node.type === 'paragraph' && currentSlide) {
      currentSlide.bullets.push(node.content || '')
    }
  }

  const h1 = ast.children.find(n => n.type === 'heading' && n.level === 1)
  return {
    title: h1?.content || '演示文稿',
    slides
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function beautify(markdown: string, format: 'html' | 'email' | 'docx' | 'pptx' | 'raw' = 'html'): string {
  switch (format) {
    case 'email':
      return renderToEmailHtml(markdown)
    case 'docx':
      return renderToDocxXml(markdown)
    case 'pptx':
      return JSON.stringify(renderToPptxOutline(markdown), null, 2)
    case 'html': {
      const ast = parseMarkdownAst(markdown)
      return renderToHtml(ast)
    }
    default:
      return markdown
  }
}
