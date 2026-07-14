import type { ReactNode } from "react";
import { AppBar, Avatar, Box, Button, IconButton, Toolbar, Tooltip, Typography } from "@mui/material";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import VpnKeyOutlinedIcon from "@mui/icons-material/VpnKeyOutlined";
import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import { Link as RouterLink } from "react-router-dom";
import { ClassificationBanner } from "../components/ClassificationBanner";
import { useSettings } from "../context/SettingsContext";
import { useAuth } from "../context/AuthContext";
import { useColorMode } from "../context/ColorModeContext";

const NAV_LINKS = [
  { to: "/", label: "Dashboard", icon: <DashboardOutlinedIcon fontSize="small" /> },
  { to: "/projects", label: "Projects", icon: <FolderOutlinedIcon fontSize="small" /> },
  { to: "/prompts", label: "Prompt Library", icon: <MenuBookOutlinedIcon fontSize="small" /> },
  { to: "/schedules", label: "Approvals", icon: <FactCheckOutlinedIcon fontSize="small" /> },
  { to: "/teams", label: "Teams", icon: <GroupsOutlinedIcon fontSize="small" /> },
  { to: "/api-keys", label: "API Keys", icon: <VpnKeyOutlinedIcon fontSize="small" /> },
  { to: "/admin", label: "Admin", icon: <AdminPanelSettingsOutlinedIcon fontSize="small" /> },
];

// Top and bottom classification banner, always visible regardless of
// auth state — REQUIREMENTS §6, deliberately independent of login.
// Everything else — nav tabs, product branding bar — is gated on being
// logged in: an unauthenticated visitor should see nothing but the
// banner and the login screen (RequireAuth handles bouncing every
// other route to /login; this hides the chrome around it).
export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { settings } = useSettings();
  const { mode, toggleMode } = useColorMode();
  const bannerConfig = {
    text: settings.classificationBannerText,
    backgroundColor: settings.classificationBannerBgColor,
    textColor: settings.classificationBannerTextColor,
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <ClassificationBanner config={bannerConfig} />

      {user && (
        <AppBar position="static" color="default" elevation={1}>
          <Toolbar sx={{ gap: 2 }}>
            {settings.logoUrl && <Avatar src={settings.logoUrl} variant="square" sx={{ width: 32, height: 32 }} />}
            <Typography variant="h6" sx={{ flexGrow: 0 }}>
              {settings.productName}
            </Typography>
            <Box sx={{ flexGrow: 1, display: "flex", gap: 0.5 }}>
              {NAV_LINKS.map((link) => (
                <Button key={link.to} component={RouterLink} to={link.to} color="inherit" startIcon={link.icon}>
                  {link.label}
                </Button>
              ))}
            </Box>
            <Typography variant="body2">
              {user.displayName ?? user.email} ({user.role})
            </Typography>
            <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              <IconButton color="inherit" onClick={toggleMode} aria-label="Toggle dark mode">
                {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
            <Button color="inherit" onClick={() => void logout()} startIcon={<LogoutIcon fontSize="small" />}>
              Log out
            </Button>
          </Toolbar>
        </AppBar>
      )}

      <Box component="main" sx={{ flex: 1, p: 3 }}>
        {children}
      </Box>

      <ClassificationBanner config={bannerConfig} />
    </Box>
  );
}
