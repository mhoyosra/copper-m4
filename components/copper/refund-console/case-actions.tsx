"use client";

// The buttons on one case in the Refund Console. They call the server actions
// in app/support/actions.ts; the server decides whether the action is allowed.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  approveCase,
  declineRequest,
  markDeviceReceived,
  markHandled,
  type ActionResult,
} from "@/app/support/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type CaseKind = "approve" | "decide" | "exception" | "received";

export function CaseActions({
  caseId,
  kind,
  endsPlan,
  requiresReturn,
}: {
  caseId: string;
  kind: CaseKind;
  endsPlan: boolean;
  requiresReturn: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");

  function run(action: () => Promise<ActionResult>) {
    start(async () => {
      const result = await action();
      (result.ok ? toast.success : toast.error)(result.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2" data-testid={`case-actions-${caseId}`}>
      {kind === "received" && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => run(() => markDeviceReceived(caseId))}
        >
          Mark device received and refund
        </Button>
      )}
      {kind === "approve" && (
        <>
          {endsPlan && (
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Approving also ends this customer&apos;s Copper Plus plan and
              moves them to the Free plan.
            </p>
          )}
          {requiresReturn && (
            <p className="text-muted-foreground text-sm">
              Approving authorizes the return. The refund is issued when you
              mark the device received.
            </p>
          )}
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => approveCase(caseId))}
          >
            Approve
          </Button>
        </>
      )}
      {(kind === "approve" || kind === "decide" || kind === "exception") && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Note for this decision"
            placeholder="Note (optional)"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-8 max-w-60 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => declineRequest(caseId, note))}
          >
            Reject
          </Button>
          {kind === "exception" && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => markHandled(caseId, note))}
            >
              Handled outside the system
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
