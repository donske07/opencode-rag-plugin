import { get_encoding, type Tiktoken } from "@dqbd/tiktoken"

const DEFAULT_ENCODING = "cl100k_base"
let encoder: Tiktoken | null = null

function getEncoder() {
  if (!encoder) {
    encoder = get_encoding(DEFAULT_ENCODING)
  }
  return encoder
}

export function chunkText(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (!normalized) return []

  const sections = splitIntoSections(normalized)
  const encoding = getEncoder()
  const maxTokens = Math.max(1, Math.floor(chunkSize))
  const overlapTokens = Math.max(0, Math.min(Math.floor(chunkOverlap), maxTokens - 1))
  const separatorTokens = Array.from(encoding.encode("\n\n"))
  const chunks: string[] = []
  let buffer: number[] = []

  const pushChunk = (tokens: number[]) => {
    if (tokens.length === 0) return
    const decoded = encoding.decode(tokens)
    const text = typeof decoded === "string" ? decoded : new TextDecoder().decode(decoded)
    chunks.push(text.trim())
  }

  for (const section of sections) {
    const cleaned = section.replace(/\s+/g, " ").trim()
    if (!cleaned) continue

    const sectionTokens = Array.from(encoding.encode(cleaned))
    if (sectionTokens.length > maxTokens) {
      if (buffer.length > 0) {
        pushChunk(buffer)
        buffer = overlapTokens > 0 ? buffer.slice(-overlapTokens) : []
      }

      for (let start = 0; start < sectionTokens.length; start += maxTokens - overlapTokens) {
        const slice = sectionTokens.slice(start, start + maxTokens)
        pushChunk(slice)
      }

      buffer = overlapTokens > 0 ? sectionTokens.slice(-overlapTokens) : []
      continue
    }

    const separator = buffer.length > 0 ? separatorTokens : []
    if (buffer.length + separator.length + sectionTokens.length <= maxTokens) {
      buffer = buffer.concat(separator, sectionTokens)
      continue
    }

    pushChunk(buffer)
    buffer = overlapTokens > 0 ? buffer.slice(-overlapTokens) : []

    const prefixed = buffer.length > 0 ? buffer.concat(separatorTokens) : []
    if (prefixed.length + sectionTokens.length <= maxTokens) {
      buffer = prefixed.concat(sectionTokens)
      continue
    }

    if (buffer.length > 0) {
      pushChunk(buffer)
    }
    buffer = sectionTokens
  }

  if (buffer.length > 0) {
    pushChunk(buffer)
  }

  return chunks.filter((chunk) => chunk.length > 0)
}

function splitIntoSections(text: string): string[] {
  const lines = text.split("\n")
  const sections: string[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length === 0) return
    sections.push(current.join("\n").trim())
    current = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      flush()
      current.push(trimmed)
      continue
    }

    current.push(line)
  }

  flush()
  return sections
}
