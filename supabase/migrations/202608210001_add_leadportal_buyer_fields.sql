alter table public.buyers add column if not exists lead_type text;
alter table public.buyers add column if not exists source_code text;
alter table public.buyers add column if not exists terminating_phone text;

alter table public.buyers drop constraint if exists buyers_adapter_check;
alter table public.buyers add constraint buyers_adapter_check
  check (adapter in ('raw_json', 'jangl_auto', 'leadportal_ipr'));
