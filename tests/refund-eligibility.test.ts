// Module 4: the refund rules engine. Plain code, so these run with no AI key.
// Every boundary in specs/module-4/spec.md has a case here.
import { describe, expect, it } from "vitest";
import {
  checkRefundEligibility,
  daysSince,
  findDuplicateExtra,
  type EligibilityInput,
} from "@/lib/copper/refunds/eligibility";
import type { Order, OrderLine } from "@/lib/copper/refunds/types";

const NOW = new Date("2026-11-17T15:00:00Z");
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

function line(over: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "L1",
    orderId: "O1",
    item: "copper-home",
    kind: "device",
    plan: null,
    amountUsd: 149,
    chargedAt: ago(40),
    deliveredAt: ago(5),
    billingPeriod: null,
    refundedUsd: 0,
    subscriptionId: null,
    ...over,
  };
}
const order = (...lines: OrderLine[]): Order => ({
  id: "O1",
  email: "a@example.com",
  lines,
});

const device = (daysAgo: number | null, over: Partial<OrderLine> = {}) =>
  line({ deliveredAt: daysAgo === null ? null : ago(daysAgo), ...over });
const plus = (over: Partial<OrderLine> = {}) =>
  line({
    id: "P1",
    item: "copper-plus",
    kind: "service",
    plan: "annual",
    amountUsd: 79,
    deliveredAt: null,
    subscriptionId: "S1",
    ...over,
  });

function check(
  o: Order,
  request: Partial<EligibilityInput["request"]> & {
    item: EligibilityInput["request"]["item"];
  },
  prior = 0,
) {
  return checkRefundEligibility({
    order: o,
    request: { reasonCode: "changed_mind", ...request },
    requestedAt: NOW,
    priorAutoRefundedUsd: prior,
  });
}

describe("day counting", () => {
  it("counts whole days between dates", () => {
    expect(daysSince(ago(0), NOW)).toBe(0);
    expect(daysSince(ago(30), NOW)).toBe(30);
  });
});

describe("devices (Terms 2.1 to 2.5)", () => {
  it("is eligible on day 30 after delivery, and goes to a person because it is over $50", () => {
    const v = check(order(device(30)), { item: "copper-home" });
    expect(v).toMatchObject({
      result: "escalate",
      ruleApplied: "device_return_30d",
      policyEligible: true,
      reviewReason: "over_limit",
      amountUsd: 149,
      requiresReturn: true,
      endsPlan: false,
    });
  });
  it("is rejected on day 31", () => {
    const v = check(order(device(31)), { item: "copper-home" });
    expect(v).toMatchObject({
      result: "not_eligible",
      ruleApplied: "device_after_window",
    });
  });
  it("counts the window from delivery, not purchase", () => {
    const o = order(device(5, { chargedAt: ago(90) }));
    expect(check(o, { item: "copper-home" }).ruleApplied).toBe(
      "device_return_30d",
    );
  });
  it("accepts any reason inside the window", () => {
    for (const reasonCode of ["changed_mind", "defective", "other"] as const) {
      expect(
        check(order(device(10)), { item: "copper-home", reasonCode })
          .policyEligible,
      ).toBe(true);
    }
  });
  it("points a defect after the window to the warranty route", () => {
    const v = check(order(device(60)), {
      item: "copper-home",
      reasonCode: "defective",
    });
    expect(v.ruleApplied).toBe("device_after_window_defect");
    expect(v.result).toBe("not_eligible");
  });
  it("sends a device not yet received to a person", () => {
    const v = check(order(device(null)), { item: "copper-home" });
    expect(v).toMatchObject({
      result: "escalate",
      ruleApplied: "device_not_delivered",
      policyEligible: false,
    });
  });
  it("rejects a device that is already fully refunded", () => {
    const v = check(order(device(5, { refundedUsd: 149 })), {
      item: "copper-home",
    });
    expect(v.ruleApplied).toBe("already_refunded");
  });
  it("never ends the Plus plan", () => {
    expect(check(order(device(5)), { item: "copper-home" }).endsPlan).toBe(
      false,
    );
  });
});

