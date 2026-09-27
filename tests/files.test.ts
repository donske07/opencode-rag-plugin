import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectFileChunks } from "../src/indexer/files"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-rag-files-"))
  temporaryRoots.push(root)
  return root
}

describe("collectFileChunks", () => {
  it("indexes source code and documentation while excluding generated and secret files", async () => {
    // Given
    const root = await createTemporaryRoot()
    await mkdir(path.join(root, "src"))
    await mkdir(path.join(root, "node_modules"))
    await writeFile(path.join(root, "src", "answer.ts"), "export const answer = 42\n")
    await writeFile(path.join(root, "README.md"), "# Project\n\nPublic documentation")
    await writeFile(path.join(root, ".env"), "API_KEY=secret")
    await writeFile(path.join(root, "node_modules", "ignored.ts"), "export const leaked = true")

    // When
    const chunks = await collectFileChunks({
      roots: [root],
      sourceKind: "files",
      chunkSize: 500,
      chunkOverlap: 75,
      maxFileBytes: 1024,
    })

    // Then
    expect(chunks.map((chunk) => path.basename(chunk.sourceKey)).sort()).toEqual([
      "README.md",
      "answer.ts",
    ])
  })

  it("skips files larger than the configured byte limit", async () => {
    // Given
    const root = await createTemporaryRoot()
    await writeFile(path.join(root, "large.md"), "0123456789")

    // When
    const chunks = await collectFileChunks({
      roots: [root],
      sourceKind: "docs",
      chunkSize: 500,
      chunkOverlap: 75,
      maxFileBytes: 8,
    })

    // Then
    expect(chunks).toEqual([])
  })

  it("indexes files once when configured roots overlap", async () => {
    // Given
    const root = await createTemporaryRoot()
    const nested = path.join(root, "docs")
    await mkdir(nested)
    await writeFile(path.join(nested, "guide.md"), "Unique guide content")

    // When
    const chunks = await collectFileChunks({
      roots: [root, nested],
      sourceKind: "docs",
      chunkSize: 500,
      chunkOverlap: 75,
      maxFileBytes: 1024,
    })

    // Then
    expect(chunks).toHaveLength(1)
  })
})
