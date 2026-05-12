import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { IssueRow } from "@/components/IssueRow";
import { createIssue } from "../fixtures/paperclipData";

function StoryFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">Owner inbox visibility</div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Inline orange chip surfaces issues with open issue-thread interactions awaiting an owner response.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card">
          {children}
        </div>
      </div>
    </main>
  );
}

const meta: Meta = {
  title: "Inbox / Pending interactions",
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj;

export const SingleInteraction: Story = {
  name: "결정 대기 1건",
  render: () => (
    <StoryFrame title="결정 대기 1건 chip on a Mine row">
      <IssueRow
        issue={createIssue({
          title: "오너 결정이 필요한 권장안 — 인박스 가시성",
          identifier: "DOGAA-82",
          pendingInteractionCount: 1,
        })}
      />
    </StoryFrame>
  ),
};

export const MultipleInteractions: Story = {
  name: "결정 대기 N건",
  render: () => (
    <StoryFrame title="결정 대기 N건 — 여러 인터랙션이 누적된 경우">
      <IssueRow
        issue={createIssue({
          title: "분기 예산 승인 요청 (재논의 필요)",
          identifier: "DOGAA-87",
          pendingInteractionCount: 3,
        })}
      />
    </StoryFrame>
  ),
};

export const NoChipWhenZero: Story = {
  name: "No chip when count is 0",
  render: () => (
    <StoryFrame title="No chip when pendingInteractionCount is 0">
      <IssueRow
        issue={createIssue({
          title: "이미 해소된 이슈 — 결정 대기 없음",
          identifier: "DOGAA-50",
          pendingInteractionCount: 0,
        })}
      />
    </StoryFrame>
  ),
};

export const MixedRows: Story = {
  name: "Mixed Mine list",
  render: () => (
    <StoryFrame title="Mine 탭의 여러 행 — chip은 결정 대기 행에만 노출">
      <IssueRow
        issue={createIssue({
          title: "오너 결정 대기 — 회사 정책 정규화",
          identifier: "DOGAA-29",
          pendingInteractionCount: 2,
          isUnreadForMe: true,
        })}
        unreadState="visible"
      />
      <IssueRow
        issue={createIssue({
          title: "코더 PR 리뷰 핸드오프",
          identifier: "DOGAA-63",
          pendingInteractionCount: 0,
          isUnreadForMe: true,
        })}
        unreadState="visible"
      />
      <IssueRow
        issue={createIssue({
          title: "주간 인프라 회고",
          identifier: "DOGAA-12",
          pendingInteractionCount: 0,
          isUnreadForMe: false,
        })}
      />
    </StoryFrame>
  ),
};
