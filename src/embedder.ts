import { type EmbeddingContext, getLlama } from "node-llama-cpp"

let contextPromise: Promise<EmbeddingContext> | null = null

async function getEmbeddingContext(modelPath: string): Promise<EmbeddingContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const llama = await getLlama()
      const model = await llama.loadModel({ modelPath })
      return model.createEmbeddingContext()
    })()
  }
  return contextPromise
}

export async function embedTexts(modelPath: string, inputs: string[]): Promise<number[][]> {
  const context = await getEmbeddingContext(modelPath)
  const results: Array<{ vector: number[] }> = await Promise.all(
    inputs.map((text) => context.getEmbeddingFor(text)),
  )
  return results.map((result) => result.vector)
}
