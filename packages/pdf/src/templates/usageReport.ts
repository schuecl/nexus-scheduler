import { escapeHtml } from "../escapeHtml.js";
import { barChart, pieChart, type ChartRow } from "../charts.js";
import { buildBannerTemplate, type ClassificationBannerInfo } from "./banner.js";
import { renderHtmlToPdf } from "../renderer.js";

export interface UsageReportData {
  productName: string;
  primaryColor: string;
  banner: ClassificationBannerInfo;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  runCounts: Partial<Record<"PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED", number>>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: string | null; // null when no runs in the period had a computed cost
}

function statTile(label: string, value: string): string {
  return `<div style="display:inline-block;min-width:140px;margin:0 16px 16px 0;padding:12px 16px;border:1px solid #ddd;border-radius:6px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:#666;">${escapeHtml(label)}</div>
    <div style="font-size:22px;font-weight:700;">${escapeHtml(value)}</div>
  </div>`;
}

// §8/§2.5: the same run-counts/success-failure-rate/token-usage/cost
// summary the §8 dashboard shows, as a static, shareable PDF snapshot —
// either downloaded on demand or emailed on the admin-configured
// recurring cadence (see the Worker's usageReportScheduler.ts). Every
// interpolated value here is either server-computed (counts, sums,
// dates) or admin-set branding text — no user/agent-generated content
// appears in this report, but everything still goes through
// escapeHtml() defensively/consistently with the run report template.
export function buildUsageReportHtml(data: UsageReportData): string {
  const total = Object.values(data.runCounts).reduce((sum, n) => sum + n, 0);
  const successRate = total > 0 ? Math.round(((data.runCounts.SUCCESS ?? 0) / total) * 100) : null;

  const statusRows = (
    Object.entries(data.runCounts) as Array<[string, number | undefined]>
  )
    .filter(([, count]) => (count ?? 0) > 0)
    .map(
      ([status, count]) =>
        `<tr><td style="padding:4px 12px 4px 0;">${escapeHtml(status)}</td><td style="padding:4px 0;font-weight:600;">${count}</td></tr>`,
    )
    .join("");
  const runChartRows: ChartRow[] = (
    Object.entries(data.runCounts) as Array<[string, number | undefined]>
  )
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([status, count]) => ({ label: status, value: count ?? 0 }));
  const tokenChartRows: ChartRow[] = [
    { label: "Prompt", value: data.totalPromptTokens },
    { label: "Completion", value: data.totalCompletionTokens },
  ];

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; }
      h1 { font-size: 20px; margin: 0 0 4px 0; color: ${escapeHtml(data.primaryColor)}; }
      .subtitle { color: #666; margin-bottom: 20px; }
      table { border-collapse: collapse; margin-bottom: 8px; }
      .section-title { font-size: 13px; font-weight: 700; margin: 24px 0 8px 0; }
      .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; break-inside: avoid; }
      .chart-card { border: 1px solid #ddd; border-radius: 6px; padding: 8px; break-inside: avoid; }
      .chart-card svg { display: block; width: 100%; height: auto; }
      .chart-title { font-size: 10px; font-weight: 700; color: #444; margin: 0 0 4px 2px; }
      .token-chart { width: calc(50% - 6px); }
      .report-section { break-inside: avoid; }
    </style>
  </head>
  <body>
    <div class="subtitle">${escapeHtml(data.productName)} — Usage Report</div>
    <h1>${escapeHtml(data.periodStart)} – ${escapeHtml(data.periodEnd)}</h1>
    <div class="subtitle">Generated ${escapeHtml(data.generatedAt)}</div>

    <div>
      ${statTile("Total Runs", String(total))}
      ${statTile("Success Rate", successRate === null ? "—" : `${successRate}%`)}
      ${statTile("Prompt Tokens", data.totalPromptTokens.toLocaleString())}
      ${statTile("Completion Tokens", data.totalCompletionTokens.toLocaleString())}
      ${statTile("Total Cost", data.totalCost === null ? "not costed" : `$${Number(data.totalCost).toFixed(2)}`)}
    </div>

    <div class="section-title">Runs by Status</div>
    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-title">Run Count</div>
        ${barChart(runChartRows, data.primaryColor, "Run count by status")}
      </div>
      <div class="chart-card">
        <div class="chart-title">Run Share</div>
        ${pieChart(runChartRows, data.primaryColor, "Share of runs by status")}
      </div>
    </div>
    <table>${statusRows || `<tr><td>No runs in this period.</td></tr>`}</table>

    <div class="report-section">
      <div class="section-title">Token Usage</div>
      <div class="chart-card token-chart">
        <div class="chart-title">Prompt vs Completion Tokens</div>
        ${pieChart(tokenChartRows, data.primaryColor, "Prompt versus completion token share")}
      </div>
    </div>
  </body>
</html>`;
}

export async function renderUsageReportPdf(data: UsageReportData): Promise<Buffer> {
  const bannerTemplate = buildBannerTemplate(data.banner);
  return renderHtmlToPdf(buildUsageReportHtml(data), {
    headerTemplate: bannerTemplate,
    footerTemplate: bannerTemplate,
  });
}
