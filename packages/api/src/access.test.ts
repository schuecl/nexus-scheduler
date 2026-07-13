import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db.js";
import {
  getDescendantTeamIds,
  getEffectiveTeamIds,
  getEligibleApprovers,
  getProjectAccess,
  getTeamMemberUserIds,
} from "./access.js";

// Real Postgres, not a mocked Prisma client — matches how this project
// verifies everything else. Requires DATABASE_URL to point at a real,
// disposable test database (CI: the postgres service container below;
// locally: any Postgres with the schema pushed via `prisma db push`).
async function resetDb() {
  await prisma.projectAcl.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.teamMembership.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.user.deleteMany({});
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

let userCounter = 0;
async function makeUser(role: "ADMIN" | "EDITOR" | "VIEW" = "EDITOR") {
  userCounter += 1;
  return prisma.user.create({
    data: { email: `test-user-${userCounter}@example.test`, authSource: "LOCAL", role },
  });
}

async function makeTeam(name: string, parentTeamId?: string, createdById?: string) {
  return prisma.team.create({ data: { name, parentTeamId, createdById } });
}

describe("getEffectiveTeamIds", () => {
  it("returns an empty array for a user with no team memberships", async () => {
    const user = await makeUser();
    expect(await getEffectiveTeamIds(user.id)).toEqual([]);
  });

  it("includes a team the user is a direct member of", async () => {
    const user = await makeUser();
    const team = await makeTeam("Team A");
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: user.id } });
    expect(await getEffectiveTeamIds(user.id)).toEqual([team.id]);
  });

  it("inherits membership down through nested sub-teams", async () => {
    const user = await makeUser();
    const parent = await makeTeam("Parent");
    const child = await makeTeam("Child", parent.id);
    const grandchild = await makeTeam("Grandchild", child.id);
    // Direct membership only in the top-level parent.
    await prisma.teamMembership.create({ data: { teamId: parent.id, userId: user.id } });

    const effective = await getEffectiveTeamIds(user.id);
    expect(new Set(effective)).toEqual(new Set([parent.id, child.id, grandchild.id]));
  });

  it("does not grant membership upward to an ancestor of the user's team", async () => {
    const user = await makeUser();
    const parent = await makeTeam("Parent");
    const child = await makeTeam("Child", parent.id);
    await prisma.teamMembership.create({ data: { teamId: child.id, userId: user.id } });

    expect(await getEffectiveTeamIds(user.id)).toEqual([child.id]);
  });
});

describe("getTeamMemberUserIds", () => {
  it("returns direct members of a team with no parent", async () => {
    const user = await makeUser();
    const team = await makeTeam("Solo Team");
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: user.id } });
    expect(await getTeamMemberUserIds(team.id)).toEqual([user.id]);
  });

  // Membership is inherited *down* the tree (a parent's members are
  // effective members of its children too), so asking "who are the
  // effective members of a child team" must also walk back up and
  // collect members of every ancestor.
  it("includes members of every ancestor team", async () => {
    const parentMember = await makeUser();
    const childMember = await makeUser();
    const parent = await makeTeam("Parent");
    const child = await makeTeam("Child", parent.id);
    await prisma.teamMembership.create({ data: { teamId: parent.id, userId: parentMember.id } });
    await prisma.teamMembership.create({ data: { teamId: child.id, userId: childMember.id } });

    const members = await getTeamMemberUserIds(child.id);
    expect(new Set(members)).toEqual(new Set([parentMember.id, childMember.id]));
  });

  // Regression for #7: a parent-chain cycle (A's parent is B, B's
  // parent is A) used to make the ancestor walk loop forever, pinning
  // the event loop on any call for either team in the cycle. Forces the
  // cycle directly at the DB layer — bypassing the app-level
  // reparenting guard entirely — to prove the fix is in the walk
  // itself, not just the one entry point that normally prevents this.
  it("terminates instead of looping forever when the team hierarchy has a cycle", async () => {
    const teamA = await makeTeam("A");
    const teamB = await makeTeam("B", teamA.id);
    await prisma.team.update({ where: { id: teamA.id }, data: { parentTeamId: teamB.id } });

    const result = await Promise.race([
      getTeamMemberUserIds(teamA.id),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 3000)),
    ]);
    expect(result).not.toBe("timed out");
    expect(result).toEqual([]);
  });
});

