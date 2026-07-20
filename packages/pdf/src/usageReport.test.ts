import { execFileSync, spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildUsageReportHtml,
  renderUsageReportPdf,
  type UsageReportData,
} from "./templates/usageReport.js";

const report: UsageReportData = {
  productName: "Nexus Scheduler",
  primaryColor: "#1565c0",
  banner: {
    text: "UNCLASSIFIED",
    backgroundColor: "#2e7d32",
    textColor: "#ffffff",
  },
  periodStart: "2026-07-01",
  periodEnd: "2026-07-19",
  generatedAt: "2026-07-19T12:00:00Z",
  runCounts: { SUCCESS: 12, FAILED: 3, CANCELLED: 1 },
  totalPromptTokens: 18_250,
  totalCompletionTokens: 4_750,
  totalCost: "4.25",
};

function decodedFlateStreams(pdf: Buffer): string {
  const source = pdf.toString("latin1");
  const streamPattern = /stream\r?\n/gu;
  const decoded: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = streamPattern.exec(source)) !== null) {
    const dictionaryWindow = source.slice(Math.max(0, match.index - 600), match.index);
    const endStream = source.indexOf("endstream", streamPattern.lastIndex);
    if (endStream === -1) break;

    if (/\/Filter\s*(?:\[\s*)?\/FlateDecode\b/u.test(dictionaryWindow)) {
      let dataEnd = endStream;
      while (
        dataEnd > streamPattern.lastIndex &&
        /[\r\n]/u.test(source.at(dataEnd - 1) ?? "")
      ) {
        dataEnd--;
      }
      try {
        decoded.push(inflateSync(pdf.subarray(streamPattern.lastIndex, dataEnd)).toString("latin1"));
      } catch {
        // Cross-reference and metadata streams are irrelevant here and
        // may use predictor settings. Content streams inflate directly.
      }
    }

    streamPattern.lastIndex = endStream + "endstream".length;
  }

  return decoded.join("\n");
}

function countPathOperators(pdf: Buffer): number {
  const streams = decodedFlateStreams(pdf);
  return (streams.match(/(?:^|\s)(?:m|l|c|v|y|h|re|S|s|f|f\*|B|B\*|b|b\*)(?=\s)/gmu) ?? [])
    .length;
}

describe("usage report charts", () => {
  it("keeps the status table and adds run and token SVG charts", () => {
    const html = buildUsageReportHtml(report);

    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html).toContain("Runs by Status");
    expect(html).toContain("Run Count");
    expect(html).toContain("Run Share");
    expect(html).toContain("Prompt vs Completion Tokens");
    expect(html).toContain("<table>");
    expect(html).toContain("SUCCESS");
  });

  it("renders zero-run and zero-token periods without invalid SVG values", () => {
    const html = buildUsageReportHtml({
      ...report,
      runCounts: {},
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    });

    expect(html).toContain("No runs in this period.");
    expect(html).toContain("No data in this period.");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  const renderRequired = process.env.PDF_VECTOR_RENDER_REQUIRED === "true";
  const renderTest = renderRequired ? it : it.skip;

  renderTest("renders charts into the PDF as vector paths, never image XObjects", async () => {
    const pdftotextAvailable = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).error == null;
    expect(pdftotextAvailable, "pdftotext is required for the vector render assertion").toBe(true);

    const pdf = await renderUsageReportPdf(report);
    const imageObjects = pdf.toString("latin1").match(/\/Subtype\s*\/Image\b/gu) ?? [];
    const extractedText = execFileSync("pdftotext", ["-", "-"], {
      encoding: "utf8",
      input: pdf,
    });

    expect(imageObjects).toHaveLength(0);
    expect(countPathOperators(pdf)).toBeGreaterThan(0);
    expect(extractedText).toContain("SUCCESS");
    expect(extractedText).toContain("Prompt");
    expect(extractedText).toContain("Completion");
  }, 60_000);
});
