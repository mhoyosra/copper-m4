// Module 4: the case workflow. These use the in-memory store, so they need no
// database and no AI key. They check the state chart in specs/module-4/spec.md.
import { beforeEach, describe, expect, it } from "vitest";
import {
  declineCase,
  escalateCase,
  evaluate,
  issueRefund,
  markHandledElsewhere,
  markReceived,
  openCase,
} from "@/lib/copper/refunds/cases";
import {
  decisionFromCase,
  reviewReasonText,
  validateExplanation,
} from "@/lib/copper/refunds/decision";
import {
  createMemoryStore,
  type RefundStore,
} from "@/lib/copper/refunds/store";
import type {
  Order,
  OrderLine,
  RefundRequest,
  Subscription,
} from "@/lib/copper/refunds/types";

const NOW = new Date("2026-11-17T15:00:00Z");
const ago = (days: number, from = NOW) =>
  new Date(from.getTime() - days * 86_400_000).toISOString().slice(0, 10);

function line(over: Partial<OrderLine>): OrderLine {
  return {
    id: "L1",
    orderId: "O1",
    item: "copper-home",
    kind: "device",
    plan: null,
    amountUsd: 149,
    chargedAt: ago(8),
    deliveredAt: ago(5),
    billingPeriod: null,
    refundedUsd: 0,
    subscriptionId: null,
    ...over,
  };
}
const plusLine = (over: Partial<OrderLine>) =>
  line({
    item: "copper-plus",
    kind: "service",
    plan: "annual",
    amountUsd: 79,
    deliveredAt: null,
    subscriptionId: "S1",
    ...over,
  });

const request = (over: Partial<RefundRequest> = {}): RefundRequest => ({
  orderId: "O1",
  email: "a@example.com",
  item: "copper-home",
  reasonCode: "changed_mind",
  customerMessage: "I'd like to return it.",
  ...over,
});

const sub: Subscription = {
  id: "S1",
  orderId: "O1",
  plan: "annual",
  status: "active",
  endedAt: null,
};
let store: RefundStore;

async function open(o: Order, r: RefundRequest, now = NOW) {
  const verdict = await evaluate(store, o, r, now);
  return openCase(store, { request: r, order: o, verdict, now });
}

describe("device refund: reviewing, escalated, approved, received", () => {
  const o: Order = { id: "O1", email: "a@example.com", lines: [line({})] };
  beforeEach(() => {
    store = createMemoryStore({
      orders: [structuredClone(o)],
      subscriptions: [],
    });
  });

  it("walks the whole path and only pays when the device is received", async () => {
    const { case: c, created } = await open(o, request());
    expect(created).toBe(true);
    expect(c.status).toBe("reviewing");
    expect(c.autoApproved).toBe(false);

    // The agent can't approve it: it's over the limit and needs a person.
    expect(await issueRefund(store, c.id, "refund-agent")).toEqual({
      ok: false,
      reason: "needs_a_person",
    });

    const esc = await escalateCase(
      store,
      c.id,
      "over the limit",
      "refund-agent",
    );
    expect(esc.ok && esc.case.status).toBe("escalated");

    // Console approval: the device waits for its return, no money yet.
    const approved = await issueRefund(store, c.id, "console");
    expect(approved.ok && approved.case.status).toBe("awaiting_return");
    expect((await store.getOrderById("O1"))!.lines[0].refundedUsd).toBe(0);

    const received = await markReceived(store, c.id);
    expect(received.ok && received.case.status).toBe("refunded");
    expect((await store.getOrderById("O1"))!.lines[0].refundedUsd).toBe(149);
  });

  it("returns the existing case when the same line is submitted again", async () => {
    const first = await open(o, request());
    const second = await open(o, request());
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);
  });

  it("can't decide a case twice", async () => {
    const { case: c } = await open(o, request());
    await escalateCase(store, c.id, "x", "refund-agent");
    await issueRefund(store, c.id, "console");
    expect((await issueRefund(store, c.id, "console")).ok).toBe(false);
    expect((await declineCase(store, c.id, "late")).ok).toBe(false);
    await markReceived(store, c.id);
    expect((await markReceived(store, c.id)).ok).toBe(false);
    expect((await store.getOrderById("O1"))!.lines[0].refundedUsd).toBe(149);
  });

  it("a person can decline, or mark the case handled elsewhere", async () => {
    const { case: c } = await open(o, request());
    await escalateCase(store, c.id, "x", "refund-agent");
    const declined = await declineCase(store, c.id, "Out of policy");
    expect(declined.ok && declined.case.status).toBe("declined");
    expect(
      decisionFromCase((declined as { ok: true; case: never }).case).outcome,
    ).toBe("rejected");
  });

  it("an outage case can be declined or handled elsewhere but never refunded by the console", async () => {
    const r = request({ reasonCode: "outage_bug" });
    const { case: c } = await open(o, r);
    await escalateCase(store, c.id, "outage", "refund-agent");
    expect((await issueRefund(store, c.id, "console")).ok).toBe(false);
    const handled = await markHandledElsewhere(
      store,
      c.id,
      "Refunded by the supervisor outside the system",
    );
    expect(handled.ok && handled.case.status).toBe("handled_elsewhere");
  });

  it("only escalates a case that is reviewing", async () => {
    const { case: c } = await open(o, request());
    await escalateCase(store, c.id, "x", "refund-agent");
    await issueRefund(store, c.id, "console");
    expect((await escalateCase(store, c.id, "again", "refund-agent")).ok).toBe(
      false,
    );
  });

  it("logs every step to the case's event trail", async () => {
    const { case: c } = await open(o, request());
    await escalateCase(store, c.id, "over the limit", "refund-agent");
    await issueRefund(store, c.id, "console");
    await markReceived(store, c.id);
    const events = (await store.events(c.id)).map((e) => e.event);
    expect(events).toEqual([
      "case_opened",
      "escalated",
      "return_approved",
      "device_received_refunded",
    ]);
  });
});