describe("getDescendantTeamIds", () => {
  it("returns every descendant across multiple levels", async () => {
    const parent = await makeTeam("Parent");
    const child = await makeTeam("Child", parent.id);
    const grandchild = await makeTeam("Grandchild", child.id);
    const unrelated = await makeTeam("Unrelated");

    const descendants = await getDescendantTeamIds(parent.id);
    expect(new Set(descendants)).toEqual(new Set([child.id, grandchild.id]));
    expect(descendants).not.toContain(unrelated.id);
  });

  it("returns an empty array for a team with no sub-teams", async () => {
    const team = await makeTeam("Leaf");
    expect(await getDescendantTeamIds(team.id)).toEqual([]);
  });

  // Same regression as above, for the descendant-direction walk.
  it("terminates instead of looping forever when the team hierarchy has a cycle", async () => {
    const teamA = await makeTeam("A");
    const teamB = await makeTeam("B", teamA.id);
    await prisma.team.update({ where: { id: teamA.id }, data: { parentTeamId: teamB.id } });

    const result = await Promise.race([
      getDescendantTeamIds(teamA.id),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 3000)),
    ]);
    expect(result).not.toBe("timed out");
    expect(new Set(result as string[])).toEqual(new Set([teamB.id]));
  });
});

describe("getProjectAccess", () => {
  it("returns OWNER for the project's owner", async () => {
    const owner = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "PRIVATE" } });
    expect(await getProjectAccess(owner.id, project.id)).toBe("OWNER");
  });

  it("returns null for a user with no relationship to the project", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "PRIVATE" } });
    expect(await getProjectAccess(stranger.id, project.id)).toBeNull();
  });

  it("returns EDIT for a direct-user ACL grant", async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({
      data: { projectId: project.id, granteeType: "USER", granteeUserId: grantee.id, accessLevel: "EDIT" },
    });
    expect(await getProjectAccess(grantee.id, project.id)).toBe("EDIT");
  });

  it("returns READ for an org-wide ACL grant", async () => {
    const owner = await makeUser();
    const anyUser = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({
      data: { projectId: project.id, granteeType: "ORG", accessLevel: "READ" },
    });
    expect(await getProjectAccess(anyUser.id, project.id)).toBe("READ");
  });

  it("grants access to a parent-team member when the ACL is granted to a sub-team", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const parentTeam = await makeTeam("Parent");
    const subTeam = await makeTeam("Sub", parentTeam.id);
    // Member belongs to the ancestor team; membership is inherited downward,
    // so they should also be an effective member of subTeam.
    await prisma.teamMembership.create({ data: { teamId: parentTeam.id, userId: member.id } });
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({
      data: { projectId: project.id, granteeType: "TEAM", granteeTeamId: subTeam.id, accessLevel: "EDIT" },
    });

    expect(await getProjectAccess(member.id, project.id)).toBe("EDIT");
  });
});

describe("getEligibleApprovers", () => {
  it("always includes the project owner", async () => {
    const owner = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    const { userIds, orgWideEdit } = await getEligibleApprovers(project.id);
    expect(userIds.has(owner.id)).toBe(true);
    expect(orgWideEdit).toBe(false);
  });

  it("sets orgWideEdit when there's an org-level EDIT grant", async () => {
    const owner = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({ data: { projectId: project.id, granteeType: "ORG", accessLevel: "EDIT" } });
    expect((await getEligibleApprovers(project.id)).orgWideEdit).toBe(true);
  });

  it("expands a TEAM EDIT grant to every effective member", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const team = await makeTeam("Approvers");
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id } });
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({
      data: { projectId: project.id, granteeType: "TEAM", granteeTeamId: team.id, accessLevel: "EDIT" },
    });

    const { userIds } = await getEligibleApprovers(project.id);
    expect(userIds.has(member.id)).toBe(true);
  });

  it("does not include a READ-only grantee as an eligible approver", async () => {
    const owner = await makeUser();
    const reader = await makeUser();
    const project = await prisma.project.create({ data: { name: "P", ownerId: owner.id, visibility: "SHARED" } });
    await prisma.projectAcl.create({
      data: { projectId: project.id, granteeType: "USER", granteeUserId: reader.id, accessLevel: "READ" },
    });
    const { userIds } = await getEligibleApprovers(project.id);
    expect(userIds.has(reader.id)).toBe(false);
  });
});