describe("annual Copper Plus (Terms 4.6, FAQ p.5)", () => {
  it("is eligible on day 14 after the charge, ends the plan, and goes to a person ($79 > $50)", () => {
    const v = check(order(plus({ chargedAt: ago(14) })), {
      item: "copper-plus",
      confirmsPlanEnds: true,
    });
    expect(v).toMatchObject({
      result: "escalate",
      ruleApplied: "service_annual_14d",
      endsPlan: true,
      amountUsd: 79,
      requiresReturn: false,
    });
  });
  it("is rejected on day 15, with the cancel-anytime next step in the policy text", () => {
    const v = check(order(plus({ chargedAt: ago(15) })), {
      item: "copper-plus",
      confirmsPlanEnds: true,
    });
    expect(v).toMatchObject({
      result: "not_eligible",
      ruleApplied: "service_annual_after_14d",
    });
  });
  it("counts from the charge date even if the device was bought earlier or later", () => {
    const o = order(
      device(200, { chargedAt: ago(210) }),
      plus({ chargedAt: ago(3) }),
    );
    expect(
      check(o, { item: "copper-plus", confirmsPlanEnds: true }).ruleApplied,
    ).toBe("service_annual_14d");
  });
  it("needs the customer's confirmation that the plan ends", () => {
    const v = check(order(plus({ chargedAt: ago(2) })), {
      item: "copper-plus",
    });
    expect(v).toMatchObject({
      result: "needs_info",
      needsInfo: "confirm_plan_end",
    });
    const no = check(order(plus({ chargedAt: ago(2) })), {
      item: "copper-plus",
      confirmsPlanEnds: false,
    });
    expect(no.result).toBe("needs_info");
  });
  it("treats a renewal as a new purchase", () => {
    const o = order(
      plus({ id: "P-old", chargedAt: ago(365) }),
      plus({ id: "P-new", chargedAt: ago(4) }),
    );
    const v = check(o, {
      item: "copper-plus",
      chargeId: "P-new",
      confirmsPlanEnds: true,
    });
    expect(v.ruleApplied).toBe("service_annual_14d");
  });
});

describe("monthly Copper Plus, free plan and which charge", () => {
  const monthly = (id: string, period: string, daysAgo: number) =>
    plus({
      id,
      plan: "monthly",
      amountUsd: 7.99,
      billingPeriod: period,
      chargedAt: ago(daysAgo),
    });

  it("rejects a monthly plan (no partial-month refunds)", () => {
    const v = check(order(monthly("M1", "2026-11", 2)), {
      item: "copper-plus",
    });
    expect(v).toMatchObject({
      result: "not_eligible",
      ruleApplied: "service_monthly_no_partial",
    });
  });
  it("rejects the free plan: nothing to refund", () => {
    const v = check(order(plus({ plan: "free", amountUsd: 0 })), {
      item: "copper-plus",
    });
    expect(v.ruleApplied).toBe("service_free_plan");
  });
  it("asks which charge when there are several and none is named", () => {
    const o = order(
      monthly("M1", "2026-09", 60),
      monthly("M2", "2026-10", 30),
      monthly("M3", "2026-11", 1),
    );
    expect(check(o, { item: "copper-plus" })).toMatchObject({
      result: "needs_info",
      needsInfo: "which_charge",
    });
  });
  it("uses the named charge", () => {
    const o = order(monthly("M1", "2026-09", 60), monthly("M2", "2026-10", 30));
    const v = check(o, { item: "copper-plus", chargeId: "M2" });
    expect(v.lineId).toBe("M2");
  });
  it("asks again when the named charge isn't on the order", () => {
    const o = order(monthly("M1", "2026-09", 60), monthly("M2", "2026-10", 30));
    expect(check(o, { item: "copper-plus", chargeId: "nope" }).needsInfo).toBe(
      "which_charge",
    );
  });
  it("says so when the item isn't on the order", () => {
    expect(check(order(device(5)), { item: "copper-notes" }).needsInfo).toBe(
      "item_not_on_order",
    );
  });
});

