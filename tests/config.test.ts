import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveConfig } from "../src/config"

const RAG_ENVIRONMENT_KEYS = [
  "RAG_POSTGRES_URL",
  "RAG_EMBEDDING_MODEL",
  "RAG_EMBEDDING_DIMENSIONS",
  "RAG_CHUNK_SIZE",
  "RAG_CHUNK_OVERLAP",
  "RAG_SIMILARITY_THRESHOLD",
  "RAG_MAX_FILE_BYTES",
  "RAG_FILE_ROOTS",
  "RAG_DOCS_ROOTS",
  "RAG_WEB_URLS",
  "RAG_WEB_ALLOWLIST",
  "RAG_WEB_MAX_PAGES",
  "RAG_WEB_REQUEST_TIMEOUT_MS",
  "RAG_WEB_MAX_RESPONSE_BYTES",
  "RAG_WEB_MAX_REDIRECTS",
] as const

afterEach(() => {
  vi.unstubAllEnvs()
})

function clearRagEnvironment(): void {
  for (const key of RAG_ENVIRONMENT_KEYS) {
    vi.stubEnv(key, "")
  }
}

describe("resolveConfig", () => {
  it("uses bounded defaults when environment configuration is absent", () => {
    // Given
    clearRagEnvironment()

    // When
    const config = resolveConfig()

    // Then
    expect(config.chunkSize).toBe(500)
    expect(config.chunkOverlap).toBe(75)
    expect(config.maxFileBytes).toBe(2 * 1024 * 1024)
    expect(config.web).toEqual({
      startUrls: [],
      allowlistHosts: [],
      maxPages: 100,
      requestTimeoutMs: 10_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
    })
  })

  it("rejects overlap that is not smaller than the chunk size", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_CHUNK_SIZE", "100")
    vi.stubEnv("RAG_CHUNK_OVERLAP", "100")

    // When / Then
    expect(() => resolveConfig()).toThrow(/overlap/i)
  })

  it("requires an explicit hostname allowlist for web indexing", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_WEB_URLS", "https://docs.example.com/start")

    // When / Then
    expect(() => resolveConfig()).toThrow(/allowlist/i)
  })

  it("rejects non-http web start URLs", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_WEB_URLS", "file:///etc/passwd")
    vi.stubEnv("RAG_WEB_ALLOWLIST", "localhost")

    // When / Then
    expect(() => resolveConfig()).toThrow(/http/i)
  })

  it("rejects invalid numeric environment values instead of producing NaN", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_WEB_MAX_PAGES", "many")

    // When / Then
    expect(() => resolveConfig()).toThrow(/maxPages|number/i)
  })

  it("resolves relative source and model paths from the supplied worktree", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_FILE_ROOTS", "./src")
    vi.stubEnv("RAG_DOCS_ROOTS", "docs")
    vi.stubEnv("RAG_EMBEDDING_MODEL", "models/embed.gguf")

    // When
    const config = resolveConfig({}, process.env, "/workspace/project")

    // Then
    expect(config.fileRoots).toEqual(["/workspace/project/src"])
    expect(config.docsRoots).toEqual(["/workspace/project/docs"])
    expect(config.embeddingModel).toBe("/workspace/project/models/embed.gguf")
  })

  it("rejects dimensions above the pgvector HNSW limit", () => {
    // Given
    clearRagEnvironment()
    vi.stubEnv("RAG_EMBEDDING_DIMENSIONS", "2001")

    // When / Then
    expect(() => resolveConfig()).toThrow(/2000|embeddingDimensions/i)
  })
})
