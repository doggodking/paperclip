import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending-interaction filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issues list pendingInteractionForUserId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-pending-interaction-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PIF") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    assigneeUserId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: `Issue ${input.identifier}`,
      status: "in_progress",
      priority: "medium",
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: "manual",
    });
    return id;
  }

  async function insertInteraction(input: {
    companyId: string;
    issueId: string;
    kind: "suggest_tasks" | "ask_user_questions" | "request_confirmation";
    status?: "pending" | "accepted" | "rejected" | "answered" | "cancelled" | "expired" | "failed";
  }) {
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: input.companyId,
      issueId: input.issueId,
      kind: input.kind,
      status: input.status ?? "pending",
      continuationPolicy: "wake_assignee",
      payload: payloadForKind(input.kind),
    });
  }

  function payloadForKind(kind: "suggest_tasks" | "ask_user_questions" | "request_confirmation") {
    if (kind === "suggest_tasks") {
      return { version: 1, tasks: [] } as const;
    }
    if (kind === "ask_user_questions") {
      return { version: 1, questions: [] } as const;
    }
    return { version: 1, prompt: "Confirm?" } as const;
  }

  it("counts a single pending request_confirmation and matches assigneeUserId=me", async () => {
    const companyId = await createCompany("PIF1");
    const me = "owner-1";
    const issueId = await insertIssue({ companyId, identifier: "PIF1-1", assigneeUserId: me });
    await insertInteraction({ companyId, issueId, kind: "request_confirmation", status: "pending" });

    const filtered = await svc.list(companyId, { pendingInteractionForUserId: me });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(issueId);
    expect(filtered[0]?.pendingInteractionCount).toBe(1);
  });

  it("does not count resolved interactions and excludes from filter", async () => {
    const companyId = await createCompany("PIF2");
    const me = "owner-2";
    const issueId = await insertIssue({ companyId, identifier: "PIF2-1", assigneeUserId: me });
    await insertInteraction({ companyId, issueId, kind: "request_confirmation", status: "accepted" });
    await insertInteraction({ companyId, issueId, kind: "ask_user_questions", status: "rejected" });

    const filtered = await svc.list(companyId, { pendingInteractionForUserId: me });
    expect(filtered).toHaveLength(0);

    const all = await svc.list(companyId, {});
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(issueId);
    expect(all[0]?.pendingInteractionCount).toBe(0);
  });

  it("excludes issues assigned to a different user", async () => {
    const companyId = await createCompany("PIF3");
    const me = "owner-3";
    const other = "owner-other";
    const myIssueId = await insertIssue({ companyId, identifier: "PIF3-1", assigneeUserId: me });
    const otherIssueId = await insertIssue({ companyId, identifier: "PIF3-2", assigneeUserId: other });
    await insertInteraction({ companyId, issueId: myIssueId, kind: "request_confirmation" });
    await insertInteraction({ companyId, issueId: otherIssueId, kind: "request_confirmation" });

    const filtered = await svc.list(companyId, { pendingInteractionForUserId: me });
    expect(filtered.map((row) => row.id)).toEqual([myIssueId]);
    expect(filtered[0]?.pendingInteractionCount).toBe(1);
  });

  it("counts pending interactions regardless of kind", async () => {
    const companyId = await createCompany("PIF4");
    const me = "owner-4";
    const issueId = await insertIssue({ companyId, identifier: "PIF4-1", assigneeUserId: me });
    await insertInteraction({ companyId, issueId, kind: "suggest_tasks" });
    await insertInteraction({ companyId, issueId, kind: "ask_user_questions" });
    await insertInteraction({ companyId, issueId, kind: "request_confirmation" });

    const filtered = await svc.list(companyId, { pendingInteractionForUserId: me });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(issueId);
    expect(filtered[0]?.pendingInteractionCount).toBe(3);
  });
});
