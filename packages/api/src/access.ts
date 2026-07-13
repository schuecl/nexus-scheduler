import { prisma } from "./db.js";

// Every descendant of a Team (children, grandchildren, ...) — used to
// reject reparenting a Team under one of its own descendants, which
// would otherwise create a parent cycle. Visited-set guarded for the
// same reason as getTeamMemberUserIds' ancestor walk below: a
// pre-existing cycle elsewhere in the tree must not turn this into an
// infinite loop either.
export async function getDescendantTeamIds(teamId: string): Promise<string[]> {
  const allTeams = await prisma.team.findMany({ select: { id: true, parentTeamId: true } });
  const childrenByParent = new Map<string, string[]>();
  for (const team of allTeams) {
    if (team.parentTeamId) {
      const siblings = childrenByParent.get(team.parentTeamId) ?? [];
      siblings.push(team.id);
      childrenByParent.set(team.parentTeamId, siblings);
    }
  }

  const visited = new Set<string>([teamId]);
  const queue = [...(childrenByParent.get(teamId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      queue.push(childId);
    }
  }
  visited.delete(teamId);
  return [...visited];
}

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

export type TeamAccessLevel = "OWNER" | "MEMBER" | null;

// Direct membership only — deliberately does NOT walk the parent/child
// hierarchy the way getEffectiveTeamIds does for Project-ACL purposes.
// Being an effective member of a Team's sub-team through inheritance
// grants Project access via that sub-team's ACL grants, but it doesn't
// make you a member of — let alone an owner of — the parent Team itself;
// those are separate concerns.
export async function getTeamAccess(userId: string, teamId: string): Promise<TeamAccessLevel> {
  const membership = await prisma.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) return null;
  return membership.isOwner ? "OWNER" : "MEMBER";
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

// Reverse of getEffectiveTeamIds: given a Team, every user who is
// effectively a member of it — direct members, plus direct members of
// any *ancestor* Team (since membership in a parent is inherited down
// to its descendants, per §2.3).
export async function getTeamMemberUserIds(teamId: string): Promise<string[]> {
  const allTeams = await prisma.team.findMany({ select: { id: true, parentTeamId: true } });
  const parentOf = new Map(allTeams.map((t) => [t.id, t.parentTeamId]));

  // Guarded by a visited set, not just `while (current)` — a Team parent
  // cycle (A's parent is B, B's parent is A) would otherwise grow this
  // chain forever, pinning the event loop on every subsequent call for
  // any Team in the cycle.
  const visited = new Set([teamId]);
  const ancestorChain = [teamId];
  let current = parentOf.get(teamId);
  while (current && !visited.has(current)) {
    visited.add(current);
    ancestorChain.push(current);
    current = parentOf.get(current);
  }

  const memberships = await prisma.teamMembership.findMany({
    where: { teamId: { in: ancestorChain } },
    select: { userId: true },
  });
  return [...new Set(memberships.map((m) => m.userId))];
}

export interface EligibleApprovers {
  userIds: Set<string>;
  orgWideEdit: boolean; // an ORG-level EDIT grant means "anyone" is eligible
}

// Who can approve a schedule change in this Project (REQUIREMENTS.md
// §2.4): the owner, or anyone/any-Team granted EDIT access — expanded
// through Team membership (with inheritance) the same way project
// access itself is resolved.
export async function getEligibleApprovers(projectId: string): Promise<EligibleApprovers> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { acls: true } });
  const userIds = new Set<string>();
  let orgWideEdit = false;
  if (!project) {
    return { userIds, orgWideEdit };
  }
  userIds.add(project.ownerId);

  for (const acl of project.acls) {
    if (acl.accessLevel !== "EDIT") continue;
    if (acl.granteeType === "USER" && acl.granteeUserId) {
      userIds.add(acl.granteeUserId);
    } else if (acl.granteeType === "ORG") {
      orgWideEdit = true;
    } else if (acl.granteeType === "TEAM" && acl.granteeTeamId) {
      for (const memberId of await getTeamMemberUserIds(acl.granteeTeamId)) {
        userIds.add(memberId);
      }
    }
  }
  return { userIds, orgWideEdit };
}
