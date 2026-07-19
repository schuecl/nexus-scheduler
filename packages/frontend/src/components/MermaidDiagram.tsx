import { useEffect, useRef, useState } from "react";
import { Box, useTheme } from "@mui/material";

// Renders a ```mermaid fence from KB content as an SVG diagram.
// mermaid is bundled at build time (air-gapped deployments — nothing is
// fetched at runtime) but imported lazily here so its weight loads only
// when a page actually shows a diagram, not on every route. If
// rendering fails (bad diagram source, or an environment without full
// DOM measurement, e.g. jsdom in tests), the raw source is shown in a
// <pre> instead — degraded but never blank.
let renderCounter = 0;

export function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme.palette.mode === "dark" ? "dark" : "neutral",
          fontFamily: theme.typography.fontFamily,
        });
        renderCounter += 1;
        const { svg: rendered } = await mermaid.render(`kb-mermaid-${renderCounter}`, source);
        if (!disposed) setSvg(rendered);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [source, theme.palette.mode, theme.typography.fontFamily]);

  if (failed) {
    return (
      <Box component="pre" sx={{ overflow: "auto" }}>
        <code>{source}</code>
      </Box>
    );
  }
  if (!svg) {
    return null;
  }
  return (
    <Box
      ref={containerRef}
      sx={{ "& svg": { maxWidth: "100%", height: "auto" }, my: 1 }}
      // mermaid.render output with securityLevel "strict" — mermaid
      // sanitizes the diagram source itself, and KB content is bundled
      // static text, not user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
