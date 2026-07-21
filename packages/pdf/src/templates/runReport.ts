import { escapeHtml } from "../escapeHtml.js";
import { renderMarkdownToSafeHtml } from "../markdown.js";
import { buildBannerTemplate, type ClassificationBannerInfo } from "./banner.js";
import { renderHtmlToPdf } from "../renderer.js";

export interface RunReportClassification {
  text: string;
  badgeBgColor: string;
  badgeTextColor: string;
}

export interface RunReportData {
  productName: string;
  primaryColor: string;
  // null when the admin has the classification banner disabled (issue
  // #228) — the report then carries no header/footer banner at all,
  // same as the web UI showing none.
  banner: ClassificationBannerInfo | null;
  classification: RunReportClassification | null;
  jobName: string;
  runId: string;
  triggerType: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  computedCost: string | null;
  output: string | null;
  errorMessage: string | null;
}

function row(label: string, value: string): string {
  return `<tr><th style="text-align:left;padding:4px 12px 4px 0;color:#555;font-weight:600;white-space:nowrap;">${escapeHtml(
    label,
  )}</th><td style="padding:4px 0;">${value}</td></tr>`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZoneName: "short" });
}

// Builds the report body (not the header/footer banner — that's applied
// separately via Playwright's page.pdf() headerTemplate/footerTemplate,
// see renderRunReportPdf below). Every field here is either
// server-generated (IDs, timestamps, status enums) or admin/user text
// that must be HTML-escaped before interpolation — output and
// errorMessage in particular come from the LibreChat agent and are
// treated as fully untrusted. output is rendered as markdown (models
// like to format their answers with it) via renderMarkdownToSafeHtml,
// which sanitizes the result instead of escaping it outright;
// errorMessage stays plain-escaped text since it's a system-generated
// string, not model output.
export function buildRunReportHtml(data: RunReportData): string {
  const classificationBadge = data.classification
    ? `<div style="display:inline-block;margin-bottom:16px;padding:4px 10px;border-radius:3px;font-weight:700;font-size:11px;background-color:${escapeHtml(
        data.classification.badgeBgColor,
      )};color:${escapeHtml(data.classification.badgeTextColor)};">${escapeHtml(data.classification.text)}</div>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; }
      h1 { font-size: 18px; margin: 0 0 4px 0; color: ${escapeHtml(data.primaryColor)}; }
      .subtitle { color: #666; margin-bottom: 16px; }
      table { border-collapse: collapse; margin-bottom: 20px; }
      pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; border-radius: 4px; padding: 12px; font-size: 11px; }
      .error { background: #fdecea; border: 1px solid #f5c6cb; color: #611a15; border-radius: 4px; padding: 12px; white-space: pre-wrap; word-break: break-word; }
      .section-title { font-size: 13px; font-weight: 700; margin: 20px 0 8px 0; }
      .markdown-body { font-size: 12px; }
      .markdown-body > *:first-child { margin-top: 0; }
      .markdown-body > *:last-child { margin-bottom: 0; }
      .markdown-body pre { margin: 8px 0; }
      .markdown-body pre code { background: none; padding: 0; }
      .markdown-body code { background: #f5f5f5; border-radius: 3px; padding: 1px 4px; font-size: 11px; }
      .markdown-body table { width: 100%; border-collapse: collapse; margin: 8px 0; }
      .markdown-body th, .markdown-body td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
      .markdown-body blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
    </style>
  </head>
  <body>
    ${classificationBadge}
    <div class="subtitle">${escapeHtml(data.productName)} — Run Report</div>
    <h1>${escapeHtml(data.jobName)}</h1>
    <table>
      ${row("Run ID", escapeHtml(data.runId))}
      ${row("Status", escapeHtml(data.status))}
      ${row("Trigger", escapeHtml(data.triggerType))}
      ${row("Created", escapeHtml(formatDate(data.createdAt)))}
      ${row("Started", escapeHtml(formatDate(data.startedAt)))}
      ${row("Completed", escapeHtml(formatDate(data.completedAt)))}
      ${
        data.promptTokens != null || data.completionTokens != null
          ? row("Tokens", escapeHtml(`${data.promptTokens ?? 0} prompt / ${data.completionTokens ?? 0} completion`))
          : ""
      }
      ${data.computedCost != null ? row("Cost", escapeHtml(`$${Number(data.computedCost).toFixed(4)}`)) : ""}
    </table>
    ${
      data.errorMessage
        ? `<div class="section-title">Error</div><div class="error">${escapeHtml(data.errorMessage)}</div>`
        : ""
    }
    ${
      data.output
        ? `<div class="section-title">Output</div><div class="markdown-body">${renderMarkdownToSafeHtml(data.output)}</div>`
        : ""
    }
  </body>
</html>`;
}

// Convenience wrapper: builds the run report HTML and applies the
// classification banner as the PDF's header/footer in one call.
export async function renderRunReportPdf(data: RunReportData): Promise<Buffer> {
  const bannerTemplate = data.banner ? buildBannerTemplate(data.banner) : undefined;
  return renderHtmlToPdf(buildRunReportHtml(data), {
    headerTemplate: bannerTemplate,
    footerTemplate: bannerTemplate,
  });
}
