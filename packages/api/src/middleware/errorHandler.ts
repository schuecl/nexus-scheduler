import type { ErrorRequestHandler } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import type { Logger } from "../logger.js";

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      return;
    }
    // update()/delete() on a nonexistent row throws P2025 rather than
    // returning null the way findUnique does — several admin CRUD
    // routes (webhookDestinations, costRates, classificationLabels)
    // call update/delete straight from the route id with no existence
    // check first, so this reached here and fell through to a generic
    // 500 that masked what was actually a plain, expected 404.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(404).json({ error: "not found" });
      return;
    }
    logger.error({ err, path: req.path }, "unhandled request error");
    res.status(500).json({ error: "internal server error" });
  };
}
