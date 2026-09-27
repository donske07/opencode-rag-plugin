import { Client } from "pg"

export type RagChunkRecord = {
  readonly repoId: string
  readonly sourceType: string
  readonly sourceKey: string
  readonly chunkIndex: number
  readonly title: string | null
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly embedding: readonly number[]
}

export type SourceIdentity = {
  readonly repoId: string
  readonly sourceType: string
  readonly sourceKey: string
}

export type ProjectCardRecord = {
  repoId: string
  content: string
  source: string
  contentHash: string
  createdAt?: Date
  lastConfirmed?: Date
}

export async function withClient<T>(
  postgresUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: postgresUrl })
  await client.connect()
  try {
    return await operation(client)
  } finally {
    await client.end()
  }
}

export async function ensureProjectCardSchema(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS repo_memory (
      id bigserial PRIMARY KEY,
      repo_id text NOT NULL,
      kind text NOT NULL,
      content text NOT NULL,
      source text NOT NULL,
      content_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_confirmed timestamptz NOT NULL DEFAULT now()
    )
  `)
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS repo_memory_repo_kind_idx ON repo_memory (repo_id, kind)",
  )
  await client.query("CREATE INDEX IF NOT EXISTS repo_memory_repo_idx ON repo_memory (repo_id)")
}

export class ChunkSourceMismatchError extends Error {
  readonly name = "ChunkSourceMismatchError"

  constructor(readonly source: SourceIdentity) {
    super(`Every chunk must belong to ${source.sourceType}:${source.sourceKey}`)
  }
}

export async function replaceChunks(
  client: Client,
  source: SourceIdentity,
  chunks: readonly RagChunkRecord[],
): Promise<void> {
  if (
    chunks.some(
      (chunk) =>
        chunk.repoId !== source.repoId ||
        chunk.sourceType !== source.sourceType ||
        chunk.sourceKey !== source.sourceKey,
    )
  ) {
    throw new ChunkSourceMismatchError(source)
  }

  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      source.repoId,
      `${source.sourceType}:${source.sourceKey}`,
    ])
    await client.query(
      "DELETE FROM rag_chunks WHERE repo_id = $1 AND source_type = $2 AND source_key = $3",
      [source.repoId, source.sourceType, source.sourceKey],
    )
    if (chunks.length > 0) await insertChunks(client, chunks)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

async function insertChunks(client: Client, chunks: readonly RagChunkRecord[]): Promise<void> {
  const values: unknown[] = []
  const placeholders: string[] = []

  chunks.forEach((chunk, index) => {
    const offset = index * 8
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::vector)`,
    )
    values.push(
      chunk.repoId,
      chunk.sourceType,
      chunk.sourceKey,
      chunk.chunkIndex,
      chunk.title,
      chunk.content,
      JSON.stringify(chunk.metadata ?? {}),
      vectorLiteral(chunk.embedding),
    )
  })

  await client.query(
    `INSERT INTO rag_chunks (repo_id, source_type, source_key, chunk_index, title, content, metadata, embedding)
     VALUES ${placeholders.join(", ")}`,
    values,
  )
}

export async function upsertProjectCard(client: Client, record: ProjectCardRecord) {
  const result = await client.query(
    `
    INSERT INTO repo_memory (repo_id, kind, content, source, content_hash, last_confirmed)
    VALUES ($1, 'project_card', $2, $3, $4, now())
    ON CONFLICT (repo_id, kind)
    DO UPDATE SET
      content = EXCLUDED.content,
      source = EXCLUDED.source,
      content_hash = EXCLUDED.content_hash,
      last_confirmed = now()
    RETURNING repo_id, kind, content, source, content_hash, created_at, last_confirmed
    `,
    [record.repoId, record.content, record.source, record.contentHash],
  )

  return result.rows[0] as {
    repo_id: string
    kind: string
    content: string
    source: string
    content_hash: string
    created_at: Date
    last_confirmed: Date
  }
}

export async function getProjectCard(client: Client, repoId: string) {
  const result = await client.query(
    `
    SELECT repo_id, kind, content, source, content_hash, created_at, last_confirmed
    FROM repo_memory
    WHERE repo_id = $1 AND kind = 'project_card'
    LIMIT 1
    `,
    [repoId],
  )

  return result.rows[0] as
    | {
        repo_id: string
        kind: string
        content: string
        source: string
        content_hash: string
        created_at: Date
        last_confirmed: Date
      }
    | undefined
}

export async function searchChunks(
  client: Client,
  repoId: string,
  queryEmbedding: number[],
  topK: number,
  similarityThreshold: number,
  sourceTypes?: string[],
) {
  const vector = vectorLiteral(queryEmbedding)
  const rows = await client.query(
    `
    SELECT source_type, source_key, chunk_index, title, content, metadata,
           (embedding <=> $1::vector) AS distance
    FROM rag_chunks
    WHERE repo_id = $2
      AND ($3::text[] IS NULL OR source_type = ANY($3))
      AND (embedding <=> $1::vector) <= $5
    ORDER BY embedding <=> $1::vector
    LIMIT $4
    `,
    [vector, repoId, sourceTypes ?? null, topK, similarityThreshold],
  )

  return rows.rows as Array<{
    source_type: string
    source_key: string
    chunk_index: number
    title: string | null
    content: string
    metadata: Record<string, unknown>
    distance: number
  }>
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`
}
