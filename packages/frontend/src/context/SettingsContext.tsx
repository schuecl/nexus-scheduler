import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../api/client";
import { defaultBranding, defaultClassificationBanner } from "../branding";

export interface AppSettings {
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
  classificationBannerText: string;
  classificationBannerBgColor: string;
  classificationBannerTextColor: string;
}

interface SettingsContextValue {
  settings: AppSettings;
  loading: boolean;
  refetch: () => void;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

// GET /api/settings is unauthenticated (REQUIREMENTS §6: the banner must
// render regardless of login state), so this fetches independently of
// AuthContext rather than waiting on it. Falls back to the loud
// "unconfigured" placeholder (see branding.ts) if the fetch fails, so a
// broken settings endpoint never silently shows a wrong-looking banner.
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>({
    ...defaultBranding,
    classificationBannerText: defaultClassificationBanner.text,
    classificationBannerBgColor: defaultClassificationBanner.backgroundColor,
    classificationBannerTextColor: defaultClassificationBanner.textColor,
  });
  const [loading, setLoading] = useState(true);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<AppSettings>("/api/settings")
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        /* keep the placeholder defaults */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  return (
    <SettingsContext.Provider value={{ settings, loading, refetch: () => setRefetchToken((t) => t + 1) }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
