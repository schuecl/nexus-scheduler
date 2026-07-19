// Loaded before the API and worker integration suites. Their fixtures reset
// every table in DATABASE_URL, so pointing either suite at a live deployment
// silently destroys real data (issue #151).
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    return "";
  }
}

export function looksLikeTestDatabase(name: string): boolean {
  // "test" anywhere (nexus_test, test, integration_tests), or the
  // single-purpose throwaway names CI and the disposable-container pattern
  // use ("ci", "t").
  return /test/i.test(name) || name === "ci" || name === "t";
}

const url = process.env.DATABASE_URL ?? "";
const name = databaseName(url);
if (url && !looksLikeTestDatabase(name) && process.env.NEXUS_UNSAFE_TEST_DB !== "1") {
  throw new Error(
    `Refusing to run: DATABASE_URL points at database "${name}", which does not look like a ` +
      `disposable test database (expected a name containing "test", or "ci"/"t"). ` +
      `These suites DELETE EVERY ROW in the database they run against. ` +
      `Use a throwaway instance (see TESTING.md), or set NEXUS_UNSAFE_TEST_DB=1 ` +
      `if you are absolutely sure.`,
  );
}
