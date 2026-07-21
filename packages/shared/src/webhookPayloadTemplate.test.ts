import { describe, expect, it } from "vitest";
import {
  renderWebhookPayloadTemplate,
  validateWebhookPayloadTemplateJson,
  WebhookTemplateJsonError,
  type WebhookTemplateContext,
} from "./webhookPayloadTemplate.js";

const CONTEXT: WebhookTemplateContext = {
  runId: "r-1",
  jobId: "j-1",
  jobName: "Nightly Report",
  status: "SUCCESS",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  output: "all good",
  errorMessage: null,
};

// issue #224: custom JSON payload templates.
describe("renderWebhookPayloadTemplate", () => {
  it("substitutes every known placeholder", () => {
    const template =
      '{"run":"{{run_id}}","job":"{{job_id}}","name":"{{job_name}}","status":"{{status}}",' +
      '"started":"{{started_at}}","completed":"{{completed_at}}","output":"{{output}}","error":"{{error_message}}"}';
    const rendered = renderWebhookPayloadTemplate(template, CONTEXT);
    expect(JSON.parse(rendered)).toEqual({
      run: "r-1",
      job: "j-1",
      name: "Nightly Report",
      status: "SUCCESS",
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:05.000Z",
      output: "all good",
      error: "",
    });
  });

  it("leaves an unrecognized placeholder untouched, same as notificationTemplate.ts", () => {
    const rendered = renderWebhookPayloadTemplate('{"x": "{{not_a_real_field}}"}', CONTEXT);
    expect(rendered).toBe('{"x": "{{not_a_real_field}}"}');
  });

  it("JSON-escapes a value containing quotes and a newline instead of breaking the JSON structure", () => {
    const context: WebhookTemplateContext = {
      ...CONTEXT,
      output: 'line one\nhas "quotes" in it',
    };
    const rendered = renderWebhookPayloadTemplate('{"output": "{{output}}"}', context);
    expect(JSON.parse(rendered)).toEqual({ output: 'line one\nhas "quotes" in it' });
  });

  it("does not let run output smuggle extra JSON keys into the body", () => {
    // The classic template-injection shape: if substitution were a raw
    // string replace instead of JSON-escaped, this output would close
    // the "output" string early and inject a sibling "admin": true key.
    const context: WebhookTemplateContext = { ...CONTEXT, output: '", "admin": true, "x": "' };
    const rendered = renderWebhookPayloadTemplate('{"output": "{{output}}"}', context);
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["output"]);
    expect(parsed.output).toBe('", "admin": true, "x": "');
  });

  it("renders null as an empty string, same convention as notificationTemplate.ts", () => {
    const rendered = renderWebhookPayloadTemplate('{"error": "{{error_message}}"}', CONTEXT);
    expect(JSON.parse(rendered)).toEqual({ error: "" });
  });
});

describe("validateWebhookPayloadTemplateJson", () => {
  it("accepts a template that renders to well-formed JSON", () => {
    expect(() => validateWebhookPayloadTemplateJson('{"status": "{{status}}"}')).not.toThrow();
  });

  it("rejects a template that is not valid JSON at all", () => {
    expect(() => validateWebhookPayloadTemplateJson("not json")).toThrow(WebhookTemplateJsonError);
  });

  it("rejects a template where a placeholder was left unquoted (author error)", () => {
    // {{status}} substitutes to the bare word SUCCESS, which without
    // surrounding quotes is not a valid JSON value.
    expect(() => validateWebhookPayloadTemplateJson('{"status": {{status}}}')).toThrow(WebhookTemplateJsonError);
  });
});
