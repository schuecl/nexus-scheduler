// @testing-library/jest-dom's own `vitest.d.ts` augments the `vitest`
// module type it resolves from *its own* location in node_modules —
// which, in this npm workspace, is the root-hoisted vitest (still
// v3.x, pinned by the other workspace packages), not the v4.x nested
// under packages/frontend/node_modules that vite 8 requires here. That
// makes `expect(...).toBeInTheDocument()` etc. type-check against the
// wrong `Assertion` interface. Redeclaring the same augmentation from a
// file inside this workspace resolves `vitest` against the correct,
// locally-nested v4.x instead.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
