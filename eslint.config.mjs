import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

// Focused, type-aware lint gate. The primary purpose is to catch the
// async-safety bug class (unhandled/misused promises — the category behind
// the "side-effect failure corrupts a Run's status" regression) via
// no-floating-promises / no-misused-promises, plus a lightweight security
// signal. Frontend (.tsx) and tests are out of scope for this initial gate
// and can be folded in as a follow-up.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/*.config.*",
      "**/*.test.ts",
      "packages/frontend/**",
      "packages/shared/prisma/**",
    ],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      security,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The core gate: an unhandled/dropped promise is the bug class behind
      // the "side-effect failure corrupts a Run's status" regression.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Full strength here (async callbacks as arguments ARE flagged): an
      // async callback passed where a void return is expected — e.g. a
      // setInterval / event-emitter callback — is a real unhandled-rejection
      // risk, not noise.
      "@typescript-eslint/no-misused-promises": "error",
      // Validates the existing `eslint-disable ... no-console` directives and
      // discourages stray console use; warnings don't fail the build.
      "no-console": "warn",
      "security/detect-child-process": "error",
    },
  },
  {
    // Narrow, deliberate exception: Express route/app registration files.
    // Async route handlers are idiomatic and handled by this project's error
    // path, so allow promise-returning callbacks as arguments HERE only —
    // rather than disabling the check everywhere, which would also hide risky
    // async callbacks (setInterval, emitters) in the rest of the code.
    files: [
      "packages/api/src/routes/**/*.ts",
      "packages/api/src/app.ts",
      "packages/pdf-service/src/app.ts",
    ],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
);
