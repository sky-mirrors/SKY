import { describe, it, expect } from 'vitest'
import { parseMarkdownAstWithRanges, renderToHtml, renderToEmailHtml, beautify } from '@/services/resultBeautifier'

describe('resultBeautifier', () => {
  describe('parseMarkdownAstWithRanges', () => {
    it('parses headings with correct levels and ranges', () => {
      const md = '# Title\n## Subtitle\n### Sub-subtitle'
      const ast = parseMarkdownAstWithRanges(md)
      expect(ast.type).toBe('document')
      expect(ast.children.length).toBe(3)
      expect(ast.children[0].type).toBe('heading')
      expect(ast.children[0].level).toBe(1)
      expect(ast.children[0].startLine).toBe(0)
      expect(ast.children[0].endLine).toBe(1)
      expect(ast.children[1].level).toBe(2)
      expect(ast.children[2].level).toBe(3)
    })

    it('parses paragraphs', () => {
      const md = 'First paragraph\n\nSecond paragraph'
      const ast = parseMarkdownAstWithRanges(md)
      const paras = ast.children.filter(c => c.type === 'paragraph')
      expect(paras.length).toBe(2)
      expect(paras[0].content).toBe('First paragraph')
      expect(paras[1].content).toBe('Second paragraph')
    })

    it('parses unordered lists', () => {
      const md = '- item 1\n- item 2\n- item 3'
      const ast = parseMarkdownAstWithRanges(md)
      const list = ast.children.find(c => c.type === 'list')
      expect(list).toBeDefined()
      expect(list!.ordered).toBe(false)
      expect(list!.children!.length).toBe(3)
    })

    it('parses ordered lists', () => {
      const md = '1. first\n2. second\n3. third'
      const ast = parseMarkdownAstWithRanges(md)
      const list = ast.children.find(c => c.type === 'list')
      expect(list).toBeDefined()
      expect(list!.ordered).toBe(true)
      expect(list!.children!.length).toBe(3)
    })

    it('parses blockquotes', () => {
      const md = '> quote line 1\n> quote line 2'
      const ast = parseMarkdownAstWithRanges(md)
      const bq = ast.children.find(c => c.type === 'blockquote')
      expect(bq).toBeDefined()
      expect(bq!.content).toContain('quote line 1')
      expect(bq!.content).toContain('quote line 2')
    })

    it('parses code blocks with language', () => {
      const md = '```javascript\nconsole.log("hello")\n```'
      const ast = parseMarkdownAstWithRanges(md)
      const code = ast.children.find(c => c.type === 'code')
      expect(code).toBeDefined()
      expect(code!.language).toBe('javascript')
      expect(code!.content).toBe('console.log("hello")')
    })

    it('parses code blocks without language as text', () => {
      const md = '```\nsome code\n```'
      const ast = parseMarkdownAstWithRanges(md)
      const code = ast.children.find(c => c.type === 'code')
      expect(code).toBeDefined()
      expect(code!.language).toBe('text')
    })

    it('parses horizontal rules', () => {
      const md = '---'
      const ast = parseMarkdownAstWithRanges(md)
      expect(ast.children[0].type).toBe('hr')
    })

    it('skips blank lines', () => {
      const md = 'para1\n\n\n\npara2'
      const ast = parseMarkdownAstWithRanges(md)
      const paras = ast.children.filter(c => c.type === 'paragraph')
      expect(paras.length).toBe(2)
    })

    it('tracks line ranges correctly', () => {
      const md = '# Title\n\nParagraph\n\n- list item'
      const ast = parseMarkdownAstWithRanges(md)
      expect(ast.children[0].startLine).toBe(0)
      expect(ast.children[0].endLine).toBe(1)
    })
  })

  describe('renderToHtml', () => {
    it('renders headings with correct tags', () => {
      const md = '# Title\n## Subtitle'
      const html = beautify(md, 'html')
      expect(html).toContain('<h1>Title</h1>')
      expect(html).toContain('<h2>Subtitle</h2>')
    })

    it('renders paragraphs', () => {
      const md = 'Hello world'
      const html = beautify(md, 'html')
      expect(html).toContain('<p>Hello world</p>')
    })

    it('renders bold text', () => {
      const md = 'This is **bold** text'
      const html = beautify(md, 'html')
      expect(html).toContain('<strong>bold</strong>')
    })

    it('renders italic text', () => {
      const md = 'This is *italic* text'
      const html = beautify(md, 'html')
      expect(html).toContain('<em>italic</em>')
    })

    it('renders inline code', () => {
      const md = 'Use `console.log` to debug'
      const html = beautify(md, 'html')
      expect(html).toContain('<code>console.log</code>')
    })

    it('renders safe links with target=_blank', () => {
      const md = '[Click](https://example.com)'
      const html = beautify(md, 'html')
      expect(html).toContain('href="https://example.com"')
      expect(html).toContain('rel="noopener noreferrer"')
      expect(html).toContain('target="_blank"')
    })

    it('blocks javascript: links (XSS prevention)', () => {
      const md = '[Click](javascript:alert(1))'
      const html = beautify(md, 'html')
      expect(html).not.toContain('href="javascript:')
      expect(html).toContain('unsafe-link')
    })

    it('blocks data: links (XSS prevention)', () => {
      const md = '[Click](data:text/html,<script>alert(1)</script>)'
      const html = beautify(md, 'html')
      expect(html).not.toContain('href="data:')
      expect(html).toContain('unsafe-link')
    })

    it('blocks vbscript: links (XSS prevention)', () => {
      const md = '[Click](vbscript:msgbox)'
      const html = beautify(md, 'html')
      expect(html).not.toContain('href="vbscript:')
      expect(html).toContain('unsafe-link')
    })

    it('renders unordered lists', () => {
      const md = '- item 1\n- item 2'
      const html = beautify(md, 'html')
      expect(html).toContain('<ul>')
      expect(html).toContain('<li>item 1</li>')
      expect(html).toContain('<li>item 2</li>')
      expect(html).toContain('</ul>')
    })

    it('renders ordered lists', () => {
      const md = '1. first\n2. second'
      const html = beautify(md, 'html')
      expect(html).toContain('<ol>')
      expect(html).toContain('<li>first</li>')
      expect(html).toContain('</ol>')
    })

    it('renders blockquotes', () => {
      const md = '> quoted text'
      const html = beautify(md, 'html')
      expect(html).toContain('<blockquote>')
      expect(html).toContain('quoted text')
    })

    it('renders code blocks with language class', () => {
      const md = '```python\nprint(hi)\n```'
      const html = beautify(md, 'html')
      expect(html).toContain('language-python')
      expect(html).toContain('print(hi)')
    })

    it('escapes HTML in content', () => {
      const md = 'Use <script>alert("xss")</script>'
      const html = beautify(md, 'html')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('renders horizontal rules', () => {
      const md = '---'
      const html = beautify(md, 'html')
      expect(html).toContain('<hr/>')
    })
  })

  describe('renderToEmailHtml', () => {
    it('produces valid HTML document', () => {
      const md = '# Email Title\nContent here'
      const html = renderToEmailHtml(md)
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('<html>')
      expect(html).toContain('</html>')
      expect(html).toContain('<style>')
      expect(html).toContain('Email Title')
    })
  })

  describe('beautify', () => {
    it('returns raw markdown for raw format', () => {
      const md = '# Test **bold**'
      expect(beautify(md, 'raw')).toBe(md)
    })

    it('returns HTML for html format', () => {
      const md = '# Test'
      const result = beautify(md, 'html')
      expect(result).toContain('<h1>Test</h1>')
    })

    it('returns email HTML for email format', () => {
      const md = '# Test'
      const result = beautify(md, 'email')
      expect(result).toContain('<!DOCTYPE html>')
    })

    it('returns DOCX XML for docx format', () => {
      const md = '# Test Heading\nParagraph text'
      const result = beautify(md, 'docx')
      expect(result).toContain('<?xml')
      expect(result).toContain('w:document')
    })

    it('returns PPTX JSON for pptx format', () => {
      const md = '# Presentation\n## Slide 1\n- bullet 1\n- bullet 2'
      const result = beautify(md, 'pptx')
      const parsed = JSON.parse(result)
      expect(parsed.title).toBe('Presentation')
      expect(parsed.slides.length).toBe(1)
      expect(parsed.slides[0].title).toBe('Slide 1')
      expect(parsed.slides[0].bullets).toEqual(['bullet 1', 'bullet 2'])
    })
  })
})