describe("annual Plus: the refund and the plan ending happen together", () => {
  const o: Order = {
    id: "O1",
    email: "a@example.com",
    lines: [plusLine({ chargedAt: ago(5) })],
  };
  beforeEach(() => {
    store = createMemoryStore({
      orders: [structuredClone(o)],
      subscriptions: [structuredClone(sub)],
    });
  });
  const req = request({ item: "copper-plus", confirmsPlanEnds: true });

  it("ends the plan and refunds in one step when a person approves", async () => {
    const { case: c } = await open(o, req);
    expect(c.endsPlan).toBe(true);
    await escalateCase(store, c.id, "annual plan", "refund-agent");
    const done = await issueRefund(store, c.id, "console");
    expect(done.ok && done.case.status).toBe("refunded");
    expect((await store.subscriptionFor("O1"))!.status).toBe("ended");
    expect((await store.getOrderById("O1"))!.lines[0].refundedUsd).toBe(79);
    expect(
      decisionFromCase((done as { ok: true; case: never }).case).planEnded,
    ).toBe(true);
  });

  it("a retry never refunds or ends the plan twice", async () => {
    const { case: c } = await open(o, req);
    await escalateCase(store, c.id, "annual plan", "refund-agent");
    await issueRefund(store, c.id, "console");
    expect((await issueRefund(store, c.id, "console")).ok).toBe(false);
    expect((await store.getOrderById("O1"))!.lines[0].refundedUsd).toBe(79);
  });

  it("the agent can't issue it: a person always approves $79", async () => {
    const { case: c } = await open(o, req);
    expect(await issueRefund(store, c.id, "refund-agent")).toEqual({
      ok: false,
      reason: "needs_a_person",
    });
    expect((await store.subscriptionFor("O1"))!.status).toBe("active");
  });

  it("refuses to approve if the charge was already refunded in the meantime", async () => {
    const { case: c } = await open(o, req);
    await escalateCase(store, c.id, "annual plan", "refund-agent");
    // Another path refunded the line first.
    const order = await store.getOrderById("O1");
    order!.lines[0].refundedUsd = 79;
    store = createMemoryStore({
      orders: [order!],
      subscriptions: [structuredClone(sub)],
      cases: [{ ...c, status: "escalated" }],
    });
    expect(await issueRefund(store, c.id, "console")).toEqual({
      ok: false,
      reason: "changed_since_review",
    });
  });
});

