import { ThemeProvider, CssBaseline } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { buildTheme } from "./theme";
import { SettingsProvider, useSettings } from "./context/SettingsContext";
import { ColorModeProvider, useColorMode } from "./context/ColorModeContext";
import { AuthProvider } from "./context/AuthContext";
import { ConfirmProvider } from "./context/ConfirmContext";
import { AppLayout } from "./layout/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { PromptLibraryPage } from "./pages/PromptLibraryPage";
import { TeamsPage } from "./pages/TeamsPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { MailingListsPage } from "./pages/MailingListsPage";
import { AdminPage } from "./pages/AdminPage";
import { SystemMapPage } from "./pages/SystemMapPage";
import { KnowledgeBasePage } from "./pages/KnowledgeBasePage";
import { KbArticlePage } from "./pages/KbArticlePage";
import { ShortcutsPage } from "./pages/ShortcutsPage";
import { AboutPage } from "./pages/AboutPage";
import { LoginPage } from "./pages/LoginPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { ConsentDeclinedPage } from "./pages/ConsentDeclinedPage";
import { RequireAuth } from "./components/RequireAuth";

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ColorModeProvider>
          <ThemedApp />
        </ColorModeProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}

// Split out so the theme can be rebuilt from admin-configured branding
// (§5) once settings load, rather than being fixed at module-eval time,
// and from the user's own light/dark preference (ColorModeContext).
function ThemedApp() {
  const { settings } = useSettings();
  const { mode } = useColorMode();
  const theme = buildTheme(settings, mode);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ConfirmProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppLayout>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/consent-declined" element={<ConsentDeclinedPage />} />
                <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
                <Route path="/schedules" element={<RequireAuth><SchedulesPage /></RequireAuth>} />
                <Route path="/projects" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
                <Route path="/prompts" element={<RequireAuth><PromptLibraryPage /></RequireAuth>} />
                <Route path="/teams" element={<RequireAuth><TeamsPage /></RequireAuth>} />
                <Route path="/api-keys" element={<RequireAuth><ApiKeysPage /></RequireAuth>} />
                <Route path="/mailing-lists" element={<RequireAuth><MailingListsPage /></RequireAuth>} />
                <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
                <Route path="/admin/system-map" element={<RequireAuth><SystemMapPage /></RequireAuth>} />
                <Route path="/help" element={<RequireAuth><KnowledgeBasePage /></RequireAuth>} />
                <Route path="/help/shortcuts" element={<RequireAuth><ShortcutsPage /></RequireAuth>} />
                <Route path="/help/about" element={<RequireAuth><AboutPage /></RequireAuth>} />
                <Route path="/help/:slug" element={<RequireAuth><KbArticlePage /></RequireAuth>} />
              </Routes>
            </AppLayout>
          </BrowserRouter>
        </AuthProvider>
      </ConfirmProvider>
    </ThemeProvider>
  );
}
