// The rules engine. Plain code, no model: it reads the order and the policy
// file and returns a verdict. Windows are judged as of `requestedAt`, so a slow
// reviewer never makes a customer lose the window.
import { getPolicy, type RefundPolicy } from "@/lib/copper/refunds/policy";
import type {
  Order,
  OrderLine,
  RefundRequest,
  Verdict,
} from "@/lib/copper/refunds/types";

export type EligibilityInput = {
  order: Order;
  request: Pick<
    RefundRequest,
    "item" | "reasonCode" | "chargeId" | "confirmsPlanEnds"
  >;
  requestedAt: Date;
  /** What this customer's auto-approved refunds already total in the last 90 days. */
  priorAutoRefundedUsd: number;
  /** The console re-checks policy only; the auto-approve limit doesn't apply. */
  ignoreLimit?: boolean;
  policy?: RefundPolicy;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whole days from a YYYY-MM-DD date to the day of `at` (UTC). */
export function daysSince(date: string, at: Date): number {
  const day = Date.parse(`${date}T00:00:00Z`);
  const today = Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.floor((today - day) / 86_400_000);
}

const verdict = (
  v: Partial<Verdict> & Pick<Verdict, "result" | "ruleApplied">,
): Verdict => ({
  lineId: null,
  amountUsd: null,
  endsPlan: false,
  requiresReturn: false,
  policyEligible: false,
  reviewReason: null,
  needsInfo: null,
  ...v,
});

/** The extra charge when a monthly plan was charged twice for one period. */
export function findDuplicateExtra(lines: OrderLine[]): OrderLine | null {
  const monthly = lines
    .filter((l) => l.plan === "monthly" && l.billingPeriod)
    .sort(
      (a, b) =>
        a.chargedAt.localeCompare(b.chargedAt) || a.id.localeCompare(b.id),
    );
  const seen = new Set<string>();
  for (const line of monthly) {
    const key = line.billingPeriod!;
    if (seen.has(key) && line.refundedUsd < line.amountUsd) return line;
    seen.add(key);
  }
  return null;
}

type Picked =
  | { line: OrderLine | null; needs: null }
  | { line: null; needs: "item_not_on_order" | "which_charge" };

function pickLine(input: EligibilityInput): Picked {
  const { order, request } = input;
  const candidates = order.lines.filter((l) => l.item === request.item);
  if (candidates.length === 0)
    return { line: null, needs: "item_not_on_order" };
  if (request.chargeId) {
    const named = candidates.find((l) => l.id === request.chargeId);
    return named
      ? { line: named, needs: null }
      : { line: null, needs: "which_charge" };
  }
  if (candidates.length === 1) return { line: candidates[0], needs: null };
  if (request.reasonCode === "billing_error") {
    const extra = findDuplicateExtra(candidates);
    if (extra) return { line: extra, needs: null };
  }
  return { line: null, needs: "which_charge" };
}

export function checkRefundEligibility(input: EligibilityInput): Verdict {
  const policy = input.policy ?? getPolicy();
  const { request, requestedAt } = input;
  const limit = policy.autoApprove.limitUsd;

  // Outage and bug refunds are supervisor-only exceptions (Refund Exceptions
  // Playbook): always escalate, never decide.
  if (request.reasonCode === "outage_bug") {
    const same = input.order.lines.filter((l) => l.item === request.item);
    return verdict({
      result: "escalate",
      ruleApplied: "exception_outage_bug",
      lineId: same.length === 1 ? same[0].id : null,
      reviewReason: "exception",
    });
  }

  const picked = pickLine(input);
  if (picked.needs) {
    return verdict({
      result: "needs_info",
      ruleApplied: picked.needs,
      needsInfo: picked.needs,
    });
  }
  const line = picked.line!;
  const base = { lineId: line.id };
  const remaining = round2(line.amountUsd - line.refundedUsd);

  if (line.plan === "free" || line.amountUsd === 0) {
    return verdict({
      ...base,
      result: "not_eligible",
      ruleApplied: "service_free_plan",
    });
  }
  if (remaining <= 0) {
    return verdict({
      ...base,
      result: "not_eligible",
      ruleApplied: "already_refunded",
    });
  }

  // Decide whether the written policy allows it, then apply the limit.
  let rule: string;
  let policyOk = false;
  let endsPlan = false;
  let requiresReturn = false;
  let escalateAnyway = false;

  if (line.kind === "device") {
    if (!line.deliveredAt) {
      rule = "device_not_delivered";
      escalateAnyway = true;
    } else if (
      daysSince(line.deliveredAt, requestedAt) <=
      policy.windows.deviceReturnDays
    ) {
      rule = "device_return_30d";
      policyOk = true;
      requiresReturn = true;
    } else {
      rule =
        request.reasonCode === "defective"
          ? "device_after_window_defect"
          : "device_after_window";
    }
  } else {
    const duplicate = findDuplicateExtra(
      input.order.lines.filter((l) => l.item === request.item),
    );
    const isDuplicate = duplicate?.id === line.id;
    if (
      isDuplicate &&
      (request.reasonCode === "billing_error" || request.chargeId === line.id)
    ) {
      rule = "service_duplicate_charge";
      policyOk = true;
    } else if (request.reasonCode === "billing_error") {
      rule = "service_billing_error_other";
      escalateAnyway = true;
    } else if (line.plan === "monthly") {
      rule = "service_monthly_no_partial";
    } else if (
      daysSince(line.chargedAt, requestedAt) <= policy.windows.annualPlusDays
    ) {
      if (request.confirmsPlanEnds !== true) {
        return verdict({
          ...base,
          result: "needs_info",
          ruleApplied: "confirm_plan_end",
          needsInfo: "confirm_plan_end",
        });
      }
      rule = "service_annual_14d";
      policyOk = true;
      endsPlan = true;
    } else {
      rule = "service_annual_after_14d";
    }
  }

  if (escalateAnyway) {
    return verdict({
      ...base,
      result: "escalate",
      ruleApplied: rule,
      reviewReason: "unclear",
    });
  }
  if (!policyOk) {
    return verdict({ ...base, result: "not_eligible", ruleApplied: rule });
  }

  const withinLimit =
    input.ignoreLimit === true ||
    round2(input.priorAutoRefundedUsd + remaining) <= limit;
  return verdict({
    ...base,
    result: withinLimit ? "eligible" : "escalate",
    ruleApplied: rule,
    amountUsd: remaining,
    endsPlan,
    requiresReturn,
    policyEligible: true,
    reviewReason: withinLimit ? null : "over_limit",
  });
}
