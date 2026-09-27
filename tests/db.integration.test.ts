import { randomUUID } from "node:crypto"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type RagChunkRecord, replaceChunks } from "../src/db"
import { ensureSchema } from "../src/schema"

const postgresUrl = process.env.RAG_TEST_POSTGRES_URL
const describeWithPostgres = postgresUrl ? describe : describe.skip

describeWithPostgres("replaceChunks integration", () => {
  const schema = `rag_test_${randomUUID().replaceAll("-", "")}`
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: postgresUrl })
    await client.connect()
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}, public`)
    await ensureSchema(client, {
      embeddingDimensions: 3,
      embeddingModel: "./models/test-model.gguf",
    })
  })

  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
    await client.end()
  })

  it("preserves old chunks when replacement insertion fails", async () => {
    // Given
    const source = { repoId: "repo-a", sourceType: "docs", sourceKey: "/docs/example.md" } as const
    const oldChunks: readonly RagChunkRecord[] = [
      {
        ...source,
        chunkIndex: 0,
        title: "example.md",
        content: "old content",
        metadata: {},
        embedding: [1, 0, 0],
      },
    ]
    await replaceChunks(client, source, oldChunks)
    const invalidChunks: readonly RagChunkRecord[] = [
      {
        ...source,
        chunkIndex: 0,
        title: "example.md",
        content: "new content",
        metadata: {},
        embedding: [1, 0],
      },
    ]

    // When / Then
    await expect(replaceChunks(client, source, invalidChunks)).rejects.toThrow()
    const result = await client.query<{ content: string }>(
      "SELECT content FROM rag_chunks WHERE source_type = $1 AND source_key = $2",
      [source.sourceType, source.sourceKey],
    )
    expect(result.rows).toEqual([{ content: "old content" }])
  })

  it("rejects incompatible embedding configuration without changing indexed data", async () => {
    // Given
    const source = {
      repoId: "repo-a",
      sourceType: "docs",
      sourceKey: "/docs/compatibility.md",
    } as const
    await replaceChunks(client, source, [
      {
        ...source,
        chunkIndex: 0,
        title: "compatibility.md",
        content: "compatible content",
        metadata: {},
        embedding: [1, 0, 0],
      },
    ])

    // When / Then
    await expect(
      ensureSchema(client, {
        embeddingDimensions: 4,
        embeddingModel: "./models/other-model.gguf",
      }),
    ).rejects.toThrow(/incompatible/i)
    const result = await client.query<{ content: string }>(
      "SELECT content FROM rag_chunks WHERE source_type = $1 AND source_key = $2",
      [source.sourceType, source.sourceKey],
    )
    expect(result.rows).toEqual([{ content: "compatible content" }])
  })

  it("publishes one complete replacement when two writers race", async () => {
    // Given
    const source = { repoId: "repo-a", sourceType: "docs", sourceKey: "/docs/race.md" } as const
    const makeChunks = (prefix: string): readonly RagChunkRecord[] =>
      [0, 1].map((chunkIndex) => ({
        ...source,
        chunkIndex,
        title: "race.md",
        content: `${prefix}-${chunkIndex}`,
        metadata: {},
        embedding: [1, chunkIndex, 0],
      }))
    const secondClient = new Client({ connectionString: postgresUrl })
    await secondClient.connect()
    await secondClient.query(`SET search_path TO ${schema}, public`)

    // When
    await Promise.all([
      replaceChunks(client, source, makeChunks("alpha")),
      replaceChunks(secondClient, source, makeChunks("beta")),
    ])
    await secondClient.end()

    // Then
    const result = await client.query<{ content: string }>(
      "SELECT content FROM rag_chunks WHERE source_type = $1 AND source_key = $2 ORDER BY chunk_index",
      [source.sourceType, source.sourceKey],
    )
    expect([
      ["alpha-0", "alpha-1"],
      ["beta-0", "beta-1"],
    ]).toContainEqual(result.rows.map((row) => row.content))
  })

  it("keeps identical source keys isolated between repositories", async () => {
    // Given
    const sourceKey = "/docs/shared.md"
    const makeChunk = (repoId: string, content: string): RagChunkRecord => ({
      repoId,
      sourceType: "docs",
      sourceKey,
      chunkIndex: 0,
      title: "shared.md",
      content,
      metadata: {},
      embedding: [1, 0, 0],
    })

    // When
    await replaceChunks(client, { repoId: "repo-a", sourceType: "docs", sourceKey }, [
      makeChunk("repo-a", "alpha"),
    ])
    await replaceChunks(client, { repoId: "repo-b", sourceType: "docs", sourceKey }, [
      makeChunk("repo-b", "beta"),
    ])

    // Then
    const result = await client.query<{ repo_id: string; content: string }>(
      "SELECT repo_id, content FROM rag_chunks WHERE source_key = $1 ORDER BY repo_id",
      [sourceKey],
    )
    expect(result.rows).toEqual([
      { repo_id: "repo-a", content: "alpha" },
      { repo_id: "repo-b", content: "beta" },
    ])
  })

  it("serializes concurrent schema initialization", async () => {
    // Given
    const concurrentSchema = `rag_concurrent_${randomUUID().replaceAll("-", "")}`
    await client.query(`CREATE SCHEMA ${concurrentSchema}`)
    const clients = await Promise.all(
      [0, 1].map(async () => {
        const connection = new Client({ connectionString: postgresUrl })
        await connection.connect()
        await connection.query(`SET search_path TO ${concurrentSchema}, public`)
        return connection
      }),
    )

    // When
    await Promise.all(
      clients.map((connection) =>
        ensureSchema(connection, {
          embeddingDimensions: 3,
          embeddingModel: "./models/concurrent.gguf",
        }),
      ),
    )

    // Then
    const result = await clients[0]?.query<{ count: string }>(
      "SELECT count(*) FROM rag_index_metadata",
    )
    expect(result?.rows).toEqual([{ count: "1" }])
    await Promise.all(clients.map((connection) => connection.end()))
    await client.query(`DROP SCHEMA ${concurrentSchema} CASCADE`)
  })

  it("rejects an empty legacy table with a different physical vector dimension", async () => {
    // Given
    const legacySchema = `rag_legacy_${randomUUID().replaceAll("-", "")}`
    await client.query(`CREATE SCHEMA ${legacySchema}`)
    await client.query(`SET search_path TO ${legacySchema}, public`)
    await client.query("CREATE TABLE rag_chunks (embedding vector(3) NOT NULL)")

    // When / Then
    await expect(
      ensureSchema(client, {
        embeddingDimensions: 4,
        embeddingModel: "./models/legacy.gguf",
      }),
    ).rejects.toThrow(/incompatible/i)
    await client.query(`DROP SCHEMA ${legacySchema} CASCADE`)
    await client.query(`SET search_path TO ${schema}, public`)
  })

  it("migrates an empty legacy source index to include repository identity", async () => {
    // Given
    const legacySchema = `rag_legacy_index_${randomUUID().replaceAll("-", "")}`
    await client.query(`CREATE SCHEMA ${legacySchema}`)
    await client.query(`SET search_path TO ${legacySchema}, public`)
    await client.query(`
      CREATE TABLE rag_chunks (
        id bigserial PRIMARY KEY,
        source_type text NOT NULL,
        source_key text NOT NULL,
        chunk_index integer NOT NULL,
        title text,
        content text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        embedding public.vector(3) NOT NULL
      )
    `)
    await client.query(
      "CREATE UNIQUE INDEX rag_chunks_source_idx ON rag_chunks (source_type, source_key, chunk_index)",
    )

    // When
    await ensureSchema(client, {
      embeddingDimensions: 3,
      embeddingModel: "./models/legacy-index.gguf",
    })

    // Then
    const result = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'rag_chunks_source_idx'",
    )
    expect(result.rows[0]?.indexdef).toContain("(repo_id, source_type, source_key, chunk_index)")
    await client.query(`DROP SCHEMA ${legacySchema} CASCADE`)
    await client.query(`SET search_path TO ${schema}, public`)
  })
})
