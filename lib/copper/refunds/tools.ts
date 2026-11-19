// The Refund Agent's four tools. lookup_order and check_refund_eligibility take
// no input at all: the request lives in the run's context, so the model can't
// change the order, the item, the reason or the confirmation. issue_refund and
// escalate_to_supervisor take only a case id; the amount, the rule and where
// the money goes all come from the case record.
import { tool } from "ai";
import { z } from "zod";
import { escalateCase, issueRefund } from "@/lib/copper/refunds/cases";
import {
  doCheck,
  doLookup,
  type ReviewContext,
} from "@/lib/copper/refunds/review";

export function createRefundTools(ctx: ReviewContext) {
  const refresh = async () => {
    if (ctx.case) ctx.case = (await ctx.store.getCase(ctx.case.id)) ?? ctx.case;
  };
  const ownCase = (caseId: string) =>
    ctx.case !== null && ctx.case.id === caseId;

  return {
    lookup_order: tool({
      description:
        "Look up the customer's order. Takes no input: it uses the order number and email from the request. Returns the order's lines, or found: false.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await doLookup(ctx);
        if (!result.found) return { found: false };
        return {
          found: true,
          lines: result.order.lines.map((l) => ({
            lineId: l.id,
            item: l.item,
            kind: l.kind,
            plan: l.plan,
            amountUsd: l.amountUsd,
            chargedAt: l.chargedAt,
            deliveredAt: l.deliveredAt,
            refundedUsd: l.refundedUsd,
          })),
        };
      },
    }),
    check_refund_eligibility: tool({
      description:
        "Check the written refund policy for this request. Takes no input. Returns the verdict (eligible, escalate, not_eligible or needs_info), the rule, and a caseId. The verdict is final.",
      inputSchema: z.object({}),
      execute: async () => doCheck(ctx),
    }),
    issue_refund: tool({
      description:
        "Issue the refund for a case whose verdict was 'eligible'. Takes only the caseId. The amount comes from the case, never from you.",
      inputSchema: z.object({ caseId: z.string() }),
      execute: async ({ caseId }) => {
        if (!ownCase(caseId)) return { ok: false, reason: "unknown_case" };
        const result = await issueRefund(ctx.store, caseId, "refund-agent");
        await refresh();
        return result.ok
          ? { ok: true, status: result.case.status }
          : { ok: false, reason: result.reason };
      },
    }),
    escalate_to_supervisor: tool({
      description:
        "Hand a case to a person. Takes the caseId and a short summary of why. Use it for any 'escalate' verdict, and whenever you are unsure.",
      inputSchema: z.object({
        caseId: z.string(),
        summary: z.string().max(300),
      }),
      execute: async ({ caseId, summary }) => {
        if (!ownCase(caseId)) return { ok: false, reason: "unknown_case" };
        const result = await escalateCase(
          ctx.store,
          caseId,
          summary,
          "refund-agent",
        );
        await refresh();
        return result.ok
          ? { ok: true, status: result.case.status }
          : { ok: false, reason: result.reason };
      },
    }),
  };
}
