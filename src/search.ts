import { searchChunks, withClient } from "./db.js"
import { embedTexts } from "./embedder.js"
import { ensureSchema } from "./schema.js"

export type SearchResult = {
  sourceType: string
  sourceKey: string
  chunkIndex: number
  title: string | null
  content: string
  metadata: Record<string, unknown>
  distance: number
}

export async function searchRag(
  postgresUrl: string,
  repoId: string,
  embeddingModel: string,
  query: string,
  topK: number,
  similarityThreshold: number,
  sourceTypes?: string[],
): Promise<SearchResult[]> {
  const embeddings = await embedTexts(embeddingModel, [query])
  const vector = embeddings[0]
  if (!vector) throw new RangeError("Embedding model returned no vector for the query")
  return withClient(postgresUrl, async (client) => {
    await ensureSchema(client, {
      embeddingDimensions: vector.length,
      embeddingModel,
    })
    const rows = await searchChunks(client, repoId, vector, topK, similarityThreshold, sourceTypes)
    return rows.map((row) => ({
      sourceType: row.source_type,
      sourceKey: row.source_key,
      chunkIndex: row.chunk_index,
      title: row.title,
      content: row.content,
      metadata: row.metadata,
      distance: row.distance,
    }))
  })
}
