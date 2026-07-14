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
  consentBannerEnabled: boolean;
  consentBannerTitle: string;
  consentBannerBody: string;
  consentBannerRequireAcceptReject: boolean;
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
    consentBannerEnabled: false,
    consentBannerTitle: "",
    consentBannerBody: "",
    consentBannerRequireAcceptReject: false,
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

  // The browser-tab favicon follows the same admin-configured branding
  // logo used everywhere else (AppLayout, LoginPage) — no separate
  // favicon setting to keep in sync. Left alone (browser default) when
  // no logo is configured, same as those Avatar components not
  // rendering at all in that case. Removes and re-inserts the <link>
  // rather than mutating .href in place, since some browsers don't
  // reliably re-fetch a changed favicon otherwise.
  useEffect(() => {
    const existing = document.querySelectorAll<HTMLLinkElement>("link[rel='icon']");
    existing.forEach((el) => el.remove());
    if (!settings.logoUrl) {
      // An admin who sets then clears a logo shouldn't be stuck with the
      // previously injected (and now possibly-404) icon until a full
      // reload — removing it above and stopping here reverts to
      // whatever the browser/index.html would show with no override.
      return;
    }
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = settings.logoUrl;
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [settings.logoUrl]);

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
