import { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, "invalid_request", msg);
export const notFound = (msg = "not found") => new HttpError(404, "not_found", msg);
export const forbidden = (msg = "forbidden") => new HttpError(403, "forbidden", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "internal server error" });
}
