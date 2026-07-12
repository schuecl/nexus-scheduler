import { createTheme } from "@mui/material/styles";
import type { BrandingConfig } from "./branding";

// Rebuilt from admin-configured branding (§5) rather than hardcoded, so
// theme changes don't require a rebuild/redeploy.
export function buildTheme(branding: BrandingConfig) {
  return createTheme({
    palette: {
      primary: { main: branding.primaryColor },
    },
  });
}
