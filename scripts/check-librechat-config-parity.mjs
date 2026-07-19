#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function configuredPath(envName, fallback) {
  const configured = process.env[envName];
  if (!configured) return resolve(repoRoot, fallback);
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
}

const composePath = configuredPath(
  "COMPOSE_LIBRECHAT_CONFIG",
  "docker/librechat/librechat.yaml",
);
const chartTemplatePath = configuredPath(
  "CHART_LIBRECHAT_TEMPLATE",
  "helm/test-ai/templates/librechat.yaml",
);
const chartValuesPath = configuredPath(
  "CHART_VALUES",
  "helm/test-ai/values.yaml",
);

const optionalInputs = [composePath, chartTemplatePath];
const absent = optionalInputs.filter((path) => !existsSync(path));
if (absent.length > 0) {
  console.log(
    `LibreChat config parity: skipped because ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} absent.`,
  );
  process.exit(0);
}

if (!existsSync(chartValuesPath)) {
  console.error(
    `LibreChat config parity: chart template exists but its values file is absent: ${chartValuesPath}`,
  );
  process.exit(1);
}

const compose = readFileSync(composePath, "utf8");
const chartTemplate = readFileSync(chartTemplatePath, "utf8");
const chartValues = readFileSync(chartValuesPath, "utf8");

function scalarAt(source, path) {
  const parents = [];

  for (const line of source.split(/\r?\n/u)) {
    const match = /^(\s*)([A-Za-z0-9_.-]+):(?:\s*(.*))?$/u.exec(line);
    if (!match) continue;

    const indent = match[1].length;
    while (parents.length > 0 && parents.at(-1).indent >= indent) {
      parents.pop();
    }

    const currentPath = [...parents.map((entry) => entry.key), match[2]];
    const rawValue = (match[3] ?? "").trim();
    if (currentPath.join(".") === path.join(".")) {
      if (!rawValue) return null;
      if (
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        return rawValue.slice(1, -1);
      }
      return rawValue;
    }

    if (!rawValue) parents.push({ indent, key: match[2] });
  }

  return null;
}

const failures = [];

function requireScalar(source, path, label) {
  const value = scalarAt(source, path);
  if (value === null) {
    failures.push(`${label} does not declare ${path.join(".")}`);
  }
  return value;
}

const composeStrategy = requireScalar(compose, ["ocr", "strategy"], "Compose config");
const chartStrategy = requireScalar(chartTemplate, ["ocr", "strategy"], "Chart config template");
if (composeStrategy !== null && chartStrategy !== null && composeStrategy !== chartStrategy) {
  failures.push(
    `ocr.strategy differs (Compose: ${composeStrategy}; chart: ${chartStrategy})`,
  );
}

const limits = ["fileLimit", "fileSizeLimit", "totalSizeLimit"];
for (const limit of limits) {
  const composeValue = requireScalar(
    compose,
    ["fileConfig", "endpoints", "default", limit],
    "Compose config",
  );
  const chartValue = requireScalar(
    chartValues,
    ["librechat", "fileConfig", limit],
    "Chart values",
  );
  const chartReference = requireScalar(
    chartTemplate,
    ["fileConfig", "endpoints", "default", limit],
    "Chart config template",
  );
  const expectedReference = `{{ int .Values.librechat.fileConfig.${limit} }}`;

  if (chartReference !== null && chartReference !== expectedReference) {
    failures.push(
      `chart fileConfig.${limit} must render ${expectedReference}, found ${chartReference}`,
    );
  }
  if (composeValue !== null && chartValue !== null && composeValue !== chartValue) {
    failures.push(
      `${limit} differs (Compose: ${composeValue}; chart: ${chartValue})`,
    );
  }
}

if (failures.length > 0) {
  console.error("LibreChat config parity failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `LibreChat config parity OK: ocr.strategy=${composeStrategy}; ` +
    limits
      .map(
        (limit) =>
          `${limit}=${scalarAt(compose, ["fileConfig", "endpoints", "default", limit])}`,
      )
      .join("; "),
);
