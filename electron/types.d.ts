declare module 'archiver' {
  import { Transform } from 'stream'
  interface ArchiverOptions {
    zlib?: { level?: number }
  }
  interface Archiver extends Transform {
    directory(dirPath: string, destPath: string | false): this
    finalize(): Promise<void>
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream
  }
  const archiver: (format: string, options?: ArchiverOptions) => Archiver
  export default archiver
}

declare module 'extract-zip' {
  interface Options {
    dir: string
  }
  const extract: (zipPath: string, options: Options) => Promise<void>
  export default extract
}

declare module 'docx' {
  export class Document {
    constructor(options: { sections: Array<{ children: unknown[] }> })
  }
  export class Packer {
    static toBuffer(doc: Document): Promise<Buffer>
  }
  export class Paragraph {
    constructor(options: { text?: string; heading?: unknown; children?: unknown[] })
  }
  export class TextRun {
    constructor(text: string | { text?: string })
  }
  export const HeadingLevel: { HEADING_1: unknown }
}

declare module 'jschardet' {
  interface DetectResult {
    encoding: string
    confidence: number
  }
  function detect(buffer: Buffer | Uint8Array): DetectResult
  const _jschardet: { detect: typeof detect }
  export = _jschardet
}

declare module 'iconv-lite' {
  function decode(buffer: Buffer | Uint8Array, encoding: string): string
  function encodingExists(encoding: string): boolean
  const _iconv: { decode: typeof decode; encodingExists: typeof encodingExists }
  export = _iconv
}