describe("duplicate charge: the agent auto-refunds only the extra, plan keeps running", () => {
  const m = (id: string): OrderLine =>
    plusLine({
      id,
      plan: "monthly",
      amountUsd: 7.99,
      billingPeriod: "2026-11",
      chargedAt: ago(3),
    });
  const o: Order = {
    id: "O1",
    email: "a@example.com",
    lines: [m("M1"), m("M2")],
  };
  const req = request({ item: "copper-plus", reasonCode: "billing_error" });
  beforeEach(() => {
    store = createMemoryStore({
      orders: [structuredClone(o)],
      subscriptions: [{ ...structuredClone(sub), plan: "monthly" }],
    });
  });

  it("refunds the extra charge once", async () => {
    const { case: c } = await open(o, req);
    expect(c.autoApproved).toBe(true);
    expect(c.lineId).toBe("M2");
    const done = await issueRefund(store, c.id, "refund-agent");
    expect(done.ok && done.case.status).toBe("refunded");
    const after = await store.getOrderById("O1");
    expect(after!.lines.find((l) => l.id === "M2")!.refundedUsd).toBe(7.99);
    expect(after!.lines.find((l) => l.id === "M1")!.refundedUsd).toBe(0);
    expect((await store.subscriptionFor("O1"))!.status).toBe("active");
    expect((await issueRefund(store, c.id, "refund-agent")).ok).toBe(false);
  });

  it("counts the refund toward the 90-day $50 total", async () => {
    const { case: c } = await open(o, req);
    await issueRefund(store, c.id, "refund-agent");
    const since = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(await store.autoRefundedSince("a@example.com", since)).toBeCloseTo(
      7.99,
    );
    // A later request that would push the customer past $50 goes to a person.
    const o2: Order = {
      id: "O2",
      email: "a@example.com",
      lines: [
        plusLine({
          id: "N1",
          orderId: "O2",
          plan: "monthly",
          amountUsd: 45,
          billingPeriod: "2026-11",
          chargedAt: ago(1),
        }),
        plusLine({
          id: "N2",
          orderId: "O2",
          plan: "monthly",
          amountUsd: 45,
          billingPeriod: "2026-11",
          chargedAt: ago(1),
        }),
      ],
    };
    const v = await evaluate(
      store,
      o2,
      request({
        orderId: "O2",
        item: "copper-plus",
        reasonCode: "billing_error",
      }),
      NOW,
    );
    expect(v.result).toBe("escalate");
  });
});

describe("the window is judged as of the day the customer asked", () => {
  it("a request on day 29 is still approved after the window has passed", async () => {
    const delivered = "2026-01-01";
    const o: Order = {
      id: "O1",
      email: "a@example.com",
      lines: [line({ chargedAt: "2025-12-28", deliveredAt: delivered })],
    };
    store = createMemoryStore({ orders: [o], subscriptions: [] });
    const askedOnDay29 = new Date("2026-01-30T10:00:00Z");
    const { case: c } = await open(o, request(), askedOnDay29);
    expect(c.status).toBe("reviewing");
    await escalateCase(store, c.id, "x", "refund-agent");
    // Decided long after day 30: still allowed, because the request date counts.
    const done = await issueRefund(store, c.id, "console");
    expect(done.ok && done.case.status).toBe("awaiting_return");
  });
});

describe("rejections and needs_info", () => {
  it("a rejection is a finished case with the next best step in its text", async () => {
    const o: Order = {
      id: "O1",
      email: "a@example.com",
      lines: [line({ deliveredAt: ago(60), chargedAt: ago(65) })],
    };
    store = createMemoryStore({ orders: [o], subscriptions: [] });
    const { case: c } = await open(o, request({ reasonCode: "defective" }));
    expect(c.status).toBe("rejected");
    const d = decisionFromCase(c);
    expect(d.outcome).toBe("rejected");
    expect(d.statusText).toMatch(/warranty/i);
    expect(d.statusText).toContain(c.id);
  });

  it("needs_info creates no case", async () => {
    const o: Order = {
      id: "O1",
      email: "a@example.com",
      lines: [plusLine({ chargedAt: ago(2) })],
    };
    store = createMemoryStore({
      orders: [o],
      subscriptions: [structuredClone(sub)],
    });
    const verdict = await evaluate(
      store,
      o,
      request({ item: "copper-plus" }),
      NOW,
    );
    expect(verdict.result).toBe("needs_info");
    expect(
      await store.listCases(["reviewing", "rejected", "escalated"]),
    ).toHaveLength(0);
  });
});

