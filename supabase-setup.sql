-- Cafe Daniels Getränkeverwaltung
-- Dieses Skript einmal im Supabase SQL Editor ausführen.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  phone text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.beverages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  price numeric(10,2) not null check (price > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  beverage_id uuid not null references public.beverages(id),
  quantity integer not null check (quantity <> 0),
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.consumptions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  user_id uuid not null references auth.users(id),
  beverage_id uuid not null references public.beverages(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null check (unit_price > 0),
  consumed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  user_id uuid not null references auth.users(id),
  amount numeric(10,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$ begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.get_stock(p_beverage_id uuid)
returns integer language sql stable security definer set search_path = public
as $$
  select coalesce((select sum(quantity) from public.stock_movements where beverage_id = p_beverage_id), 0)::integer
       - coalesce((select sum(quantity) from public.consumptions where beverage_id = p_beverage_id), 0)::integer
$$;

create or replace function public.record_consumption(
  p_client_id text, p_beverage_id uuid, p_quantity integer, p_consumed_at timestamptz
) returns public.consumptions
language plpgsql security definer set search_path = public
as $$
declare v_beverage public.beverages; v_row public.consumptions; v_balance numeric;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select * into v_beverage from public.beverages where id = p_beverage_id and active for update;
  if not found then raise exception 'Getränk nicht verfügbar'; end if;
  if p_quantity < 1 then raise exception 'Ungültige Menge'; end if;
  select coalesce((select sum(amount) from public.deposits where user_id=auth.uid()),0)
       - coalesce((select sum(quantity*unit_price) from public.consumptions where user_id=auth.uid()),0)
    into v_balance;
  if v_balance < p_quantity*v_beverage.price then raise exception 'Guthaben reicht nicht aus'; end if;
  if public.get_stock(p_beverage_id) < p_quantity then raise exception 'Lagerbestand reicht nicht aus'; end if;
  insert into public.consumptions(client_id,user_id,beverage_id,quantity,unit_price,consumed_at)
  values(p_client_id,auth.uid(),p_beverage_id,p_quantity,v_beverage.price,p_consumed_at)
  on conflict(client_id) do update set client_id=excluded.client_id returning * into v_row;
  return v_row;
end $$;

alter table public.profiles enable row level security;
alter table public.beverages enable row level security;
alter table public.stock_movements enable row level security;
alter table public.consumptions enable row level security;
alter table public.deposits enable row level security;

drop policy if exists "profiles_read" on public.profiles;
drop policy if exists "profile_update_own" on public.profiles;
drop policy if exists "beverages_read" on public.beverages;
drop policy if exists "beverages_admin" on public.beverages;
drop policy if exists "stock_read" on public.stock_movements;
drop policy if exists "stock_admin" on public.stock_movements;
drop policy if exists "consumption_read" on public.consumptions;
drop policy if exists "consumption_delete" on public.consumptions;
drop policy if exists "deposit_read" on public.deposits;
drop policy if exists "deposit_own" on public.deposits;

create policy "profiles_read" on public.profiles for select to authenticated using (true);
create policy "profile_update_own" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid() and is_admin=public.is_admin());
create policy "beverages_read" on public.beverages for select to authenticated using (true);
create policy "beverages_admin" on public.beverages for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "stock_read" on public.stock_movements for select to authenticated using (true);
create policy "stock_admin" on public.stock_movements for insert to authenticated with check (public.is_admin() and created_by=auth.uid());
create policy "consumption_read" on public.consumptions for select to authenticated using (user_id=auth.uid() or public.is_admin());
create policy "consumption_delete" on public.consumptions for delete to authenticated using (user_id=auth.uid() or public.is_admin());
create policy "deposit_read" on public.deposits for select to authenticated using (user_id=auth.uid() or public.is_admin());
create policy "deposit_own" on public.deposits for insert to authenticated with check (user_id=auth.uid());

grant execute on function public.get_stock(uuid) to authenticated;
grant execute on function public.record_consumption(text,uuid,integer,timestamptz) to authenticated;

insert into public.beverages(name,price) values
  ('Bier',3.50),('Spezi',3.00),('Cola',3.00),('Wein',4.50)
on conflict(name) do nothing;

-- Nach der ersten Registrierung die eigene E-Mail einsetzen und einmal ausführen:
-- update public.profiles set is_admin=true
-- where id=(select id from auth.users where email='DEINE-EMAIL@BEISPIEL.DE');
