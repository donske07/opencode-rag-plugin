import { execFile } from "node:child_process"
import crypto from "node:crypto"
import { constants, promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import { ensureProjectCardSchema, getProjectCard, upsertProjectCard, withClient } from "./db.js"

const execFileAsync = promisify(execFile)

const MAX_CONTENT_LENGTH = 20_000
const STALE_DAYS = 60
const CACHE_DIR = ".opencode"
const CACHE_FILE = "project-card.md"

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /xoxb-/,
  /ghp_/,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  /password\s*=/i,
  /secret\s*=/i,
  /api_key\s*=/i,
]

export async function projectCardSave(postgresUrl: string, content: string, root?: string) {
  const repoRoot = root ?? (await getRepoRoot())
  const repoId = await getRepoId(repoRoot)
  const normalized = normalizeContent(content)

  if (!normalized) {
    throw new Error("Project card content is empty.")
  }

  if (normalized.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Project card exceeds ${MAX_CONTENT_LENGTH} characters.`)
  }

  if (containsSecrets(normalized)) {
    throw new Error("Project card appears to contain secrets. Remove them before saving.")
  }

  const contentHash = sha256(normalized)

  await withClient(postgresUrl, async (client) => {
    await ensureProjectCardSchema(client)
    await upsertProjectCard(client, {
      repoId,
      content: normalized,
      source: path.join(CACHE_DIR, CACHE_FILE),
      contentHash,
    })
  })

  await writeProjectCardCache(repoRoot, normalized)

  return `Project card saved for ${repoId}.`
}

export async function projectCardGet(postgresUrl: string, root?: string) {
  const repoRoot = root ?? (await getRepoRoot())
  const repoId = await getRepoId(repoRoot)

  const cached = await readProjectCardCache(repoRoot)
  if (cached) return cached
  const record = await withClient(postgresUrl, async (client) => {
    await ensureProjectCardSchema(client)
    return getProjectCard(client, repoId)
  })

  if (!record?.content) {
    return ""
  }

  await writeProjectCardCache(repoRoot, record.content)
  const warning = isStale(record.last_confirmed)
    ? "\n\nWarning: project card is older than 60 days. Consider /project-card to refresh."
    : ""
  return `${record.content}${warning}`
}

export async function projectCardRefresh(postgresUrl: string, root?: string) {
  const repoRoot = root ?? (await getRepoRoot())
  const repoId = await getRepoId(repoRoot)

  const record = await withClient(postgresUrl, async (client) => {
    await ensureProjectCardSchema(client)
    return getProjectCard(client, repoId)
  })

  if (!record?.content) {
    return "No project card found for this repo."
  }

  await writeProjectCardCache(repoRoot, record.content)
  return "Project card refreshed."
}

export async function getRepoId(repoRoot?: string) {
  const root = repoRoot ?? (await getRepoRoot())
  const remote = await getGitRemote(root)
  if (remote) {
    return normalizeRemote(remote)
  }

  const hash = sha256(path.resolve(root))
  return `path:${hash}`
}

async function getRepoRoot() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
    })
    const root = stdout.trim()
    return root || process.cwd()
  } catch {
    return process.cwd()
  }
}

async function getGitRemote(repoRoot: string) {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function normalizeRemote(remote: string) {
  const trimmed = remote.trim()
  if (trimmed.startsWith("http")) {
    try {
      const url = new URL(trimmed)
      url.username = ""
      url.password = ""
      const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\.git$/, "")}`
      return normalized
    } catch {
      return trimmed.replace(/\.git$/, "")
    }
  }

  const sshMatch = trimmed.match(/^(?:git@|ssh:\/\/git@)([^:]+):(.+)$/)
  if (sshMatch) {
    const host = sshMatch[1]
    const repositoryPath = sshMatch[2]
    if (host && repositoryPath) return `${host}/${repositoryPath.replace(/\.git$/, "")}`
  }

  return trimmed.replace(/\.git$/, "")
}

function normalizeContent(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const trimmedLines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return trimmedLines
}

function containsSecrets(content: string) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content))
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function isStale(lastConfirmed: Date) {
  const ageMs = Date.now() - new Date(lastConfirmed).getTime()
  const maxMs = STALE_DAYS * 24 * 60 * 60 * 1000
  return ageMs > maxMs
}

function getCachePath(repoRoot: string) {
  return path.join(repoRoot, CACHE_DIR, CACHE_FILE)
}

export async function readProjectCardCache(repoRoot: string) {
  const cacheDir = path.join(repoRoot, CACHE_DIR)
  const cachePath = getCachePath(repoRoot)
  try {
    const cacheDirStats = await fs.lstat(cacheDir)
    if (cacheDirStats.isSymbolicLink()) return ""
    const stats = await fs.lstat(cachePath)
    if (stats.isSymbolicLink()) return ""
    return await fs.readFile(cachePath, "utf-8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

export async function writeProjectCardCache(repoRoot: string, content: string) {
  const dir = path.join(repoRoot, CACHE_DIR)
  const existingDir = await fs.lstat(dir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (existingDir?.isSymbolicLink())
    throw new Error("Project card cache directory is a symbolic link.")
  await fs.mkdir(dir, { recursive: true })
  const handle = await fs.open(
    getCachePath(repoRoot),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(content, "utf-8")
  } finally {
    await handle.close()
  }
}
