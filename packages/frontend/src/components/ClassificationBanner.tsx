import { Box, Typography } from "@mui/material";
import type { ClassificationBannerConfig } from "../branding";

// Fixed, non-scrolling banner — REQUIREMENTS.md §6. Rendered identically
// top and bottom by AppLayout; this component only knows how to draw
// one bar, not where it sits.
export function ClassificationBanner({ config }: { config: ClassificationBannerConfig }) {
  return (
    <Box
      sx={{
        width: "100%",
        py: 0.5,
        textAlign: "center",
        backgroundColor: config.backgroundColor,
        color: config.textColor,
        position: "sticky",
        zIndex: (theme) => theme.zIndex.appBar + 1,
      }}
    >
      <Typography variant="body2" fontWeight={700} component="span">
        {config.text}
      </Typography>
    </Box>
  );
}
