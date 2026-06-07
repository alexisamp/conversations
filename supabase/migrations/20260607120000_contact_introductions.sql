-- Relational introductions extracted from Conversations.
-- One row per intro/referral edge candidate, not one JSON blob.
--
-- The AI can usually extract names/context before every mentioned person
-- exists in reThink. For that reason this table stores both raw names and
-- nullable contact ids that the review UI can link later.

create table if not exists public.contact_introductions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Contact whose conversation produced this evidence.
  source_contact_id uuid not null references public.outreach_logs(id) on delete cascade,

  -- Resolved relationship endpoints. Nullable until review/linking.
  connector_contact_id uuid references public.outreach_logs(id) on delete set null,
  introduced_contact_id uuid references public.outreach_logs(id) on delete set null,
  introduced_to_contact_id uuid references public.outreach_logs(id) on delete set null,

  -- Human-readable captured values used before/alongside linking.
  connector_name text,
  introduced_person_name text,
  introduced_person_company text,
  introduced_to_name text,
  introduced_to_company text,

  relationship_context text,
  status text not null default 'made' check (
    status in ('requested', 'offered', 'made', 'received')
  ),
  direction text not null check (direction in ('given', 'received')),
  confidence text not null default 'medium' check (
    confidence in ('low', 'medium', 'high')
  ),

  source_channel text not null default 'whatsapp',
  source_interaction_date date not null,
  source_external_id text not null,
  source_value_log_id uuid references public.value_logs(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, source_external_id)
);

alter table public.contact_introductions enable row level security;

create policy "contact_introductions select own"
  on public.contact_introductions for select
  using (auth.uid() = user_id);

create policy "contact_introductions insert own"
  on public.contact_introductions for insert
  with check (auth.uid() = user_id);

create policy "contact_introductions update own"
  on public.contact_introductions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists contact_introductions_user_date_idx
  on public.contact_introductions(user_id, source_interaction_date desc);

create index if not exists contact_introductions_source_contact_idx
  on public.contact_introductions(source_contact_id, source_interaction_date desc);

create index if not exists contact_introductions_connector_idx
  on public.contact_introductions(connector_contact_id)
  where connector_contact_id is not null;

create index if not exists contact_introductions_introduced_idx
  on public.contact_introductions(introduced_contact_id)
  where introduced_contact_id is not null;

create index if not exists contact_introductions_to_idx
  on public.contact_introductions(introduced_to_contact_id)
  where introduced_to_contact_id is not null;
