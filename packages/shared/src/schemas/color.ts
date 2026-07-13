import { z } from "zod";

// Branding/banner/badge colors get interpolated into inline style="..."
// attributes (web banner, PDF templates) — HTML-escaping isn't enough in
// that context, since a value like "red;background-image:url(...)" is
// valid CSS injected as extra declarations, not an HTML metacharacter.
// Restricting to hex and rgb()/rgba() (every real color-picker output)
// closes that off at the schema level rather than trying to CSS-escape
// arbitrary input at every render site. Named colors are deliberately
// excluded — matching the full CSS color-name list invites the same
// injection to slip through as an "unrecognized" name falling through.
const CSS_COLOR_PATTERN =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

export const cssColorSchema = z
  .string()
  .regex(CSS_COLOR_PATTERN, "must be a hex color (#rgb, #rrggbb, #rrggbbaa) or rgb()/rgba()");
