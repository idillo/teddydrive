alter table public.buyers add column if not exists campaign_name text;
alter table public.buyers add column if not exists campaign_id text;

create index if not exists buyers_campaign_id_idx on public.buyers(campaign_id);
