// Registers jest-dom's matchers (toBeInTheDocument, toBeDisabled, …)
// with vitest's expect. Not using the packaged `@testing-library/jest-dom/vitest`
// entry point: it does its own `import { expect } from "vitest"` from
// jest-dom's own install location, which in this npm workspace is
// root-hoisted (no other package needs jest-dom) and so resolves the
// *root's* vitest — still on v3.x for the other workspace packages —
// instead of this package's locally-nested v4.x, extending an `expect`
// instance the actual test run never sees. Importing `expect` directly
// from here resolves it relative to this file, i.e. the correct local
// vitest. TypeScript augmentation is redeclared the same way, in
// ./jest-dom-vitest.d.ts.
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
