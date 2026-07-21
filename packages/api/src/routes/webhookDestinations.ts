import { randomUUID } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import {
  createWebhookDestinationSchema,
  updateWebhookDestinationSchema,
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
  signWebhookPayload,
  buildWebhookDeliveryHeaders,
  renderWebhookPayloadTemplate,
  type WebhookPayload,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";
import type { AppConfig } from "../config.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

// What a non-admin is allowed to see. A Job owner picks a destination
// from this list, and that needs a name and a URL — nothing else. In
// particular NOT `headers`, which holds the receiving system's auth
// token (see webhookHeadersSchema): handing that to every authenticated
// session, VIEW role included, leaks a third party's credential.
const PICKER_SELECT = {
  id: true,
  name: true,
  url: true,
  active: true,
} as const;

// The allow-list management view. Admin-only routes return this.
const LIST_SELECT = {
  ...PICKER_SELECT,
  headers: true,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  notifyOnCancelled: true,
  signPayload: true,
  customPayloadEnabled: true,
  payloadTemplate: true,
  createdAt: true,
} as const;

function isNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// customPayloadEnabled implies a usable template — checked against the
// EFFECTIVE state (this request merged onto whatever's already saved),
// which is why it's a route-level check rather than living in the zod
// schema: PATCH is partial, so only the route handler (which has the
// existing row) can tell that "enable, with no template in this
// request" is fine when a template is already on file.
function effectivePayloadConfigIsValid(customPayloadEnabled: boolean, payloadTemplate: string | null): boolean {
  return !customPayloadEnabled || payloadTemplate !== null;
}

// The admin-maintained allow-list itself (REQUIREMENTS §2.2/§10) — a Job
// can only ever attach one of *these* rows, never an arbitrary URL, which
// is what keeps outbound delivery from becoming an SSRF/exfiltration path.
export function createWebhookDestinationsRouter(config: AppConfig): Router {
  const router = Router();

  // Any authenticated user can see *which destinations exist* (to pick
  // from when wiring up a Job's notifications) — but only active ones,
  // since a disabled destination shouldn't be attachable to a Job. An
  // admin managing the allow-list itself needs to see disabled rows too
  // (otherwise there'd be no way to re-enable or delete one — it would
  // just vanish from the one screen that manages it).
  router.get("/", requireAuth, asyncHandler(async (req, res) => {
    const isAdmin = req.session.user!.role === "ADMIN";
    const destinations = await prisma.webhookDestination.findMany({
      where: isAdmin ? undefined : { active: true },
      select: isAdmin ? LIST_SELECT : PICKER_SELECT,
      orderBy: { name: "asc" },
    });
    res.json(destinations);
  }));

  // The plaintext secret is only ever present in *this* response and in
  // POST /:id/rotate-secret's — the admin must copy it into the
  // receiver's config now, since it's never returned again afterward
  // (§27: previously there was no way for a receiver to ever learn it).
  router.post("/", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const parsed = createWebhookDestinationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    const customPayloadEnabled = parsed.data.customPayloadEnabled ?? false;
    if (!effectivePayloadConfigIsValid(customPayloadEnabled, parsed.data.payloadTemplate ?? null)) {
      res.status(400).json({ error: "customPayloadEnabled requires a payloadTemplate" });
      return;
    }

    const secret = generateWebhookSecret();
    const encryptedHmacSecret = encryptSecret(secret, config.API_KEY_ENCRYPTION_KEY);
    const destination = await prisma.webhookDestination.create({
      data: {
        name: parsed.data.name,
        url: parsed.data.url,
        encryptedHmacSecret,
        headers: parsed.data.headers,
        notifyOnSuccess: parsed.data.notifyOnSuccess,
        notifyOnFailure: parsed.data.notifyOnFailure,
        notifyOnCancelled: parsed.data.notifyOnCancelled,
        signPayload: parsed.data.signPayload,
        customPayloadEnabled: parsed.data.customPayloadEnabled,
        payloadTemplate: parsed.data.payloadTemplate,
      },
      select: LIST_SELECT,
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.create",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      category: "admin",
      result: "SUCCESS",
    });

    res.status(201).json({ ...destination, secret });
  }));

  router.patch("/:id", requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
    const parsed = updateWebhookDestinationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const existing = await prisma.webhookDestination.findUnique({ where: { id: req.params.id }, select: LIST_SELECT });
    if (!existing) {
      res.status(404).json({ error: "webhook destination not found" });
      return;
    }

    const effectiveCustomPayloadEnabled = parsed.data.customPayloadEnabled ?? existing.customPayloadEnabled;
    const effectivePayloadTemplate =
      parsed.data.payloadTemplate !== undefined ? parsed.data.payloadTemplate : existing.payloadTemplate;
    if (!effectivePayloadConfigIsValid(effectiveCustomPayloadEnabled, effectivePayloadTemplate)) {
      res.status(400).json({ error: "customPayloadEnabled requires a payloadTemplate" });
      return;
    }

    const { headers, ...rest } = parsed.data;
    let destination;
    try {
      destination = await prisma.webhookDestination.update({
        where: { id: req.params.id },
        // Prisma needs the explicit DbNull sentinel to clear a nullable
        // Json column to a real SQL NULL — a bare `null` in `data` fails
        // to typecheck (and, for JSON columns, means something
        // different: a stored JSON "null" value, not "no headers").
        data: { ...rest, ...(headers !== undefined ? { headers: headers ?? Prisma.DbNull } : {}) },
        select: LIST_SELECT,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "webhook destination not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.update",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      category: "admin",
      changes: diffChangedFields(existing, destination, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(destination);
  }));

  // Generates a fresh secret and returns it once — for a receiver that
  // lost its copy, or as routine hygiene. The old secret stops
  // validating signatures immediately; there's no overlap window.
  router.post("/:id/rotate-secret", requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
    const user = req.session.user!;
    const secret = generateWebhookSecret();
    const encryptedHmacSecret = encryptSecret(secret, config.API_KEY_ENCRYPTION_KEY);
    let destination;
    try {
      destination = await prisma.webhookDestination.update({
        where: { id: req.params.id },
        data: { encryptedHmacSecret },
        select: LIST_SELECT,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "webhook destination not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.rotate_secret",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      category: "admin",
      result: "SUCCESS",
    });

    res.json({ ...destination, secret });
  }));

  // Sends a signed sample payload for real (§27: previously the only
  // way to check a destination worked was to wait for a Job to actually
  // run) — same signing scheme as packages/worker/src/webhookDelivery.ts,
  // but a single attempt with immediate feedback instead of the run
  // pipeline's retry/audit posture, matching how /smtp/test and
  // /syslog/test behave elsewhere in this router family.
  router.post("/:id/test", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const destination = await prisma.webhookDestination.findUnique({ where: { id: req.params.id } });
    if (!destination) {
      res.status(404).json({ error: "webhook destination not found" });
      return;
    }

    const now = new Date();
    const payload: WebhookPayload = {
      runId: randomUUID(),
      jobId: randomUUID(),
      jobName: "Test Job",
      status: "SUCCESS",
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      output: "This is a test webhook delivery from Nexus Scheduler.",
      errorMessage: null,
    };
    // Test-send reflects the destination's actual configuration (issue
    // #224) rather than always sending the fixed sample shape, so
    // "Test" tells the admin what a real delivery will actually look
    // like. WebhookPayload and WebhookTemplateContext share the same
    // field names, so `payload` doubles as the template context as-is.
    const rawBody =
      destination.customPayloadEnabled && destination.payloadTemplate
        ? renderWebhookPayloadTemplate(destination.payloadTemplate, payload)
        : JSON.stringify(payload);
    const signature = destination.signPayload
      ? signWebhookPayload(rawBody, decryptSecret(destination.encryptedHmacSecret, config.API_KEY_ENCRYPTION_KEY))
      : null;

    try {
      const response = await fetch(destination.url, {
        method: "POST",
        headers: buildWebhookDeliveryHeaders(destination.headers, signature),
        body: rawBody,
        // Same reasoning as the worker's delivery path: following a
        // redirect would let the destination operator choose which host
        // receives the signed body and the receiver's auth header. A
        // 3xx arrives here as an ordinary non-ok response, so the
        // existing check reports it as a failed test-send — which is
        // what the admin needs to see.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`destination responded ${response.status}`);
      }
      await recordAuditEvent({
        req,
        actorType: "USER",
        actorId: user.id,
        actorEmail: user.email,
        action: "webhook_destination.test",
        targetType: "webhook",
        targetId: destination.id,
        targetName: destination.name,
        category: "admin",
        result: "SUCCESS",
      });
      res.status(204).send();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "unknown delivery error";
      await recordAuditEvent({
        req,
        actorType: "USER",
        actorId: user.id,
        actorEmail: user.email,
        action: "webhook_destination.test",
        targetType: "webhook",
        targetId: destination.id,
        targetName: destination.name,
        category: "admin",
        result: "FAILURE",
        errorMessage,
      });
      res.status(502).json({ error: errorMessage });
    }
  }));

  // Hard delete — job_webhook_destinations cascades, so any Job that had
  // this destination attached just stops notifying it, same practical
  // effect as removing it from the allow-list would have anyway.
  router.delete("/:id", requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
    const user = req.session.user!;
    let destination;
    try {
      destination = await prisma.webhookDestination.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (isNotFoundError(err)) {
        res.status(404).json({ error: "webhook destination not found" });
        return;
      }
      next(err);
      return;
    }

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "webhook_destination.delete",
      targetType: "webhook",
      targetId: destination.id,
      targetName: destination.name,
      category: "admin",
      result: "SUCCESS",
    });

    res.status(204).send();
  }));

  return router;
}
