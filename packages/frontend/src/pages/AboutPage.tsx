import { Link as RouterLink } from "react-router";
import { Avatar, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useSettings } from "../context/SettingsContext";

export function AboutPage() {
  const { settings } = useSettings();

  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <InfoOutlinedIcon fontSize="large" /> About
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center">
        {settings.logoUrl && <Avatar src={settings.logoUrl} variant="square" sx={{ width: 48, height: 48 }} />}
        <Typography variant="h5">{settings.productName}</Typography>
      </Stack>

      <List dense sx={{ maxWidth: 480 }}>
        <ListItem>
          <ListItemText primary="Version" secondary={__APP_VERSION__} />
        </ListItem>
      </List>

      <Typography color="text.secondary">
        A web application for scheduling and managing agentic AI tasks against a LibreChat Agents
        API. See the <RouterLink to="/help">Knowledge Base</RouterLink> for what it does and how to
        use it.
      </Typography>
    </Stack>
  );
}
