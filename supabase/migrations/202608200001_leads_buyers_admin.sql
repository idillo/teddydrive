create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(), first_name text not null, last_name text not null,
  email text not null, phone text not null, address text, address2 text, city text, state text, zip text,
  payload jsonb not null default '{}'::jsonb, consent_text text, consent_timestamp timestamptz,
  trusted_form_cert_url text, source_url text, ip_address inet, user_agent text,
  is_test boolean not null default false,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','accepted','failed','no_buyers')),
  processed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.buyers (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  delivery_mode text not null default 'off' check (delivery_mode in ('off','direct_post','ping_post')),
  adapter text not null default 'raw_json' check (adapter in ('raw_json','jangl_auto')),
  environment text not null default 'test' check (environment in ('test','production')), priority integer not null default 100,
  direct_endpoint_url text, ping_endpoint_url text, post_endpoint_url text, auth_env_var text,
  auth_scheme text default 'Token', headers jsonb not null default '{}'::jsonb, timeout_ms integer not null default 12000,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.buyer_attempts (
  id uuid primary key default gen_random_uuid(), lead_id uuid not null references public.leads(id) on delete cascade,
  buyer_id uuid not null references public.buyers(id) on delete restrict, mode text not null, stage text not null,
  environment text not null, attempt_number integer not null default 1, status text not null,
  request_payload jsonb, response_payload jsonb, http_status integer, price numeric(12,2), external_reference text,
  error text, latency_ms integer, completed_at timestamptz, created_at timestamptz not null default now()
);

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key, admin_email text not null, action text not null,
  target_type text, target_id text, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create index if not exists leads_created_at_idx on public.leads(created_at desc);
create index if not exists leads_status_idx on public.leads(delivery_status, created_at desc);
create index if not exists leads_email_idx on public.leads(lower(email));
create index if not exists buyer_attempts_lead_idx on public.buyer_attempts(lead_id, created_at);
create index if not exists buyer_attempts_buyer_idx on public.buyer_attempts(buyer_id, created_at desc);

alter table public.leads enable row level security;
alter table public.buyers enable row level security;
alter table public.buyer_attempts enable row level security;
alter table public.admin_audit_log enable row level security;
revoke all on public.leads, public.buyers, public.buyer_attempts, public.admin_audit_log from anon, authenticated;
