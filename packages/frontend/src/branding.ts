// Placeholder for admin-configurable branding (REQUIREMENTS.md §5) and
// the classification banner (§6). In the real app this is fetched from
// a `/api/admin/branding` endpoint at startup, not hardcoded — this
// module exists so the rest of the UI has a stable shape to code against
// before that endpoint exists.
export interface BrandingConfig {
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
}

export interface ClassificationBannerConfig {
  text: string;
  backgroundColor: string;
  textColor: string;
}

export const defaultBranding: BrandingConfig = {
  productName: "Nexus Scheduler",
  logoUrl: null,
  primaryColor: "#1565c0",
};

// Intentionally loud placeholder values — a real deployment must set
// these via admin configuration (§6); shipping a silent default here
// would be exactly the kind of "banner always says the wrong thing"
// mistake the requirement is trying to prevent.
export const defaultClassificationBanner: ClassificationBannerConfig = {
  text: "UNCONFIGURED — SET CLASSIFICATION BANNER IN ADMIN SETTINGS",
  backgroundColor: "#b71c1c",
  textColor: "#ffffff",
};
