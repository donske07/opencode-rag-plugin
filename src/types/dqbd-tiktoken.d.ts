declare module "@dqbd/tiktoken" {
  export type Tiktoken = {
    encode(input: string): number[]
    decode(tokens: number[]): string
  }

  export function get_encoding(name: string): Tiktoken
}
