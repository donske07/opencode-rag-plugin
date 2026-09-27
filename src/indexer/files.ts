import { promises as fs } from "node:fs"
import path from "node:path"

import { chunkText } from "../text.js"

const DOCUMENT_EXTENSIONS = [".json", ".markdown", ".md", ".rst", ".txt", ".yaml", ".yml"] as const

const SOURCE_EXTENSIONS = [
  ...DOCUMENT_EXTENSIONS,
  ".bash",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".zsh",
] as const

const IGNORED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "models",
  "node_modules",
  "target",
  "vendor",
])

const BLOCKED_FILENAMES = new Set([
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
])

const BLOCKED_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"])

export type FileChunk = {
  readonly sourceKey: string
  readonly title: string | null
  readonly chunkIndex: number
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export type FileCollectionOptions = {
  readonly roots: readonly string[]
  readonly sourceKind: "files" | "docs"
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly maxFileBytes: number
}

export async function collectFileChunks(options: FileCollectionOptions): Promise<FileChunk[]> {
  const extensions = new Set(
    options.sourceKind === "files" ? SOURCE_EXTENSIONS : DOCUMENT_EXTENSIONS,
  )
  const chunks: FileChunk[] = []
  const seenFiles = new Set<string>()

  for (const root of options.roots) {
    const absoluteRoot = path.resolve(root)
    const files = await walkDirectory(absoluteRoot)

    for (const file of files) {
      if (seenFiles.has(file)) continue
      seenFiles.add(file)
      if (!isIndexableFile(file, extensions)) continue
      const stats = await fs.stat(file)
      if (stats.size > options.maxFileBytes) continue
      const content = await fs.readFile(file, "utf-8")
      const documentChunks = chunkText(content, options.chunkSize, options.chunkOverlap)
      documentChunks.forEach((chunk, chunkIndex) => {
        chunks.push({
          sourceKey: file,
          title: path.basename(file),
          chunkIndex,
          content: chunk,
          metadata: { root: absoluteRoot, path: file },
        })
      })
    }
  }

  return chunks
}

async function walkDirectory(root: string): Promise<readonly string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue
      files.push(...(await walkDirectory(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

function isIndexableFile(file: string, extensions: ReadonlySet<string>): boolean {
  const basename = path.basename(file).toLowerCase()
  if (basename === ".env" || basename.startsWith(".env.")) return false
  if (BLOCKED_FILENAMES.has(basename)) return false
  const extension = path.extname(basename)
  return extensions.has(extension) && !BLOCKED_EXTENSIONS.has(extension)
}
