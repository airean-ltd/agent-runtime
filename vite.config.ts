import { defineConfig } from "vite-plus";

// Vite+ runs the format and lint check (`vp check`). The build stays `tsc`,
// and the tests stay `vitest`.
export default defineConfig({
  fmt: {},
  lint: {
    // `pnpm typecheck` checks types, once per tsconfig; the linter only reads them.
    options: { typeAware: true },
  },
});
