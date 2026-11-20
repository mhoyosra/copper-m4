"use server";

// What the Refund Console's buttons do. Each one calls the same case functions
// the Refund Agent's tools use (lib/copper/refunds/cases.ts), so a person can't
// do anything the rules don't allow: the amount comes from the case, a decided
// case can't be decided again, and approving re-checks the policy as of the day
// the customer asked.
// This console has no sign-in yet, so these actions are open to anyone who can
// reach /support (a known risk, see specs/module-4/spec.md).
import { revalidatePath } from "next/cache";
import {
  declineCase,
  issueRefund,
  markHandledElsewhere,
  markReceived,
  type CaseResult,
} from "@/lib/copper/refunds/cases";
import { getStore } from "@/lib/copper/refunds/store";

export type ActionResult = { ok: boolean; message: string };

const REASONS: Record<string, string> = {
  case_not_found: "That case no longer exists.",
  wrong_state: "That case was already decided.",
  not_escalated: "That case isn't waiting for a decision.",
  not_awaiting_return: "That case isn't waiting for a device.",
  not_refundable: "The policy doesn't allow this refund.",
  needs_a_person: "This case needs a person.",
  changed_since_review:
    "The order changed since this was reviewed, so it can't be approved. Reject it or look at the order.",
  order_not_found: "The order for this case wasn't found.",
};

function finish(result: CaseResult, success: string): ActionResult {
  revalidatePath("/support");
  return result.ok
    ? { ok: true, message: success }
    : { ok: false, message: REASONS[result.reason] ?? "That didn't work." };
}

export async function approveCase(caseId: string): Promise<ActionResult> {
  const result = await issueRefund(getStore(), caseId, "console");
  return finish(
    result,
    result.ok && result.case.status === "awaiting_return"
      ? "Return approved. The refund is issued when the device is received."
      : "Refund issued.",
  );
}

export async function markDeviceReceived(
  caseId: string,
): Promise<ActionResult> {
  return finish(
    await markReceived(getStore(), caseId),
    "Device received. Refund issued.",
  );
}

export async function declineRequest(
  caseId: string,
  note: string,
): Promise<ActionResult> {
  return finish(
    await declineCase(getStore(), caseId, note.trim()),
    "Request declined.",
  );
}

export async function markHandled(
  caseId: string,
  note: string,
): Promise<ActionResult> {
  return finish(
    await markHandledElsewhere(getStore(), caseId, note.trim()),
    "Marked as handled outside the system.",
  );
}