describe("duplicate charges and billing errors", () => {
  const m = (id: string, period: string, over: Partial<OrderLine> = {}) =>
    plus({
      id,
      plan: "monthly",
      amountUsd: 7.99,
      billingPeriod: period,
      chargedAt: ago(3),
      ...over,
    });

  it("finds the extra charge for one period", () => {
    const lines = [m("M1", "2026-11"), m("M2", "2026-11")];
    expect(findDuplicateExtra(lines)?.id).toBe("M2");
    expect(
      findDuplicateExtra([m("M1", "2026-10"), m("M2", "2026-11")]),
    ).toBeNull();
  });
  it("refunds only the extra charge, auto-approves it, and keeps the plan", () => {
    const o = order(m("M1", "2026-11"), m("M2", "2026-11"));
    const v = check(o, { item: "copper-plus", reasonCode: "billing_error" });
    expect(v).toMatchObject({
      result: "eligible",
      ruleApplied: "service_duplicate_charge",
      lineId: "M2",
      amountUsd: 7.99,
      endsPlan: false,
    });
  });
  it("escalates any other billing_error claim", () => {
    const v = check(order(m("M1", "2026-11")), {
      item: "copper-plus",
      reasonCode: "billing_error",
    });
    expect(v).toMatchObject({
      result: "escalate",
      ruleApplied: "service_billing_error_other",
      policyEligible: false,
    });
  });
  it("won't refund a duplicate that was already refunded", () => {
    const o = order(
      m("M1", "2026-11"),
      m("M2", "2026-11", { refundedUsd: 7.99 }),
    );
    const v = check(o, { item: "copper-plus", reasonCode: "billing_error" });
    expect(v.result).not.toBe("eligible");
  });
});

describe("outage and bug exceptions", () => {
  it("always escalates, for devices and services, however it is worded", () => {
    for (const item of ["copper-home", "copper-plus"] as const) {
      const v = check(order(device(2), plus({ chargedAt: ago(2) })), {
        item,
        reasonCode: "outage_bug",
        confirmsPlanEnds: true,
      });
      expect(v).toMatchObject({
        result: "escalate",
        ruleApplied: "exception_outage_bug",
        policyEligible: false,
        reviewReason: "exception",
        amountUsd: null,
      });
    }
  });
});

describe("the $50 auto-approve limit", () => {
  const cheap = (amount: number) =>
    plus({ plan: "monthly", amountUsd: amount, billingPeriod: "2026-11" });
  const dupOrder = (amount: number) =>
    order(
      cheap(amount),
      plus({
        id: "P2",
        plan: "monthly",
        amountUsd: amount,
        billingPeriod: "2026-11",
      }),
    );
  const dup = (amount: number, prior = 0) =>
    check(
      dupOrder(amount),
      { item: "copper-plus", reasonCode: "billing_error" },
      prior,
    );

  it("auto-approves exactly $50", () =>
    expect(dup(50).result).toBe("eligible"));
  it("escalates $50.01", () => {
    const v = dup(50.01);
    expect(v).toMatchObject({
      result: "escalate",
      reviewReason: "over_limit",
      policyEligible: true,
    });
  });
  it("counts the customer's earlier auto-approved refunds in the 90 days", () => {
    expect(dup(7.99, 42.01).result).toBe("eligible");
    expect(dup(7.99, 42.02).result).toBe("escalate");
  });
  it("sends every device refund to a person, since devices cost more than $50", () => {
    expect(check(order(device(3)), { item: "copper-home" }).result).toBe(
      "escalate",
    );
    expect(
      check(order(device(3, { item: "copper-notes", amountUsd: 129 })), {
        item: "copper-notes",
      }).result,
    ).toBe("escalate");
  });
});

describe("amounts", () => {
  it("is the amount on the order line minus anything already refunded", () => {
    const v = check(order(device(5, { amountUsd: 149, refundedUsd: 40 })), {
      item: "copper-home",
    });
    expect(v.amountUsd).toBe(109);
  });
});
