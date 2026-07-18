import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Card,
  CardActionArea,
  CardContent,
  Grid,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { KB_ARTICLES, type KbArticle } from "../help/kbContent";

const CATEGORY_ORDER: KbArticle["category"][] = ["Getting Started", "Modules", "Admin", "Architecture", "Troubleshooting"];

// Knowledge Base index (§42) — every article is bundled into the SPA
// (see help/kbContent.ts), so this works fully offline and search is
// just a client-side substring match; there's no need for a search
// service at this content volume.
export function KnowledgeBasePage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return KB_ARTICLES;
    return KB_ARTICLES.filter(
      (a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q) || a.content.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <MenuBookOutlinedIcon fontSize="large" /> Knowledge Base
      </Typography>
      <Typography color="text.secondary">
        What Nexus Scheduler does, how its pieces fit together, and how to use each one.
      </Typography>

      <TextField
        label="Search the Knowledge Base"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        fullWidth
      />

      {CATEGORY_ORDER.map((category) => {
        const articles = filtered.filter((a) => a.category === category);
        if (articles.length === 0) return null;
        return (
          <Stack key={category} spacing={1.5}>
            <Typography variant="h6">{category}</Typography>
            <Grid container spacing={2}>
              {articles.map((article) => (
                <Grid item xs={12} sm={6} md={4} key={article.slug}>
                  <Card variant="outlined" sx={{ height: "100%" }}>
                    <CardActionArea component={RouterLink} to={`/help/${article.slug}`} sx={{ height: "100%", p: 2 }}>
                      <CardContent sx={{ p: 0 }}>
                        <Typography variant="subtitle1" gutterBottom>
                          {article.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {article.summary}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Stack>
        );
      })}

      {filtered.length === 0 && <Typography color="text.secondary">No articles match "{query}".</Typography>}
    </Stack>
  );
}
