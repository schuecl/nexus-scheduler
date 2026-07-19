import { z } from "zod";

// Job attachments (#109) — uploaded as base64 JSON rather than
// multipart so the API keeps its single body format and zod validation
// path, with no new middleware dependency. 15MB decoded cap: inline
// bytea storage is the dev-scale choice, and a scan at 300dpi fits
// comfortably.
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Per-job quotas: the per-request cap alone would let one job accumulate
// unbounded inline bytea rows (and make a single run OCR an unbounded
// batch). Both are enforced at upload time in the route.
export const MAX_ATTACHMENTS_PER_JOB = 10;
export const MAX_JOB_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

const ALLOWED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/webp",
] as const;

export const createAttachmentSchema = z.object({
  // No control characters: the filename is echoed into artifact names
  // and Content-Disposition headers, where CR/LF would make setHeader
  // throw (making an artifact undownloadable) or split the header.
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "filename must not contain control characters"),
  mimeType: z.enum(ALLOWED_MIME),
  // Validated as base64 here; decoded size is enforced in the route
  // (decoding is where the true size is known). Without validation,
  // Node's forgiving decoder would silently turn malformed input into
  // corrupted bytes. NOT zod's .base64(): its nested-quantifier regex
  // overflows V8's stack on multi-megabyte payloads (hit live with a
  // 5.7MB upload). Linear charset regex + length arithmetic instead:
  // padded input must be a multiple of 4; unpadded input is valid for
  // any length except ≡1 (mod 4), which no byte sequence encodes to.
  dataBase64: z
    .string()
    .min(1)
    .refine((s) => {
      const m = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(s);
      if (!m) return false;
      const body = m[1] ?? "";
      const pad = m[2] ?? "";
      return pad ? (body.length + pad.length) % 4 === 0 : body.length % 4 !== 1;
    }, "must be base64"),
});
export type CreateAttachmentInput = z.infer<typeof createAttachmentSchema>;
