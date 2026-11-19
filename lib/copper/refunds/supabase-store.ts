// The Supabase version of the RefundStore (supabase/migrations/…_refunds.sql).
// It is not run by the tests (they use the in-memory store); try it by setting
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
import type { AttemptKind, RefundStore } from "@/lib/copper/refunds/store";
import {
  type CaseEvent,
  type CaseStatus,
  LIVE_STATUSES,
  type Order,
  type OrderLine,
  type RefundCase,
  type Subscription,
} from "@/lib/copper/refunds/types";
import { createAdminClient } from "@/lib/supabase/admin";

/* eslint-disable @typescript-eslint/no-explicit-any -- database rows arrive untyped */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const toLine = (r: any): OrderLine => ({
  id: r.id,
  orderId: r.order_id,
  item: r.item,
  kind: r.kind,
  plan: r.plan,
  amountUsd: Number(r.amount_usd),
  chargedAt: r.charged_at,
  deliveredAt: r.delivered_at,
  billingPeriod: r.billing_period,
  refundedUsd: Number(r.refunded_usd),
  subscriptionId: r.subscription_id,
});

const toCase = (r: any): RefundCase => ({
  id: r.id,
  orderId: r.order_id,
  lineId: r.line_id,
  email: r.email,
  item: r.item,
  kind: r.kind,
  status: r.status,
  ruleApplied: r.rule_applied,
  amountUsd: num(r.amount_usd),
  endsPlan: r.ends_plan,
  requiresReturn: r.requires_return,
  policyEligible: r.policy_eligible,
  autoApproved: r.auto_approved,
  reasonCode: r.reason_code,
  customerMessage: r.customer_message,
  summary: r.summary,
  requestedAt: r.requested_at,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  note: r.note,
});

const fromCase = (c: Partial<RefundCase>) => {
  const map: Record<string, string> = {
    orderId: "order_id",
    lineId: "line_id",
    ruleApplied: "rule_applied",
    amountUsd: "amount_usd",
    endsPlan: "ends_plan",
    requiresReturn: "requires_return",
    policyEligible: "policy_eligible",
    autoApproved: "auto_approved",
    reasonCode: "reason_code",
    customerMessage: "customer_message",
    requestedAt: "requested_at",
    decidedBy: "decided_by",
    decidedAt: "decided_at",
  };
  return Object.fromEntries(
    Object.entries(c).map(([k, v]) => [map[k] ?? k, v]),
  );
};

export function createSupabaseStore(): RefundStore {
  const db = () => {
    const client = createAdminClient();
    if (!client) throw new Error("Supabase isn't set up.");
    return client;
  };

  async function loadOrder(query: (q: any) => any): Promise<Order | null> {
    const { data } = await query(
      db().from("orders").select("id, email"),
    ).maybeSingle();
    if (!data) return null;
    const { data: lines } = await db()
      .from("order_lines")
      .select("*")
      .eq("order_id", data.id)
      .order("charged_at");
    return { id: data.id, email: data.email, lines: (lines ?? []).map(toLine) };
  }

  const liveCaseForLine = async (lineId: string) => {
    const { data } = await db()
      .from("refund_cases")
      .select("*")
      .eq("line_id", lineId)
      .in("status", LIVE_STATUSES)
      .maybeSingle();
    return data ? toCase(data) : null;
  };

  return {
    kind: "supabase",
    getOrder: (orderId, email) =>
      loadOrder((q) => q.eq("id", orderId).ilike("email", email)),
    getOrderById: (orderId) => loadOrder((q) => q.eq("id", orderId)),

    async autoRefundedSince(email, since) {
      const { data } = await db()
        .from("refund_cases")
        .select("amount_usd")
        .ilike("email", email)
        .eq("auto_approved", true)
        .in("status", ["refunded", "awaiting_return"])
        .gte("requested_at", since.toISOString());
      return (data ?? []).reduce(
        (s: number, r: any) => s + Number(r.amount_usd ?? 0),
        0,
      );
    },

    async createCase(c) {
      const { data, error } = await db()
        .from("refund_cases")
        .insert(fromCase(c))
        .select()
        .single();
      if (error) {
        // 23505 = the one-live-case-per-line index: return the case that won.
        if (error.code === "23505" && c.lineId) {
          const existing = await liveCaseForLine(c.lineId);
          if (existing) return { case: existing, created: false };
        }
        throw new Error(error.message);
      }
      return { case: toCase(data), created: true };
    },

    async getCase(id) {
      const { data } = await db()
        .from("refund_cases")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      return data ? toCase(data) : null;
    },
    async casesForOrder(orderId) {
      const { data } = await db()
        .from("refund_cases")
        .select("*")
        .eq("order_id", orderId)
        .order("requested_at");
      return (data ?? []).map(toCase);
    },
    async listCases(statuses: CaseStatus[]) {
      const { data } = await db()
        .from("refund_cases")
        .select("*")
        .in("status", statuses)
        .order("requested_at");
      return (data ?? []).map(toCase);
    },
    async transition(id, from, patch) {
      const { data } = await db()
        .from("refund_cases")
        .update(fromCase(patch))
        .eq("id", id)
        .in("status", from)
        .select();
      return data && data.length > 0 ? toCase(data[0]) : null;
    },
    async applyRefund({ caseId, from, decidedBy }) {
      const { data, error } = await db().rpc("apply_refund", {
        p_case_id: caseId,
        p_from: from,
        p_decided_by: decidedBy,
      });
      if (error || !data || !(data as any).id) return null;
      return toCase(data);
    },

    async addEvent(e: CaseEvent) {
      await db().from("case_events").insert({
        case_id: e.caseId,
        at: e.at,
        actor: e.actor,
        event: e.event,
        detail: e.detail,
      });
    },
    async events(caseId) {
      const { data } = await db()
        .from("case_events")
        .select("*")
        .eq("case_id", caseId)
        .order("id");
      return (data ?? []).map((r: any) => ({
        caseId: r.case_id,
        at: r.at,
        actor: r.actor,
        event: r.event,
        detail: r.detail,
      }));
    },

    async recordAttempt(kind: AttemptKind, key) {
      await db()
        .from("refund_attempts")
        .insert({ kind, key: key.toLowerCase() });
    },
    async countAttempts(kind: AttemptKind, key, since) {
      const { count } = await db()
        .from("refund_attempts")
        .select("id", { count: "exact", head: true })
        .eq("kind", kind)
        .eq("key", key.toLowerCase())
        .gte("at", since.toISOString());
      return count ?? 0;
    },

    async subscriptionFor(orderId): Promise<Subscription | null> {
      const { data } = await db()
        .from("subscriptions")
        .select("*")
        .eq("order_id", orderId)
        .limit(1)
        .maybeSingle();
      return data
        ? {
            id: data.id,
            orderId: data.order_id,
            plan: data.plan,
            status: data.status,
            endedAt: data.ended_at,
          }
        : null;
    },
  };
}
