import { ThemeProvider, CssBaseline } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { buildTheme } from "./theme";
import { defaultBranding } from "./branding";
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
const theme = buildTheme(defaultBranding);

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>
    </ThemeProvider>
  );
}
