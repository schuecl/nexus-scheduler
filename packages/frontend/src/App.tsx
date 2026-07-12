import { ThemeProvider, CssBaseline } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { buildTheme } from "./theme";
import { defaultBranding } from "./branding";
import { AuthProvider } from "./context/AuthContext";
import { AppLayout } from "./layout/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { PromptLibraryPage } from "./pages/PromptLibraryPage";
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
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/projects" element={<PromptLibraryPage />} />
                <Route path="/admin" element={<AdminPage />} />
              </Routes>
            </AppLayout>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
