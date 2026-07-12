import { prisma } from "./db.js";

// Team membership is inherited down the hierarchy (REQUIREMENTS.md §2.3):
// adding a user to a parent Team makes them an effective member of every
// descendant Team too. Team trees are expected to stay small, so this
// walks the whole tree in application code rather than a recursive SQL
// CTE — revisit if Team counts ever make that a real cost.
export async function getEffectiveTeamIds(userId: string): Promise<string[]> {
  const memberships = await prisma.teamMembership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const directIds = memberships.map((m) => m.teamId);
  if (directIds.length === 0) {
    return [];
  }

  const allTeams = await prisma.team.findMany({ select: { id: true, parentTeamId: true } });
  const childrenByParent = new Map<string, string[]>();
  for (const team of allTeams) {
    if (team.parentTeamId) {
      const siblings = childrenByParent.get(team.parentTeamId) ?? [];
      siblings.push(team.id);
      childrenByParent.set(team.parentTeamId, siblings);
    }
  }

  const effective = new Set<string>();
  const queue = [...directIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (effective.has(id)) continue;
    effective.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      queue.push(childId);
    }
  }
  return [...effective];
}

export type ProjectAccessLevel = "OWNER" | "EDIT" | "READ" | null;

// Resolves the highest access level a user has on a Project via any
// combination of ownership, direct-user ACL, Team ACL (with inheritance
// above), or org-wide ACL (REQUIREMENTS.md §2.3).
export async function getProjectAccess(userId: string, projectId: string): Promise<ProjectAccessLevel> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { acls: true },
  });
  if (!project) {
    return null;
  }
  if (project.ownerId === userId) {
    return "OWNER";
  }

  const effectiveTeamIds = await getEffectiveTeamIds(userId);
  let best: "EDIT" | "READ" | null = null;
  for (const acl of project.acls) {
    const matches =
      (acl.granteeType === "USER" && acl.granteeUserId === userId) ||
      acl.granteeType === "ORG" ||
      (acl.granteeType === "TEAM" &&
        acl.granteeTeamId !== null &&
        effectiveTeamIds.includes(acl.granteeTeamId));
    if (!matches) continue;
    if (acl.accessLevel === "EDIT") {
      return "EDIT"; // can't beat EDIT, short-circuit
    }
    best = "READ";
  }
  return best;
}

// Shared by listAccessibleProjects and getAccessibleProjectIds so the two
// never disagree about what "accessible" means.
async function accessibleProjectWhere(userId: string) {
  const effectiveTeamIds = await getEffectiveTeamIds(userId);
  return {
    OR: [
      { ownerId: userId },
      { acls: { some: { granteeType: "USER" as const, granteeUserId: userId } } },
      { acls: { some: { granteeType: "ORG" as const } } },
      ...(effectiveTeamIds.length > 0
        ? [{ acls: { some: { granteeType: "TEAM" as const, granteeTeamId: { in: effectiveTeamIds } } } }]
        : []),
    ],
  };
}

// Every Project a user can see at all, for the list view — same access
// rules as getProjectAccess but as a single query rather than N checks.
export async function listAccessibleProjects(userId: string) {
  return prisma.project.findMany({
    where: await accessibleProjectWhere(userId),
    include: { classificationLabel: true, owner: { select: { id: true, email: true, displayName: true } } },
    orderBy: { updatedAt: "desc" },
  });
}

// Bare IDs — used to scope the library-wide Prompt search (§2.3) to
// Projects the user can actually see, without pulling full Project rows.
export async function getAccessibleProjectIds(userId: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: await accessibleProjectWhere(userId),
    select: { id: true },
  });
  return projects.map((p) => p.id);
}
