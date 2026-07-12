// Role model — REQUIREMENTS.md §4.
export const ROLES = ["ADMIN", "EDITOR", "VIEW"] as const;
export type RoleName = (typeof ROLES)[number];

// Coarse permission checks used by both the API and (indirectly) the UI
// to decide what to render. Keep these as small, named predicates rather
// than scattering role === "..." checks through route handlers.
export function canManageSystem(role: RoleName): boolean {
  return role === "ADMIN";
}

export function canEdit(role: RoleName): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function canView(_role: RoleName): boolean {
  return true; // all authenticated roles can read what they have access to
}
