import type { RagConfig } from "../config.js"
import { replaceChunks, withClient } from "../db.js"
import { embedTexts } from "../embedder.js"
import { ensureSchema } from "../schema.js"
import { collectFileChunks } from "./files.js"
import { crawlWeb } from "./web.js"

type BaseChunk = {
  sourceKey: string
  title: string | null
  chunkIndex: number
  content: string
  metadata: Record<string, unknown>
}

export async function indexSources(
  config: RagConfig,
  repoId: string,
  options: { files: boolean; docs: boolean; web: boolean },
) {
  const sources: Array<{ type: "files" | "docs" | "web"; chunks: BaseChunk[] }> = []

  if (options.files && config.fileRoots.length > 0) {
    const chunks = await collectFileChunks({
      roots: config.fileRoots,
      sourceKind: "files",
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      maxFileBytes: config.maxFileBytes,
    })
    sources.push({ type: "files", chunks })
  }

  if (options.docs && config.docsRoots.length > 0) {
    const chunks = await collectFileChunks({
      roots: config.docsRoots,
      sourceKind: "docs",
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      maxFileBytes: config.maxFileBytes,
    })
    sources.push({ type: "docs", chunks })
  }

  if (options.web && config.web.startUrls.length > 0) {
    const webChunks = await crawlWeb({
      startUrls: config.web.startUrls,
      allowlistHosts: config.web.allowlistHosts,
      maxPages: config.web.maxPages,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      requestTimeoutMs: config.web.requestTimeoutMs,
      maxResponseBytes: config.web.maxResponseBytes,
      maxRedirects: config.web.maxRedirects,
    })
    sources.push({ type: "web", chunks: webChunks })
  }

  if (sources.length === 0) return 0

  return withClient(config.postgresUrl, async (client) => {
    await ensureSchema(client, {
      embeddingDimensions: config.embeddingDimensions,
      embeddingModel: config.embeddingModel,
    })

    let totalChunks = 0
    for (const source of sources) {
      const grouped = groupBySourceKey(source.chunks)
      for (const [sourceKey, sourceChunks] of grouped.entries()) {
        const embeddings = await embedTexts(
          config.embeddingModel,
          sourceChunks.map((chunk) => chunk.content),
        )
        if (embeddings.length !== sourceChunks.length) {
          throw new RangeError("Embedding count did not match the source chunk count")
        }
        const records = sourceChunks.map((chunk, index) => ({
          repoId,
          sourceType: source.type,
          sourceKey,
          chunkIndex: chunk.chunkIndex,
          title: chunk.title,
          content: chunk.content,
          metadata: chunk.metadata,
          embedding: embeddings[index] ?? [],
        }))
        await replaceChunks(client, { repoId, sourceType: source.type, sourceKey }, records)
        totalChunks += records.length
      }
    }

    return totalChunks
  })
}

function groupBySourceKey<T extends { sourceKey: string }>(chunks: T[]) {
  const map = new Map<string, T[]>()
  for (const chunk of chunks) {
    const list = map.get(chunk.sourceKey) ?? []
    list.push(chunk)
    map.set(chunk.sourceKey, list)
  }
  return map
}
