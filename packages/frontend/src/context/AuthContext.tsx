import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../api/client";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "ADMIN" | "EDITOR" | "VIEW";
  authSource: "OIDC" | "LOCAL";
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<SessionUser>("/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = () => {
    // CAC/PIV happens upstream in Keycloak — the frontend just redirects
    // into the OIDC flow (REQUIREMENTS.md §4).
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  };

  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
