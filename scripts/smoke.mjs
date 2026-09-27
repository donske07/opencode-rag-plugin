import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { resolveConfig } from "../dist/config.js"
import { indexSources } from "../dist/indexer/index.js"
import { searchRag } from "../dist/search.js"

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "opencode-rag-smoke-"))

try {
  const token = `aurora-${randomUUID()}`
  await writeFile(
    path.join(fixtureRoot, "knowledge.md"),
    `# Smoke test\n\nThe verified retrieval token is ${token}.`,
  )
  const config = resolveConfig({ fileRoots: [fixtureRoot] })
  const repoId = `smoke-${randomUUID()}`
  const indexedChunks = await indexSources(config, repoId, {
    files: true,
    docs: false,
    web: false,
  })
  const results = await searchRag(
    config.postgresUrl,
    repoId,
    config.embeddingModel,
    token,
    3,
    config.similarityThreshold,
    ["files"],
  )
  if (!results.some((result) => result.content.includes(token))) {
    throw new Error("Smoke query did not retrieve the indexed fixture")
  }
  console.log(`Indexed ${indexedChunks} chunk and retrieved the current smoke token.`)
} finally {
  await rm(fixtureRoot, { force: true, recursive: true })
}