describe("store basics", () => {
  beforeEach(() => {
    store = createMemoryStore();
  });
  it("finds an order only when the id and email both match", async () => {
    expect(await store.getOrder("CSL-1001", "ada@example.com")).not.toBeNull();
    expect(await store.getOrder("CSL-1001", "ADA@Example.com")).not.toBeNull();
    expect(await store.getOrder("CSL-1001", "ben@example.com")).toBeNull();
    expect(await store.getOrder("CSL-9999", "ada@example.com")).toBeNull();
  });
  it("counts attempts inside a time window", async () => {
    await store.recordAttempt("failed_lookup", "chat-1");
    await store.recordAttempt("failed_lookup", "chat-1");
    await store.recordAttempt("submission", "ada@example.com");
    const since = new Date(Date.now() - 1000);
    expect(await store.countAttempts("failed_lookup", "chat-1", since)).toBe(2);
    expect(await store.countAttempts("failed_lookup", "chat-2", since)).toBe(0);
    expect(
      await store.countAttempts("submission", "ADA@example.com", since),
    ).toBe(1);
    expect(
      await store.countAttempts(
        "submission",
        "ada@example.com",
        new Date(Date.now() + 1000),
      ),
    ).toBe(0);
  });
});

describe("the agent's explanation is kept only when it can't mislead", () => {
  it("keeps a friendly, consistent explanation", () => {
    expect(
      validateExplanation(
        "Thanks for your patience. A supervisor will look at this soon.",
        "escalated",
        149,
      ),
    ).not.toBe("");
    expect(
      validateExplanation(
        "Once approved, send the device back.",
        "escalated",
        149,
      ),
    ).not.toBe("");
  });
  it("drops claims that money moved when it hasn't, but allows conditional wording", () => {
    expect(validateExplanation("Sure, refunded!", "escalated", 149)).toBe("");
    expect(
      validateExplanation("Your refund will be issued soon.", "escalated", 149),
    ).toBe("");
    expect(
      validateExplanation("Your money is on its way.", "approved", 149, false),
    ).toBe("");
    expect(
      validateExplanation(
        "Your refund has been issued.",
        "approved",
        149,
        true,
      ),
    ).not.toBe("");
    expect(
      validateExplanation(
        "Once approved, we'll refund you after we receive the device.",
        "escalated",
        149,
      ),
    ).not.toBe("");
    expect(
      validateExplanation("That charge can't be refunded.", "rejected", null),
    ).not.toBe("");
  });
  it("drops promises the system doesn't keep: contact and timeframes", () => {
    expect(
      validateExplanation(
        "A supervisor will reach out to you directly.",
        "escalated",
        null,
      ),
    ).toBe("");
    expect(
      validateExplanation("We'll email you within 2 days.", "escalated", null),
    ).toBe("");
    expect(
      validateExplanation(
        "You will be notified as soon as there is an update.",
        "escalated",
        null,
      ),
    ).toBe("");
    expect(
      validateExplanation("Thanks for your patience.", "escalated", null),
    ).not.toBe("");
  });
  it("drops text that contradicts the outcome", () => {
    expect(
      validateExplanation(
        "Good news, your refund is approved!",
        "escalated",
        149,
      ),
    ).toBe("");
    expect(
      validateExplanation("We've refunded your money.", "rejected", null),
    ).toBe("");
    expect(
      validateExplanation("Sorry, this was rejected.", "approved", 149),
    ).toBe("");
  });
  it("drops other amounts, limits, emails and internal terms", () => {
    expect(validateExplanation("You'll get $500 back.", "approved", 149)).toBe(
      "",
    );
    expect(
      validateExplanation("You'll get $149.00 back.", "approved", 149),
    ).not.toBe("");
    expect(
      validateExplanation(
        "Anything under $50 is auto-approved.",
        "escalated",
        149,
      ),
    ).toBe("");
    expect(
      validateExplanation(
        "Per the playbook, a supervisor decides.",
        "escalated",
        null,
      ),
    ).toBe("");
    expect(
      validateExplanation("We emailed ada@example.com.", "escalated", null),
    ).toBe("");
    expect(validateExplanation("", "escalated", null)).toBe("");
  });
});

describe("why a case needs a person is written by code", () => {
  it("says so for an over-limit refund, and names the rule for an exception", async () => {
    const o: Order = { id: "O1", email: "a@example.com", lines: [line({})] };
    store = createMemoryStore({ orders: [o], subscriptions: [] });
    const over = await open(o, request());
    expect(reviewReasonText(over.case)).toMatch(/policy allows this refund/i);
    store = createMemoryStore({ orders: [o], subscriptions: [] });
    const outage = await open(o, request({ reasonCode: "outage_bug" }));
    expect(reviewReasonText(outage.case)).toMatch(/outage/i);
  });
});
