import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  Chip,
  FormControlLabel,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import SearchIcon from "@mui/icons-material/Search";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { apiFetch } from "../api/client";
import { PromptDetailDialog } from "../components/PromptDetailDialog";

interface LibraryPrompt {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  isFavorite: boolean;
  updatedAt: string;
  project: { id: string; name: string };
}

// Searchable, org-wide view across every Project the user can see
// (REQUIREMENTS §2.3) — this is what makes sharing actually
// discoverable rather than just permitted.
export function PromptLibraryPage() {
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [openPromptId, setOpenPromptId] = useState<string | null>(null);

  const promptsQuery = useQuery({
    queryKey: ["prompts", { search, favoritesOnly }],
    queryFn: () =>
      apiFetch<LibraryPrompt[]>(
        `/api/prompts?${new URLSearchParams({
          ...(search ? { search } : {}),
          ...(favoritesOnly ? { favoritesOnly: "true" } : {}),
        })}`,
      ),
  });

  return (
    <Box>
      <Typography variant="h4" gutterBottom sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <MenuBookOutlinedIcon fontSize="large" /> Prompt Library
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <TextField
          label="Search name or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="small"
          sx={{ minWidth: 320 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <FormControlLabel
          control={<Switch checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} />}
          label="Favorites only"
        />
      </Stack>

      <List>
        {promptsQuery.data?.map((prompt) => (
          <ListItem key={prompt.id} disablePadding>
            <ListItemButton onClick={() => setOpenPromptId(prompt.id)}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    {prompt.isFavorite && <StarIcon fontSize="small" color="warning" />}
                    <span>{prompt.name}</span>
                    {prompt.tags.map((tag) => (
                      <Chip key={tag} size="small" label={tag} variant="outlined" />
                    ))}
                  </Stack>
                }
                secondary={`${prompt.project.name}${prompt.description ? ` — ${prompt.description}` : ""}`}
              />
            </ListItemButton>
          </ListItem>
        ))}
        {promptsQuery.data?.length === 0 && (
          <Typography color="text.secondary">
            No prompts match. Create one from inside a Project's detail view.
          </Typography>
        )}
      </List>

      {openPromptId && <PromptDetailDialog promptId={openPromptId} onClose={() => setOpenPromptId(null)} />}
    </Box>
  );
}
