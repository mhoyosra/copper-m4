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
