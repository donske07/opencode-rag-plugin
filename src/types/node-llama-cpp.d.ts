declare module "node-llama-cpp" {
  export type EmbeddingResult = { vector: number[] }

  export type EmbeddingContext = {
    getEmbeddingFor(input: string): Promise<EmbeddingResult>
  }

  export type LlamaModel = {
    createEmbeddingContext(): Promise<EmbeddingContext>
  }

  export type Llama = {
    loadModel(input: { modelPath: string }): Promise<LlamaModel>
  }

  export function getLlama(): Promise<Llama>
}
