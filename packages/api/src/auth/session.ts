import "express-session";
import type { RoleName } from "@nexus-scheduler/shared";

// Augments express-session's SessionData with the fields Nexus Scheduler
// actually needs post-login. Kept minimal — anything else about the user
// is looked up from Postgres by id, not cached in the session.
declare module "express-session" {
  interface SessionData {
    user?: {
      id: string;
      email: string;
      displayName: string | null;
      role: RoleName;
      authSource: "OIDC" | "LOCAL";
    };
    oidc?: {
      state: string;
      nonce: string;
      codeVerifier: string;
      returnTo?: string;
    };
  }
}
