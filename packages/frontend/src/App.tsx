import { ThemeProvider, CssBaseline } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { buildTheme } from "./theme";
import { SettingsProvider, useSettings } from "./context/SettingsContext";
import { AuthProvider } from "./context/AuthContext";
import { AppLayout } from "./layout/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { PromptLibraryPage } from "./pages/PromptLibraryPage";
import { TeamsPage } from "./pages/TeamsPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { AdminPage } from "./pages/AdminPage";

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ThemedApp />
      </SettingsProvider>
    </QueryClientProvider>
  );
}

// Split out so the theme can be rebuilt from admin-configured branding
// (§5) once settings load, rather than being fixed at module-eval time.
function ThemedApp() {
  const { settings } = useSettings();
  const theme = buildTheme(settings);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/prompts" element={<PromptLibraryPage />} />
              <Route path="/teams" element={<TeamsPage />} />
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
