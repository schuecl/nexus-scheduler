import { createTheme } from "@mui/material/styles";
import type { BrandingConfig } from "./branding";
import type { ColorMode } from "./context/ColorModeContext";

// Rebuilt from admin-configured branding (§5) rather than hardcoded, so
// theme changes don't require a rebuild/redeploy. `mode` is a separate,
// per-user display preference (ColorModeContext) — MUI's own light/dark
// palette defaults (background, text, divider colors, etc.) apply
// automatically from `mode` without needing to hand-tune each one here.
export function buildTheme(branding: BrandingConfig, mode: ColorMode) {
  return createTheme({
    palette: {
      mode,
      primary: { main: branding.primaryColor },
    },
    shape: { borderRadius: 8 },
    components: {
      // Sentence case reads less shouty than MUI's all-caps default and
      // matches most current dashboard UI conventions — purely a look
      // change, no behavior difference.
      MuiButton: {
        styleOverrides: {
          root: { textTransform: "none", fontWeight: 600 },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: { backgroundImage: "none" },
        },
      },
    },
  });
}
