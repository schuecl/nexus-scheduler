import { describe, expect, it } from "vitest";
import { computeNotificationRecipients } from "./notifications.js";

// issue #219: mailing lists expand to their raw addresses alongside the
// Job owner and ccRecipients — pure logic, no database or SMTP server
// needed to verify it.
describe("computeNotificationRecipients", () => {
  it("includes just the owner when there are no extra recipients", () => {
    const job = { createdBy: { email: "owner@example.test" }, ccRecipients: [], mailingListLinks: [] };
    expect(computeNotificationRecipients(job)).toEqual(["owner@example.test"]);
  });

  it("includes ccRecipients and every attached mailing list's addresses", () => {
    const job = {
      createdBy: { email: "owner@example.test" },
      ccRecipients: ["cc1@example.test"],
      mailingListLinks: [
        { mailingList: { emails: ["a@example.test", "b@example.test"] } },
        { mailingList: { emails: ["c@example.test"] } },
      ],
    };
    expect(computeNotificationRecipients(job)).toEqual([
      "owner@example.test",
      "cc1@example.test",
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
  });

  it("deduplicates an address that appears in both ccRecipients and a mailing list", () => {
    const job = {
      createdBy: { email: "owner@example.test" },
      ccRecipients: ["shared@example.test"],
      mailingListLinks: [{ mailingList: { emails: ["shared@example.test", "other@example.test"] } }],
    };
    expect(computeNotificationRecipients(job)).toEqual(["owner@example.test", "shared@example.test", "other@example.test"]);
  });

  it("deduplicates an address that appears in two attached mailing lists", () => {
    const job = {
      createdBy: { email: "owner@example.test" },
      ccRecipients: [],
      mailingListLinks: [
        { mailingList: { emails: ["dup@example.test"] } },
        { mailingList: { emails: ["dup@example.test"] } },
      ],
    };
    expect(computeNotificationRecipients(job)).toEqual(["owner@example.test", "dup@example.test"]);
  });

  it("deduplicates the owner's own address if it also appears as a ccRecipient or list member", () => {
    const job = {
      createdBy: { email: "owner@example.test" },
      ccRecipients: ["owner@example.test"],
      mailingListLinks: [{ mailingList: { emails: ["owner@example.test"] } }],
    };
    expect(computeNotificationRecipients(job)).toEqual(["owner@example.test"]);
  });
});
