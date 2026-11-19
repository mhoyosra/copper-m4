-- Module 4 setup: paste this whole file into the Supabase SQL Editor and run it once.
-- It is supabase/migrations/20261117000000_refunds.sql followed by supabase/seed.sql.
-- Safe to run more than once.

-- Module 4: refunds. Orders, one line per device or subscription charge,
-- subscriptions, refund cases and an append-only event log.
-- Everything is readable and writable only with the server's secret key: there
-- are no row-level-security policies, so the publishable key can touch none of it.

create table if not exists orders (
  id text primary key,
  email text not null
);

create table if not exists subscriptions (
  id text primary key,
  order_id text not null references orders (id),
  plan text not null check (plan in ('annual', 'monthly', 'free')),
  status text not null default 'active' check (status in ('active', 'ended')),
  ended_at timestamptz
);

create table if not exists order_lines (
  id text primary key,
  order_id text not null references orders (id),
  item text not null check (item in ('copper-home', 'copper-notes', 'copper-plus')),
  kind text not null check (kind in ('device', 'service')),
  plan text check (plan in ('annual', 'monthly', 'free')),
  amount_usd numeric(10, 2) not null check (amount_usd >= 0),
  charged_at date not null,
  delivered_at date,
  billing_period text,
  refunded_usd numeric(10, 2) not null default 0 check (refunded_usd >= 0),
  subscription_id text references subscriptions (id)
);

create table if not exists refund_cases (
  id uuid primary key,
  order_id text not null references orders (id),
  line_id text references order_lines (id),
  email text not null,
  item text not null,
  kind text,
  status text not null check (
    status in ('reviewing', 'rejected', 'escalated', 'awaiting_return', 'refunded', 'declined', 'handled_elsewhere')
  ),
  rule_applied text not null,
  amount_usd numeric(10, 2),
  ends_plan boolean not null default false,
  requires_return boolean not null default false,
  policy_eligible boolean not null default false,
  auto_approved boolean not null default false,
  reason_code text not null,
  customer_message text not null,
  summary text,
  requested_at timestamptz not null,
  decided_by text,
  decided_at timestamptz,
  note text
);

-- One live or paid case per order line, enforced by the database, so two
-- requests at the same moment can never both get through.
create unique index if not exists refund_cases_one_live_case_per_line
  on refund_cases (line_id)
  where line_id is not null
    and status in ('reviewing', 'escalated', 'awaiting_return', 'refunded');

create table if not exists case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references refund_cases (id),
  at timestamptz not null default now(),
  actor text not null,
  event text not null,
  detail text
);

-- Rate limiting: refund submissions per email and failed lookups per chat.
create table if not exists refund_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('submission', 'failed_lookup')),
  key text not null,
  at timestamptz not null default now()
);
create index if not exists refund_attempts_lookup on refund_attempts (kind, key, at);

alter table orders enable row level security;
alter table subscriptions enable row level security;
alter table order_lines enable row level security;
alter table refund_cases enable row level security;
alter table case_events enable row level security;
alter table refund_attempts enable row level security;

-- Marks a case refunded, adds the amount to its line, and ends the
-- subscription when the rule says so: all in one transaction, so either all
-- three happen or none do.
create or replace function apply_refund(p_case_id uuid, p_from text[], p_decided_by text)
returns refund_cases
language plpgsql
as $$
declare
  c refund_cases;
  l order_lines;
begin
  select * into c from refund_cases where id = p_case_id for update;
  if not found or not (c.status = any (p_from)) or c.line_id is null or c.amount_usd is null then
    return null;
  end if;
  select * into l from order_lines where id = c.line_id for update;
  if not found then
    return null;
  end if;
  update order_lines set refunded_usd = refunded_usd + c.amount_usd where id = c.line_id;
  if c.ends_plan and l.subscription_id is not null then
    update subscriptions set status = 'ended', ended_at = now() where id = l.subscription_id;
  end if;
  update refund_cases
    set status = 'refunded', decided_by = p_decided_by, decided_at = now()
    where id = p_case_id
    returning * into c;
  return c;
end;
$$;

-- Module 4 demo orders (fictional), dated relative to today so the 30-day and
-- 14-day windows always behave the same way. Safe to run more than once.
insert into orders (id, email) values
  ('CSL-1001', 'ada@example.com'),
  ('CSL-1002', 'ben@example.com'),
  ('CSL-1003', 'cara@example.com'),
  ('CSL-1004', 'dan@example.com'),
  ('CSL-1005', 'eve@example.com'),
  ('CSL-1006', 'fay@example.com'),
  ('CSL-1007', 'gus@example.com'),
  ('CSL-1008', 'hal@example.com')
on conflict (id) do nothing;

insert into subscriptions (id, order_id, plan) values
  ('S-1003', 'CSL-1003', 'annual'),
  ('S-1004', 'CSL-1004', 'annual'),
  ('S-1005', 'CSL-1005', 'monthly'),
  ('S-1006', 'CSL-1006', 'monthly'),
  ('S-1007', 'CSL-1007', 'free'),
  ('S-1008', 'CSL-1008', 'monthly')
on conflict (id) do nothing;

insert into order_lines (id, order_id, item, kind, plan, amount_usd, charged_at, delivered_at, billing_period, subscription_id) values
  ('L-1001-1', 'CSL-1001', 'copper-home', 'device', null, 149, current_date - 12, current_date - 10, null, null),
  ('L-1002-1', 'CSL-1002', 'copper-notes', 'device', null, 129, current_date - 50, current_date - 45, null, null),
  ('L-1003-1', 'CSL-1003', 'copper-plus', 'service', 'annual', 79, current_date - 5, null, null, 'S-1003'),
  ('L-1004-1', 'CSL-1004', 'copper-plus', 'service', 'annual', 79, current_date - 30, null, null, 'S-1004'),
  ('L-1005-1', 'CSL-1005', 'copper-plus', 'service', 'monthly', 7.99, current_date - 3, null, to_char(current_date - 3, 'YYYY-MM'), 'S-1005'),
  ('L-1005-2', 'CSL-1005', 'copper-plus', 'service', 'monthly', 7.99, current_date - 3, null, to_char(current_date - 3, 'YYYY-MM'), 'S-1005'),
  ('L-1006-1', 'CSL-1006', 'copper-plus', 'service', 'monthly', 7.99, current_date - 2, null, to_char(current_date - 2, 'YYYY-MM'), 'S-1006'),
  ('L-1007-1', 'CSL-1007', 'copper-plus', 'service', 'free', 0, current_date - 20, null, null, 'S-1007'),
  ('L-1008-1', 'CSL-1008', 'copper-plus', 'service', 'monthly', 7.99, current_date - 60, null, to_char(current_date - 60, 'YYYY-MM'), 'S-1008'),
  ('L-1008-2', 'CSL-1008', 'copper-plus', 'service', 'monthly', 7.99, current_date - 30, null, to_char(current_date - 30, 'YYYY-MM'), 'S-1008'),
  ('L-1008-3', 'CSL-1008', 'copper-plus', 'service', 'monthly', 7.99, current_date - 1, null, to_char(current_date - 1, 'YYYY-MM'), 'S-1008')
on conflict (id) do nothing;
