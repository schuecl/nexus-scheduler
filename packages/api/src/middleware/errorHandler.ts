import type { ErrorRequestHandler } from "express";
import type { Logger } from "../logger.js";

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    logger.error({ err, path: req.path }, "unhandled request error");
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: "internal server error" });
  };
}
