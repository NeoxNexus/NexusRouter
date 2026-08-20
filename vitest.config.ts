import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sequential execution keeps timing-sensitive tests (hot-reload debounce,
    // performance regression gates, dashboard SSE lifecycle) stable on Windows
    // dev machines where concurrent file watchers and event-loop handles flake.
    fileParallelism: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/integration/**", // Exclude old integration tests that reference removed modules
    ],
  },
});
