import { type Plugin, tool } from "@opencode-ai/plugin"

import { resolveConfig } from "./config.js"
import { indexSources } from "./indexer/index.js"
import { getRepoId, projectCardGet, projectCardRefresh, projectCardSave } from "./project-card.js"
import { type SearchResult, searchRag } from "./search.js"

const z = tool.schema

type IndexArgs = {
  files: boolean
  docs: boolean
  web: boolean
  confirm: boolean
}

type SearchArgs = {
  query: string
  topK: number
  sourceTypes?: Array<"files" | "docs" | "web">
}

export const RagPlugin: Plugin = async (input) => {
  const config = resolveConfig({}, process.env, input.worktree)
  const repoId = await getRepoId(input.worktree)

  return {
    tool: {
      rag_index: tool({
        description: "Index local files, docs, and web pages into pgvector.",
        args: {
          files: z.boolean().optional().default(true),
          docs: z.boolean().optional().default(true),
          web: z.boolean().optional().default(true),
          confirm: z.boolean().optional().default(false),
        },
        execute: async (args: IndexArgs) => {
          if (!args.confirm) {
            return "Indexing requires confirmation. Re-run with confirm=true."
          }
          const total = await indexSources(config, repoId, args)
          return `Indexed ${total} chunks.`
        },
      }),
      rag_search: tool({
        description: "Search the local RAG index for relevant context.",
        args: {
          query: z.string(),
          topK: z.number().int().min(1).max(20).optional().default(5),
          sourceTypes: z.array(z.enum(["files", "docs", "web"])).optional(),
        },
        execute: async (args: SearchArgs) => {
          const results = await searchRag(
            config.postgresUrl,
            repoId,
            config.embeddingModel,
            args.query,
            args.topK,
            config.similarityThreshold,
            args.sourceTypes,
          )
          const formatted = results
            .map((result: SearchResult, index: number) => {
              const title = result.title ? ` - ${result.title}` : ""
              return `${index + 1}. [${result.sourceType}] ${result.sourceKey}${title}\n${result.content}`
            })
            .join("\n\n")
          return formatted || "No results found."
        },
      }),
      project_card_save: tool({
        description: "Save the repo project card to local cache and Postgres.",
        args: {
          content: z.string(),
        },
        execute: async (args: { content: string }) => {
          try {
            return await projectCardSave(config.postgresUrl, args.content, input.worktree)
          } catch (error) {
            return error instanceof Error ? error.message : "Failed to save project card."
          }
        },
      }),
      project_card_get: tool({
        description: "Get the repo project card from cache or Postgres.",
        args: {},
        execute: async () => {
          return projectCardGet(config.postgresUrl, input.worktree)
        },
      }),
      project_card_refresh: tool({
        description: "Refresh the local project card cache from Postgres.",
        args: {},
        execute: async () => {
          return projectCardRefresh(config.postgresUrl, input.worktree)
        },
      }),
    },
  }
}
