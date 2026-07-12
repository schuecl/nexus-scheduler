import type { ReactNode } from "react";
import { AppBar, Avatar, Box, Button, Toolbar, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { ClassificationBanner } from "../components/ClassificationBanner";
import { useSettings } from "../context/SettingsContext";
import { useAuth } from "../context/AuthContext";

const NAV_LINKS = [
  { to: "/", label: "Dashboard" },
  { to: "/projects", label: "Projects" },
  { to: "/prompts", label: "Prompt Library" },
  { to: "/schedules", label: "Approvals" },
  { to: "/teams", label: "Teams" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/admin", label: "Admin" },
];

// Top and bottom classification banner, always visible — REQUIREMENTS §6.
export function AppLayout({ children }: { children: ReactNode }) {
  const { user, login, logout } = useAuth();
  const { settings } = useSettings();
  const bannerConfig = {
    text: settings.classificationBannerText,
    backgroundColor: settings.classificationBannerBgColor,
    textColor: settings.classificationBannerTextColor,
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <ClassificationBanner config={bannerConfig} />

      <AppBar position="static" color="default" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          {settings.logoUrl && <Avatar src={settings.logoUrl} variant="square" sx={{ width: 32, height: 32 }} />}
          <Typography variant="h6" sx={{ flexGrow: 0 }}>
            {settings.productName}
          </Typography>
          <Box sx={{ flexGrow: 1, display: "flex", gap: 1 }}>
            {NAV_LINKS.map((link) => (
              <Button key={link.to} component={RouterLink} to={link.to} color="inherit">
                {link.label}
              </Button>
            ))}
          </Box>
          {user ? (
            <>
              <Typography variant="body2">
                {user.displayName ?? user.email} ({user.role})
              </Typography>
              <Button color="inherit" onClick={() => void logout()}>
                Log out
              </Button>
            </>
          ) : (
            <Button color="inherit" onClick={login}>
              Log in
            </Button>
          )}
        </Toolbar>
      </AppBar>

      <Box component="main" sx={{ flex: 1, p: 3 }}>
        {children}
      </Box>

      <ClassificationBanner config={bannerConfig} />
    </Box>
  );
}
