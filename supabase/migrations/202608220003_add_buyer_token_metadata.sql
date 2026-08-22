alter table public.buyers add column if not exists token_last_four text;
alter table public.buyers add column if not exists token_updated_at timestamptz;

comment on column public.buyers.token_last_four is 'Non-secret last four characters recorded when the buyer API token is replaced.';
comment on column public.buyers.token_updated_at is 'Time the buyer API token was last replaced through Admin.';
