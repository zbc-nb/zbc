-- Evergreen: shared, anonymous usage totals for the world map.
--
-- How to use: in your Supabase project open SQL Editor → New query, paste
-- this whole file, and click Run. Then put the project URL and the
-- "anon public" key into lib/config.js.
--
-- Privacy and security design:
--   * Only daily totals per AI are stored: prompts, energy, CO₂ and task
--     category counts. Never chat text, names, emails or exact times.
--   * Each install has a random ID (not linked to a person) so it can
--     update its own totals and delete everything it shared.
--   * The table can't be read or written directly with the public key.
--     Everything goes through the three functions below:
--       submit_usage      add or update this install's daily totals
--       delete_my_data    delete everything this install shared
--       community_stats   per-country totals, hiding countries with too
--                         few users so no one can be singled out
--   * Limitation: anyone with the public key could submit made-up totals.
--     Values are capped below, which is enough for a hackathon; a public
--     launch would add rate limiting or sign-in.

create table if not exists public.usage_daily (
  install_id uuid not null,
  day        date not null,
  country    text not null check (country ~ '^[A-Z]{2}$'),
  ai         text not null check (ai in ('chatgpt','claude','gemini','perplexity','copilot','deepseek','grok','mistral')),
  prompts    integer not null check (prompts between 0 and 5000),
  wh         real    not null check (wh >= 0 and wh <= 5000),
  gco2e      real    not null check (gco2e >= 0 and gco2e <= 5000),
  categories jsonb   not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (install_id, day, ai)
);

alter table public.usage_daily enable row level security;
-- No policies: the public (anon) key can't touch the table directly.
revoke all on public.usage_daily from anon, authenticated;

-- Add or update this install's daily totals. p_rows is a JSON array of
-- { day, country, ai, prompts, wh, gco2e, categories }.
create or replace function public.submit_usage(p_install uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 400 then
    raise exception 'expected an array of at most 400 rows';
  end if;
  insert into usage_daily (install_id, day, country, ai, prompts, wh, gco2e, categories, updated_at)
  select p_install,
         (r->>'day')::date,
         upper(r->>'country'),
         r->>'ai',
         (r->>'prompts')::integer,
         (r->>'wh')::real,
         (r->>'gco2e')::real,
         coalesce(r->'categories', '{}'::jsonb),
         now()
  from jsonb_array_elements(p_rows) as r
  where (r->>'day')::date between current_date - 400 and current_date + 1
  on conflict (install_id, day, ai) do update
    set country = excluded.country, prompts = excluded.prompts, wh = excluded.wh,
        gco2e = excluded.gco2e, categories = excluded.categories, updated_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Delete everything this install has shared.
create or replace function public.delete_my_data(p_install uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from usage_daily where install_id = p_install;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Per-country totals over the last p_days days. Countries with fewer than
-- p_min_users installs are left out (privacy).
create or replace function public.community_stats(p_days integer default 30, p_min_users integer default 3)
returns table (
  country text,
  users integer,
  prompts bigint,
  wh double precision,
  gco2e double precision,
  ai_prompts jsonb,
  categories jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with recent as (
    select * from usage_daily
    where day >= current_date - greatest(1, least(p_days, 365))
  ),
  per_country as (
    select r.country,
           count(distinct r.install_id)::integer as users,
           sum(r.prompts)::bigint as prompts,
           sum(r.wh)::double precision as wh,
           sum(r.gco2e)::double precision as gco2e
    from recent r
    group by r.country
    having count(distinct r.install_id) >= greatest(p_min_users, 1)
  ),
  per_ai as (
    select r.country, jsonb_object_agg(r.ai, r.n) as ai_prompts
    from (select country, ai, sum(prompts) as n from recent group by country, ai) r
    group by r.country
  ),
  per_cat as (
    select c.country, jsonb_object_agg(c.k, c.n) as categories
    from (
      select r.country, kv.key as k, sum((kv.value)::integer) as n
      from recent r, jsonb_each_text(r.categories) as kv
      group by r.country, kv.key
    ) c
    group by c.country
  )
  select p.country, p.users, p.prompts, p.wh, p.gco2e,
         coalesce(a.ai_prompts, '{}'::jsonb), coalesce(c.categories, '{}'::jsonb)
  from per_country p
  left join per_ai a using (country)
  left join per_cat c using (country)
  order by p.users desc;
$$;

revoke all on function public.submit_usage(uuid, jsonb) from public;
revoke all on function public.delete_my_data(uuid) from public;
revoke all on function public.community_stats(integer, integer) from public;
grant execute on function public.submit_usage(uuid, jsonb) to anon;
grant execute on function public.delete_my_data(uuid) to anon;
grant execute on function public.community_stats(integer, integer) to anon;
