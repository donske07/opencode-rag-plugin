import * as cheerio from "cheerio"
import type { Element } from "domhandler"
import ky from "ky"

import { chunkText } from "../text.js"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type WebChunk = {
  readonly sourceKey: string
  readonly title: string | null
  readonly chunkIndex: number
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export type WebCrawlOptions = {
  readonly startUrls: readonly string[]
  readonly allowlistHosts: readonly string[]
  readonly maxPages: number
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
}

type FetchedPage = {
  readonly url: URL
  readonly contentType: string
  readonly body: string
}

export async function crawlWeb(options: WebCrawlOptions): Promise<WebChunk[]> {
  const allowlist = new Set(options.allowlistHosts.map((hostname) => hostname.toLowerCase()))
  const queue = options.startUrls
    .map((url) => toAllowedUrl(url, allowlist))
    .filter((url): url is URL => url !== null)
  const visited = new Set<string>()
  const indexed = new Set<string>()
  const results: WebChunk[] = []

  while (queue.length > 0 && visited.size < options.maxPages) {
    const nextUrl = queue.shift()
    if (!nextUrl) continue
    const normalizedUrl = nextUrl.toString()
    if (visited.has(normalizedUrl)) continue

    visited.add(normalizedUrl)
    const page = await fetchPage(nextUrl, allowlist, options)
    if (!page) continue
    const canonicalUrl = page.url.toString()
    if (indexed.has(canonicalUrl)) continue
    indexed.add(canonicalUrl)

    const extracted = extractPage(page)
    const chunks = chunkText(extracted.text, options.chunkSize, options.chunkOverlap)
    chunks.forEach((content, chunkIndex) => {
      results.push({
        sourceKey: page.url.toString(),
        title: extracted.title,
        chunkIndex,
        content,
        metadata: { url: page.url.toString(), title: extracted.title },
      })
    })

    for (const link of extracted.links) {
      if (visited.size + queue.length >= options.maxPages) break
      const resolved = toAllowedUrl(link, allowlist, page.url)
      if (!resolved) continue
      const resolvedUrl = resolved.toString()
      if (!visited.has(resolvedUrl) && !queue.some((queued) => queued.toString() === resolvedUrl)) {
        queue.push(resolved)
      }
    }
  }

  return results
}

async function fetchPage(
  initialUrl: URL,
  allowlist: ReadonlySet<string>,
  options: WebCrawlOptions,
): Promise<FetchedPage | null> {
  let currentUrl = initialUrl

  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    const signal = AbortSignal.timeout(options.requestTimeoutMs)
    const response = await ky
      .get(currentUrl, {
        redirect: "manual",
        retry: 0,
        throwHttpErrors: false,
        signal,
        timeout: false,
      })
      .catch((error: unknown) => {
        if (isRequestTimeout(error)) return null
        throw error
      })
    if (!response) return null

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location || redirectCount === options.maxRedirects) return null
      const redirectUrl = toAllowedUrl(location, allowlist, currentUrl)
      if (!redirectUrl) return null
      currentUrl = redirectUrl
      continue
    }

    if (!response.ok) return null
    const body = await readBoundedBody(response, options.maxResponseBytes).catch(
      (error: unknown) => {
        if (isRequestTimeout(error)) return null
        throw error
      },
    )
    if (body === null) return null
    return {
      url: currentUrl,
      contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
      body,
    }
  }

  return null
}

function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = response.headers.get("content-length")
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel()
    return null
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const result = await reader.read()
    if (result.done) break
    totalBytes += result.value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function extractPage(page: FetchedPage): {
  readonly title: string | null
  readonly text: string
  readonly links: readonly string[]
} {
  if (page.contentType.startsWith("text/plain")) {
    return { title: null, text: page.body.trim(), links: [] }
  }
  if (
    page.contentType &&
    !page.contentType.startsWith("text/html") &&
    !page.contentType.startsWith("application/xhtml+xml")
  ) {
    return { title: null, text: "", links: [] }
  }

  const document = cheerio.load(page.body)
  const title = document("title").first().text().trim() || null
  const text = document("body").text().replace(/\s+/g, " ").trim()
  const links = document("a[href]")
    .map((_index: number, element: Element) => document(element).attr("href"))
    .get()
    .filter((link): link is string => Boolean(link))
  return { title, text, links }
}

function toAllowedUrl(input: string, allowlist: ReadonlySet<string>, base?: URL): URL | null {
  try {
    const url = base ? new URL(input, base) : new URL(input)
    if (!["http:", "https:"].includes(url.protocol)) return null
    if (url.username || url.password) return null
    if (!allowlist.has(url.hostname.toLowerCase())) return null
    url.hash = ""
    return url
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}
