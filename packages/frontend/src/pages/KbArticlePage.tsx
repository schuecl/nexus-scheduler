import { Link as RouterLink, useParams } from "react-router-dom";
import { Breadcrumbs, Chip, Stack, Typography } from "@mui/material";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { findKbArticle } from "../help/kbContent";
import { MarkdownContent } from "../components/MarkdownContent";
import { SystemStatusGraph } from "../components/SystemStatusGraph";

export function KbArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  const article = slug ? findKbArticle(slug) : undefined;

  if (!article) {
    return (
      <Stack spacing={2}>
        <Typography variant="h4">Article not found</Typography>
        <Typography color="text.secondary">
          That Knowledge Base article doesn't exist.{" "}
          <RouterLink to="/help">Back to the Knowledge Base</RouterLink>.
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Breadcrumbs>
        <RouterLink to="/help" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <MenuBookOutlinedIcon fontSize="small" /> Knowledge Base
        </RouterLink>
        <Typography color="text.secondary">{article.category}</Typography>
      </Breadcrumbs>

      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h4">{article.title}</Typography>
        <Chip size="small" label={article.category} />
      </Stack>

      {/* The KB's content model is otherwise 100% static bundled markdown
          (kbContent.ts) — this is the one article backed by live data,
          special-cased by slug rather than generalizing the whole
          content model for a single dynamic page. */}
      {article.slug === "architecture" && <SystemStatusGraph />}

      <MarkdownContent content={article.content} />
    </Stack>
  );
}
