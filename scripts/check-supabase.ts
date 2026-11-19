// npm run check-supabase: runs the refund workflow against your real Supabase
// tables (no AI calls) and then puts the demo orders back the way they were.
// Run it after applying supabase/setup.sql and `npm run setup-supabase`.
import {
  declineCase,
  escalateCase,
  evaluate,
  issueRefund,
  markReceived,
  openCase,
} from "@/lib/copper/refunds/cases";
import { createSupabaseStore } from "@/lib/copper/refunds/supabase-store";
import type { RefundRequest } from "@/lib/copper/refunds/types";
import {
  createAdminClient,
  isSupabaseAdminConfigured,
} from "@/lib/supabase/admin";

if (!isSupabaseAdminConfigured()) {
  console.error(
    "Supabase isn't set up. Run `npm run setup-supabase` first (see specs/module-4/spec.md).",
  );
  process.exit(1);
}

const db = createAdminClient()!;
const store = createSupabaseStore();
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

const req = (over: Partial<RefundRequest>): RefundRequest => ({
  orderId: "CSL-1005",
  email: "eve@example.com",
  item: "copper-plus",
  reasonCode: "billing_error",
  customerMessage: "check-supabase",
  ...over,
});

async function open(r: RefundRequest) {
  const order = (await store.getOrder(r.orderId, r.email))!;
  const verdict = await evaluate(store, order, r, new Date());
  return openCase(store, { request: r, order, verdict });
}

const ORDERS = ["CSL-1001", "CSL-1003", "CSL-1005"];

async function cleanup() {
  const { data: cases } = await db
    .from("refund_cases")
    .select("id")
    .in("order_id", ORDERS);
  const ids = (cases ?? []).map((c: { id: string }) => c.id);
  if (ids.length) {
    await db.from("case_events").delete().in("case_id", ids);
    await db.from("refund_cases").delete().in("id", ids);
  }
  await db
    .from("order_lines")
    .update({ refunded_usd: 0 })
    .in("order_id", ORDERS);
  await db
    .from("subscriptions")
    .update({ status: "active", ended_at: null })
    .in("order_id", ORDERS);
  await db
    .from("refund_attempts")
    .delete()
    .in("key", ["check-supabase-chat", "eve@example.com"]);
}

async function main() {
  await cleanup();

  // Lookups need the id AND the email.
  check(
    "order found with the right email",
    (await store.getOrder("CSL-1005", "EVE@example.com")) !== null,
  );
  check(
    "order not found with the wrong email",
    (await store.getOrder("CSL-1005", "x@example.com")) === null,
  );

  // A duplicate charge: auto-refunded, plan keeps running, no double refund.
  const dup = await open(req({}));
  check(
    "duplicate charge opens an auto-approvable case",
    dup.created && dup.case.autoApproved,
  );
  const paid = await issueRefund(store, dup.case.id, "refund-agent");
  check(
    "agent refunds the duplicate",
    paid.ok && paid.case.status === "refunded",
  );
  const eve = (await store.getOrderById("CSL-1005"))!;
  check(
    "only the extra charge is refunded",
    eve.lines.filter((l) => l.refundedUsd > 0).length === 1,
  );
  check(
    "the plan keeps running",
    (await store.subscriptionFor("CSL-1005"))?.status === "active",
  );
  check(
    "a second refund is refused",
    !(await issueRefund(store, dup.case.id, "refund-agent")).ok,
  );

  // Two requests at the same moment: the database index lets only one through.
  const ada = req({
    orderId: "CSL-1001",
    email: "ada@example.com",
    item: "copper-home",
    reasonCode: "changed_mind",
  });
  const [a, b] = await Promise.all([open(ada), open(ada)]);
  check(
    "two simultaneous requests create exactly one case",
    [a, b].filter((x) => x.created).length === 1,
  );
  const device = a.created ? a.case : b.case;

  // A device: escalated, approved (awaiting the return), then received.
  check(
    "device refund escalates on the case record",
    (await escalateCase(store, device.id, "check", "refund-agent")).ok,
  );
  const approved = await issueRefund(store, device.id, "console");
  check(
    "approval moves the device to awaiting_return",
    approved.ok && approved.case.status === "awaiting_return",
  );
  check(
    "no money moved yet",
    (await store.getOrderById("CSL-1001"))!.lines[0].refundedUsd === 0,
  );
  const received = await markReceived(store, device.id);
  check(
    "marking it received refunds it",
    received.ok && received.case.status === "refunded",
  );
  check(
    "the device line shows the refund",
    (await store.getOrderById("CSL-1001"))!.lines[0].refundedUsd === 149,
  );

  // Annual Plus: the refund and the plan ending happen together.
  const plus = await open(
    req({
      orderId: "CSL-1003",
      email: "cara@example.com",
      reasonCode: "changed_mind",
      confirmsPlanEnds: true,
    }),
  );
  check(
    "annual Plus escalates, with endsPlan",
    plus.case.endsPlan && plus.case.status === "reviewing",
  );
  await escalateCase(store, plus.case.id, "annual", "refund-agent");
  const ended = await issueRefund(store, plus.case.id, "console");
  check(
    "approval refunds the annual plan",
    ended.ok && ended.case.status === "refunded",
  );
  check(
    "and ends the subscription in the same step",
    (await store.subscriptionFor("CSL-1003"))?.status === "ended",
  );

  // Decisions can't be repeated; the event trail is written; attempts are counted.
  check(
    "a decided case can't be declined",
    !(await declineCase(store, plus.case.id, "late")).ok,
  );
  const events = (await store.events(device.id)).map((e) => e.event);
  check(
    "the event trail records each step",
    events.join(",") ===
      "case_opened,escalated,return_approved,device_received_refunded",
  );
  await store.recordAttempt("failed_lookup", "check-supabase-chat");
  check(
    "attempts are counted",
    (await store.countAttempts(
      "failed_lookup",
      "check-supabase-chat",
      new Date(Date.now() - 60_000),
    )) === 1,
  );
}

main()
  .catch((e) => {
    console.error("Error:", e instanceof Error ? e.message : e);
    results.push(["ran without an error", false]);
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter(([, ok]) => !ok).length;
    console.log(
      `\n${results.length - failed} of ${results.length} checks passed. Demo orders reset.`,
    );
    process.exit(failed ? 1 : 0);
  });
