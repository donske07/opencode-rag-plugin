import path from "node:path"
import { z } from "zod"

const BYTES_PER_MEBIBYTE = 1024 * 1024

const httpUrlSchema = z
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Web URLs must use http or https",
  })

const postgresUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return ["postgres:", "postgresql:"].includes(new URL(value).protocol)
      } catch (error) {
        if (error instanceof TypeError) return false
        throw error
      }
    },
    { message: "Postgres URL must use postgres or postgresql" },
  )

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase())
  .refine((value) => new URL(`http://${value}`).hostname === value, {
    message: "Allowlist entries must be hostnames without a scheme or path",
  })

const ragWebConfigSchema = z
  .object({
    startUrls: z.array(httpUrlSchema),
    allowlistHosts: z.array(hostnameSchema),
    maxPages: z.number().int().min(1).max(1_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(20 * BYTES_PER_MEBIBYTE),
    maxRedirects: z.number().int().min(0).max(10),
  })
  .superRefine((config, context) => {
    if (config.startUrls.length > 0 && config.allowlistHosts.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Web indexing requires an explicit hostname allowlist",
        path: ["allowlistHosts"],
      })
      return
    }

    for (const startUrl of config.startUrls) {
      if (!config.allowlistHosts.includes(new URL(startUrl).hostname.toLowerCase())) {
        context.addIssue({
          code: "custom",
          message: "Every web start URL hostname must be in the allowlist",
          path: ["startUrls"],
        })
      }
    }
  })

const ragConfigSchema = z
  .object({
    postgresUrl: postgresUrlSchema,
    embeddingModel: z.string().trim().min(1),
    embeddingDimensions: z.number().int().min(1).max(2_000),
    chunkSize: z.number().int().min(16).max(8_192),
    chunkOverlap: z.number().int().min(0).max(8_191),
    similarityThreshold: z.number().min(0).max(2),
    maxFileBytes: z
      .number()
      .int()
      .min(1_024)
      .max(100 * BYTES_PER_MEBIBYTE),
    fileRoots: z.array(z.string().trim().min(1)),
    docsRoots: z.array(z.string().trim().min(1)),
    web: ragWebConfigSchema,
  })
  .superRefine((config, context) => {
    if (config.chunkOverlap >= config.chunkSize) {
      context.addIssue({
        code: "custom",
        message: "Chunk overlap must be smaller than chunk size",
        path: ["chunkOverlap"],
      })
    }
  })

export type RagWebConfig = Readonly<z.infer<typeof ragWebConfigSchema>>
export type RagConfig = Readonly<z.infer<typeof ragConfigSchema>>

export type RagConfigInput = Readonly<
  Partial<Omit<RagConfig, "web">> & {
    readonly web?: Partial<RagWebConfig>
  }
>

const DEFAULTS = {
  postgresUrl: "postgres://localhost:5432/postgres",
  embeddingModel: "./models/bge-small-en-v1.5-q8_0.gguf",
  embeddingDimensions: 384,
  chunkSize: 500,
  chunkOverlap: 75,
  similarityThreshold: 0.3,
  maxFileBytes: 2 * BYTES_PER_MEBIBYTE,
  fileRoots: [],
  docsRoots: [],
  web: {
    startUrls: [],
    allowlistHosts: [],
    maxPages: 100,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 2 * BYTES_PER_MEBIBYTE,
    maxRedirects: 3,
  },
} satisfies RagConfig

export function resolveConfig(
  input: RagConfigInput = {},
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory: string = process.cwd(),
): RagConfig {
  const webInput = input.web
  const config = ragConfigSchema.parse({
    postgresUrl:
      input.postgresUrl ??
      parseOptionalString(environment["RAG_POSTGRES_URL"]) ??
      DEFAULTS.postgresUrl,
    embeddingModel:
      input.embeddingModel ??
      parseOptionalString(environment["RAG_EMBEDDING_MODEL"]) ??
      DEFAULTS.embeddingModel,
    embeddingDimensions:
      input.embeddingDimensions ??
      parseOptionalNumber(environment["RAG_EMBEDDING_DIMENSIONS"]) ??
      DEFAULTS.embeddingDimensions,
    chunkSize:
      input.chunkSize ?? parseOptionalNumber(environment["RAG_CHUNK_SIZE"]) ?? DEFAULTS.chunkSize,
    chunkOverlap:
      input.chunkOverlap ??
      parseOptionalNumber(environment["RAG_CHUNK_OVERLAP"]) ??
      DEFAULTS.chunkOverlap,
    similarityThreshold:
      input.similarityThreshold ??
      parseOptionalNumber(environment["RAG_SIMILARITY_THRESHOLD"]) ??
      DEFAULTS.similarityThreshold,
    maxFileBytes:
      input.maxFileBytes ??
      parseOptionalNumber(environment["RAG_MAX_FILE_BYTES"]) ??
      DEFAULTS.maxFileBytes,
    fileRoots: input.fileRoots ?? parseCsv(environment["RAG_FILE_ROOTS"]) ?? DEFAULTS.fileRoots,
    docsRoots: input.docsRoots ?? parseCsv(environment["RAG_DOCS_ROOTS"]) ?? DEFAULTS.docsRoots,
    web: {
      startUrls:
        webInput?.startUrls ?? parseCsv(environment["RAG_WEB_URLS"]) ?? DEFAULTS.web.startUrls,
      allowlistHosts:
        webInput?.allowlistHosts ??
        parseCsv(environment["RAG_WEB_ALLOWLIST"]) ??
        DEFAULTS.web.allowlistHosts,
      maxPages:
        webInput?.maxPages ??
        parseOptionalNumber(environment["RAG_WEB_MAX_PAGES"]) ??
        DEFAULTS.web.maxPages,
      requestTimeoutMs:
        webInput?.requestTimeoutMs ??
        parseOptionalNumber(environment["RAG_WEB_REQUEST_TIMEOUT_MS"]) ??
        DEFAULTS.web.requestTimeoutMs,
      maxResponseBytes:
        webInput?.maxResponseBytes ??
        parseOptionalNumber(environment["RAG_WEB_MAX_RESPONSE_BYTES"]) ??
        DEFAULTS.web.maxResponseBytes,
      maxRedirects:
        webInput?.maxRedirects ??
        parseOptionalNumber(environment["RAG_WEB_MAX_REDIRECTS"]) ??
        DEFAULTS.web.maxRedirects,
    },
  })
  return {
    ...config,
    embeddingModel: resolvePath(baseDirectory, config.embeddingModel),
    fileRoots: config.fileRoots.map((root) => resolvePath(baseDirectory, root)),
    docsRoots: config.docsRoots.map((root) => resolvePath(baseDirectory, root)),
  }
}

function resolvePath(baseDirectory: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(baseDirectory, candidate)
}

function parseCsv(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  return Number(value)
}

function parseOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
