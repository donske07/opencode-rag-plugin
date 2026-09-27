import { constants, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { projectCardGet, readProjectCardCache, writeProjectCardCache } from "../src/project-card"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  )
})

describe("writeProjectCardCache", () => {
  it("rejects a symlinked cache file without changing its target", async () => {
    // Given
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rag-card-"))
    temporaryRoots.push(root)
    const cacheDir = path.join(root, ".opencode")
    const target = path.join(root, "outside.md")
    await fs.mkdir(cacheDir)
    await fs.writeFile(target, "protected", { mode: constants.S_IRUSR | constants.S_IWUSR })
    await fs.symlink(target, path.join(cacheDir, "project-card.md"))

    // When / Then
    await expect(writeProjectCardCache(root, "replacement")).rejects.toThrow(/symbolic link/i)
    await expect(fs.readFile(target, "utf8")).resolves.toBe("protected")
  })

  it("does not read through a symlinked cache file", async () => {
    // Given
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rag-card-"))
    temporaryRoots.push(root)
    const cacheDir = path.join(root, ".opencode")
    const target = path.join(root, "outside.md")
    await fs.mkdir(cacheDir)
    await fs.writeFile(target, "private")
    await fs.symlink(target, path.join(cacheDir, "project-card.md"))

    // When
    const content = await readProjectCardCache(root)

    // Then
    expect(content).toBe("")
  })

  it("does not read through a symlinked cache directory", async () => {
    // Given
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rag-card-"))
    temporaryRoots.push(root)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rag-card-outside-"))
    temporaryRoots.push(outside)
    await fs.writeFile(path.join(outside, "project-card.md"), "private")
    await fs.symlink(outside, path.join(root, ".opencode"))

    // When
    const content = await readProjectCardCache(root)

    // Then
    expect(content).toBe("")
  })

  it("returns a safe local cache without connecting to PostgreSQL", async () => {
    // Given
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rag-card-"))
    temporaryRoots.push(root)
    await writeProjectCardCache(root, "cached project context")

    // When
    const content = await projectCardGet("postgres://127.0.0.1:1/unreachable", root)

    // Then
    expect(content).toBe("cached project context")
  })
})
