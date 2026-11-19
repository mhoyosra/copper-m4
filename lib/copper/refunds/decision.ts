// Turns a case into the RefundDecision Ask Copper relays. The status text is a
// code template from refund-policy.json, never the model's words; the agent's
// own explanation is kept only if it passes validateExplanation.
import { fill, formatUsd, getPolicy } from "@/lib/copper/refunds/policy";
import type { RefundCase, RefundDecision } from "@/lib/copper/refunds/types";

type RuleText = { text: string; next?: string };

function ruleText(key: string): RuleText {
  const rules = getPolicy().rules as Record<string, RuleText>;
  return rules[key] ?? rules.unfinished_review;
}

/** The customer-facing status line for a case, from the policy templates. */
export function statusTextFor(c: RefundCase): string {
  const policy = getPolicy();
  const vars = {
    caseId: c.id,
    amount: c.amountUsd === null ? "" : formatUsd(c.amountUsd),
  };
  const say = (t: string) => fill(t, vars);
  const planEnded = c.status === "refunded" && c.endsPlan;

  switch (c.status) {
    case "refunded":
      return [
        say(ruleText(c.ruleApplied).text),
        say(policy.status.refunded),
        planEnded ? say(policy.status.planEnded) : "",
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    case "awaiting_return":
      return [
        say(ruleText(c.ruleApplied).text),
        say(policy.status.awaiting_return),
      ].join(" ");
    case "escalated":
    case "reviewing": {
      // A refund the policy allows but that is over the limit says only that a
      // supervisor must approve it; it never promises the money.
      const key = c.policyEligible
        ? "over_limit"
        : c.status === "reviewing"
          ? "unfinished_review"
          : c.ruleApplied;
      return [say(ruleText(key).text), say(policy.status.escalated)].join(" ");
    }
    case "declined":
      return say(policy.status.declined);
    case "handled_elsewhere":
      return say(policy.status.handled_elsewhere);
    case "rejected": {
      const rule = ruleText(c.ruleApplied);
      return [
        say(rule.text),
        rule.next ? say(rule.next) : "",
        say(policy.status.rejected),
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}

const OUTCOME: Record<RefundCase["status"], RefundDecision["outcome"]> = {
  reviewing: "escalated",
  escalated: "escalated",
  handled_elsewhere: "escalated",
  awaiting_return: "approved",
  refunded: "approved",
  rejected: "rejected",
  declined: "rejected",
};

const NEXT: Record<RefundCase["status"], RefundDecision["nextStep"]> = {
  reviewing: "supervisor_review",
  escalated: "supervisor_review",
  handled_elsewhere: "supervisor_review",
  awaiting_return: "awaiting_return",
  refunded: "refund_issued",
  rejected: "none",
  declined: "none",
};

/**
 * Keeps the agent's explanation only if it can't mislead: no outcome that
 * differs from the case, no claim that money moved when it hasn't, no amount
 * other than the case's, no internal terms, no email address. Otherwise
 * returns "" and the code-owned status text stands alone. Conditional and
 * negated phrasing ("once approved", "can't be refunded") is allowed.
 */
export function validateExplanation(
  text: string,
  outcome: RefundDecision["outcome"],
  amountUsd: number | null,
  moneyMoved: boolean = outcome === "approved",
): string {
  const t = text.trim();
  if (t.length === 0 || t.length > 600) return "";
  if (/\S+@\S+\.\S+/.test(t)) return "";
  if (
    /\b(auto-?approv\w*|playbook|threshold|supervisor-only|\$50\b|50 dollars)/i.test(
      t,
    )
  ) {
    return "";
  }
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (amountUsd === null || Math.abs(value - amountUsd) > 0.005) return "";
  }
  // The system doesn't call or email customers and sets the timeframes itself.
  if (
    /\b(?:reach out|reach you|contact you|email you|call you|get back to you|follow up with you|notif\w*|let you know|update you|within \d+|in \d+ (?:hours?|days?))\b/i.test(
      t,
    )
  ) {
    return "";
  }
  // Take out wording that doesn't claim anything has happened yet.
  const claims = t
    .replace(
      /\b(?:once|if|when|until|unless|before|after)\b[^.!?]{0,25}\b(?:approved|refunded|issued|processed)\b/gi,
      "",
    )
    .replace(
      /\b(?:can't|cannot|won't|isn't|aren't|wasn't|not|never|no)\b[^.!?]{0,25}\b(?:approved|refunded|issued|processed)\b/gi,
      "",
    );
  if (
    !moneyMoved &&
    /\b(?:refunded|issued|processed|money back|on its way|paid out|credited)\b/i.test(
      claims,
    )
  ) {
    return "";
  }
  if (outcome !== "approved" && /\bapproved\b/i.test(claims)) return "";
  if (
    outcome === "approved" &&
    /\b(?:rejected|denied|declined|can't be refunded|cannot be refunded)\b/i.test(
      t,
    )
  ) {
    return "";
  }
  return t;
}

export function decisionFromCase(
  c: RefundCase,
  explanation = "",
): RefundDecision {
  const outcome = OUTCOME[c.status];
  return {
    outcome,
    caseId: c.id,
    ruleApplied: c.ruleApplied,
    amountUsd: c.amountUsd,
    nextStep: NEXT[c.status],
    planEnded: c.status === "refunded" && c.endsPlan,
    statusText: statusTextFor(c),
    explanation: validateExplanation(
      explanation,
      outcome,
      c.amountUsd,
      c.status === "refunded",
    ),
  };
}

export type NeedsInfoKey =
  | "order_not_found"
  | "item_not_on_order"
  | "which_charge"
  | "confirm_plan_end"
  | "rate_limited"
  | "lookups_blocked";

export function needsInfoDecision(key: NeedsInfoKey): RefundDecision {
  return {
    outcome: "needs_info",
    caseId: null,
    ruleApplied: key,
    amountUsd: null,
    nextStep: "none",
    planEnded: false,
    statusText: getPolicy().needsInfo[key],
    explanation: "",
  };
}

/**
 * Why a case needs a person, written by code from the case itself. The
 * console shows this next to the agent's own note, which can't be trusted to
 * state the real reason.
 */
export function reviewReasonText(c: RefundCase): string {
  if (c.policyEligible) {
    return "The policy allows this refund. Refunds of this size need a person's approval.";
  }
  return fill(ruleText(c.ruleApplied).text, {});
}
