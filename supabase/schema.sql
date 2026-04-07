create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  place_id text not null,
  place_name text not null,
  place_payload jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles enable row level security;
alter table public.favorites enable row level security;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "favorites_select_own"
on public.favorites
for select
to authenticated
using (auth.uid() = user_id);

create policy "favorites_insert_own"
on public.favorites
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "favorites_delete_own"
on public.favorites
for delete
to authenticated
using (auth.uid() = user_id);
