import { createServer, type Server } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import { crawlWeb } from "../src/indexer/web"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        }),
    ),
  )
})

async function listen(server: Server, hostname: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, hostname, resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new TypeError("Expected TCP server address")
  return address.port
}

function webOptions(startUrls: readonly string[], allowlistHosts: readonly string[]) {
  return {
    startUrls,
    allowlistHosts,
    maxPages: 5,
    chunkSize: 500,
    chunkOverlap: 75,
    requestTimeoutMs: 2_000,
    maxResponseBytes: 1_024,
    maxRedirects: 2,
  }
}

describe("crawlWeb", () => {
  it("does not follow redirects to a hostname outside the allowlist", async () => {
    // Given
    let disallowedRequests = 0
    const disallowed = createServer((_request, response) => {
      disallowedRequests += 1
      response.end("<html><body>private data</body></html>")
    })
    const disallowedPort = await listen(disallowed, "127.0.0.1")
    const allowed = createServer((_request, response) => {
      response.statusCode = 302
      response.setHeader("location", `http://127.0.0.1:${disallowedPort}/private`)
      response.end()
    })
    const allowedPort = await listen(allowed, "localhost")

    // When
    const chunks = await crawlWeb(
      webOptions([`http://localhost:${allowedPort}/start`], ["localhost"]),
    )

    // Then
    expect(chunks).toEqual([])
    expect(disallowedRequests).toBe(0)
  })

  it("rejects responses that exceed the configured byte limit", async () => {
    // Given
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html")
      response.end(`<html><body>${"x".repeat(2_000)}</body></html>`)
    })
    const port = await listen(server, "localhost")

    // When
    const chunks = await crawlWeb({
      ...webOptions([`http://localhost:${port}/large`], ["localhost"]),
      maxResponseBytes: 128,
    })

    // Then
    expect(chunks).toEqual([])
  })

  it("aborts a response body that stalls after headers", async () => {
    // Given
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain")
      response.write("partial")
    })
    const port = await listen(server, "localhost")

    // When
    const chunks = crawlWeb({
      ...webOptions([`http://localhost:${port}/stall`], ["localhost"]),
      requestTimeoutMs: 50,
    })

    // Then
    await expect(chunks).resolves.toEqual([])
  })

  it("ignores non-http URLs", async () => {
    // Given
    const options = webOptions(["file:///etc/passwd"], ["localhost"])

    // When
    const chunks = await crawlWeb(options)

    // Then
    expect(chunks).toEqual([])
  })

  it("indexes one canonical page when a start URL redirects to another start URL", async () => {
    // Given
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.statusCode = 302
        response.setHeader("location", "/canonical")
        response.end()
        return
      }
      response.setHeader("content-type", "text/plain")
      response.end("canonical content")
    })
    const port = await listen(server, "localhost")

    // When
    const chunks = await crawlWeb(
      webOptions(
        [`http://localhost:${port}/redirect`, `http://localhost:${port}/canonical`],
        ["localhost"],
      ),
    )

    // Then
    expect(chunks).toHaveLength(1)
  })
})
