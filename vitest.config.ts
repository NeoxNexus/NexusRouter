import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/integration/**", // Exclude old integration tests that reference removed modules
    ],
  },
});
