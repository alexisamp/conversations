-- Structured key dates extracted from Conversations.
-- One row per meaningful date, not one JSON blob.
--
-- Daily query example:
--   select *
--   from contact_key_dates
--   where user_id = auth.uid()
--     and (
--       date_value = current_date
--       or (
--         date_precision = 'month_day'
--         and to_char(current_date, 'MM-DD') = date_value
--       )
--     );

create table if not exists public.contact_key_dates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.outreach_logs(id) on delete cascade,
  event_type text not null check (
    event_type in ('birthday', 'anniversary', 'travel', 'return', 'move', 'important_date')
  ),
  subject text not null,
  relation text,
  date_value text,
  date_precision text not null default 'unknown' check (
    date_precision in ('exact', 'month_day', 'month', 'year', 'unknown')
  ),
  description text not null,
  source text not null default 'chat_capture',
  source_interaction_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contact_key_dates enable row level security;

create policy "contact_key_dates select own"
  on public.contact_key_dates for select
  using (auth.uid() = user_id);

create policy "contact_key_dates insert own"
  on public.contact_key_dates for insert
  with check (auth.uid() = user_id);

create policy "contact_key_dates update own"
  on public.contact_key_dates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists contact_key_dates_user_date_idx
  on public.contact_key_dates(user_id, date_precision, date_value);

create index if not exists contact_key_dates_contact_idx
  on public.contact_key_dates(contact_id, event_type);
