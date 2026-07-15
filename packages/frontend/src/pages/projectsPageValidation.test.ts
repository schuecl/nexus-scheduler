import { describe, expect, it } from "vitest";
import { isValidJobTiming, missingJobPrerequisite, type JobFormValues } from "./ProjectsPage";

const COMPLETE_FORM: JobFormValues = {
  name: "Nightly report",
  promptId: "p1",
  agentId: "a1",
  apiKeyId: "k1",
  timeoutSeconds: 300,
  maxRetries: 2,
};

describe("isValidJobTiming", () => {
  it("rejects the cleared-field case: Number('') === 0 is not a valid timeout", () => {
    // Clearing the TextField feeds Number("") = 0 into form state — the
    // exact bug that used to slip a Job through with a 0-second timeout.
    expect(isValidJobTiming({ timeoutSeconds: Number(""), maxRetries: 2 }).timeoutSecondsValid).toBe(false);
  });

  it("rejects NaN from non-numeric input in both fields", () => {
    const timing = isValidJobTiming({ timeoutSeconds: Number("abc"), maxRetries: Number("x") });
    expect(timing.timeoutSecondsValid).toBe(false);
    expect(timing.maxRetriesValid).toBe(false);
  });

  it("accepts the documented bounds and rejects just outside them", () => {
    expect(isValidJobTiming({ timeoutSeconds: 1, maxRetries: 0 })).toEqual({
      timeoutSecondsValid: true,
      maxRetriesValid: true,
    });
    expect(isValidJobTiming({ timeoutSeconds: 3600, maxRetries: 5 })).toEqual({
      timeoutSecondsValid: true,
      maxRetriesValid: true,
    });
    expect(isValidJobTiming({ timeoutSeconds: 0, maxRetries: 2 }).timeoutSecondsValid).toBe(false);
    expect(isValidJobTiming({ timeoutSeconds: 3601, maxRetries: 2 }).timeoutSecondsValid).toBe(false);
    expect(isValidJobTiming({ timeoutSeconds: 300, maxRetries: -1 }).maxRetriesValid).toBe(false);
    expect(isValidJobTiming({ timeoutSeconds: 300, maxRetries: 6 }).maxRetriesValid).toBe(false);
  });

  it("rejects non-integer values", () => {
    expect(isValidJobTiming({ timeoutSeconds: 1.5, maxRetries: 2 }).timeoutSecondsValid).toBe(false);
    expect(isValidJobTiming({ timeoutSeconds: 300, maxRetries: 2.5 }).maxRetriesValid).toBe(false);
  });
});

describe("missingJobPrerequisite", () => {
  it("returns null for a complete, valid form", () => {
    expect(missingJobPrerequisite(COMPLETE_FORM)).toBeNull();
  });

  it("points at the next missing field in fill-in order", () => {
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, name: "" })).toBe("Name the Job.");
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, promptId: "" })).toBe("Choose a Prompt.");
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, apiKeyId: "" })).toMatch(/Select an API key/);
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, agentId: "" })).toMatch(/Select \(or enter\) an Agent/);
  });

  it("blocks submission when a numeric field was cleared (Number('') === 0)", () => {
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, timeoutSeconds: Number("") })).toBe(
      "Timeout must be 1–3600 seconds.",
    );
    expect(missingJobPrerequisite({ ...COMPLETE_FORM, maxRetries: Number("abc") })).toBe(
      "Max retries must be 0–5.",
    );
  });
});
