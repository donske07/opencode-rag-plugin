import path from "node:path"

import type { Client } from "pg"
import { z } from "zod"

const SCHEMA_VERSION = 2

export type IndexSchemaConfig = {
  readonly embeddingDimensions: number
  readonly embeddingModel: string
}

const indexMetadataRowsSchema = z.array(
  z.object({
    schema_version: z.number().int(),
    embedding_dimensions: z.number().int(),
    embedding_model: z.string(),
  }),
)

const countRowsSchema = z.array(z.object({ count: z.string() }))
const vectorTypeRowsSchema = z.array(z.object({ data_type: z.string() }))
const indexDefinitionRowsSchema = z.array(z.object({ indexdef: z.string() }))
const columnRowsSchema = z.array(z.object({ exists: z.boolean() }))

export class IndexCompatibilityError extends Error {
  readonly name = "IndexCompatibilityError"

  constructor(
    readonly expected: IndexSchemaConfig,
    readonly actual: IndexSchemaConfig | null,
  ) {
    super(
      actual
        ? `Existing index is incompatible: expected ${expected.embeddingDimensions} dimensions from ${expected.embeddingModel}, found ${actual.embeddingDimensions} dimensions from ${actual.embeddingModel}`
        : "Existing index is incompatible or has no compatibility metadata; clear and rebuild it before continuing",
    )
  }
}

export async function ensureSchema(client: Client, config: IndexSchemaConfig): Promise<void> {
  if (!Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions < 1) {
    throw new RangeError("Embedding dimensions must be a positive integer")
  }

  const embeddingModel = path.resolve(config.embeddingModel)
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('opencode-rag-plugin:schema'))")
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id bigserial PRIMARY KEY,
        repo_id text NOT NULL,
        source_type text NOT NULL,
        source_key text NOT NULL,
        chunk_index integer NOT NULL,
        title text,
        content text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        embedding public.vector(${config.embeddingDimensions}) NOT NULL
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_index_metadata (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        schema_version integer NOT NULL,
        embedding_dimensions integer NOT NULL,
        embedding_model text NOT NULL
      )
    `)

    const typeResult = await client.query(
      "SELECT format_type(atttypid, atttypmod) AS data_type FROM pg_attribute WHERE attrelid = to_regclass('rag_chunks') AND attname = 'embedding' AND NOT attisdropped",
    )
    const dataType = vectorTypeRowsSchema.parse(typeResult.rows)[0]?.data_type
    const physicalDimensions = dataType?.match(/^vector\((\d+)\)$/)?.[1]
    if (Number(physicalDimensions) !== config.embeddingDimensions) {
      throw new IndexCompatibilityError(config, null)
    }

    const metadata = await client.query(
      "SELECT schema_version, embedding_dimensions, embedding_model FROM rag_index_metadata WHERE singleton = true",
    )
    const existing = indexMetadataRowsSchema.parse(metadata.rows)[0]
    if (!existing) {
      const count = await client.query("SELECT count(*) FROM rag_chunks")
      const countRow = countRowsSchema.parse(count.rows)[0]
      if (Number(countRow?.count ?? 0) > 0) {
        throw new IndexCompatibilityError(config, null)
      }
      await client.query(
        "INSERT INTO rag_index_metadata (singleton, schema_version, embedding_dimensions, embedding_model) VALUES (true, $1, $2, $3)",
        [SCHEMA_VERSION, config.embeddingDimensions, embeddingModel],
      )
    } else if (
      existing.schema_version !== SCHEMA_VERSION ||
      existing.embedding_dimensions !== config.embeddingDimensions ||
      existing.embedding_model !== embeddingModel
    ) {
      throw new IndexCompatibilityError(
        { ...config, embeddingModel },
        {
          embeddingDimensions: existing.embedding_dimensions,
          embeddingModel: existing.embedding_model,
        },
      )
    }

    const repoIdColumnResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('rag_chunks') AND attname = 'repo_id' AND NOT attisdropped) AS exists",
    )
    if (!columnRowsSchema.parse(repoIdColumnResult.rows)[0]?.exists) {
      await client.query("ALTER TABLE rag_chunks ADD COLUMN repo_id text NOT NULL DEFAULT 'legacy'")
      await client.query("ALTER TABLE rag_chunks ALTER COLUMN repo_id DROP DEFAULT")
    }

    const indexResult = await client.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'rag_chunks_source_idx'",
    )
    const indexDefinition = indexDefinitionRowsSchema.parse(indexResult.rows)[0]?.indexdef
    if (
      indexDefinition &&
      !indexDefinition.includes("(repo_id, source_type, source_key, chunk_index)")
    ) {
      await client.query("DROP INDEX rag_chunks_source_idx")
    }
    await client.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_source_idx ON rag_chunks (repo_id, source_type, source_key, chunk_index)",
    )
    await client.query(
      "CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw ON rag_chunks USING hnsw (embedding vector_cosine_ops)",
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
