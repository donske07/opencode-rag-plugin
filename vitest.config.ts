import { defineConfig } from "vitest/config"

export const testConfig = defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
  },
})

export default testConfig
