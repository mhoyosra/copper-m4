// Reads refund-policy.json: the only place refund rules, limits and
// customer-facing text live.
import policyData from "@/lib/copper/data/refund-policy.json";

export type RefundPolicy = typeof policyData;

export function getPolicy(): RefundPolicy {
  return policyData;
}

/** Fills {name} placeholders in a policy text. Unknown names are left as-is. */
export function fill(
  template: string,
  values: Record<string, string | number>,
  policy: RefundPolicy = policyData,
): string {
  const all: Record<string, string | number> = {
    ...policy.sources,
    terms3: policy.terms3,
    reviewDays: policy.reviewTargetBusinessDays,
    ...values,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in all ? String(all[key]) : match,
  );
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
