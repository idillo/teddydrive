alter table public.buyers add column if not exists published_config jsonb;
alter table public.buyers add column if not exists published_at timestamptz;
