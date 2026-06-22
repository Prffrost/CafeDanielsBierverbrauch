-- Erweiterung für Bereiche, Gruppen und Einladungen
-- Nach supabase-setup.sql einmal im Supabase SQL Editor ausführen.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.app_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(organization_id,name)
);

create table if not exists public.memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid references public.app_groups(id) on delete set null,
  role text not null default 'member' check(role in ('admin','member')),
  joined_at timestamptz not null default now(),
  primary key(organization_id,user_id)
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.app_groups(id),
  email text,
  token text not null unique default encode(gen_random_bytes(18),'hex'),
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now()+interval '7 days',
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.org_beverages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null check(price>0),
  active boolean not null default true,
  unique(organization_id,name)
);

create table if not exists public.org_stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  beverage_id uuid not null references public.org_beverages(id),
  quantity integer not null check(quantity<>0),
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.org_consumptions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  beverage_id uuid not null references public.org_beverages(id),
  quantity integer not null check(quantity>0),
  unit_price numeric(10,2) not null check(unit_price>0),
  consumed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_deposits (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  amount numeric(10,2) not null check(amount>0),
  created_at timestamptz not null default now()
);

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from memberships where organization_id=p_org and user_id=auth.uid()) $$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from memberships where organization_id=p_org and user_id=auth.uid() and role='admin') $$;

create or replace function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path=public set row_security=off
as $$ declare v_org uuid; v_group uuid; begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if trim(p_name)='' then raise exception 'Name fehlt'; end if;
  insert into organizations(name,created_by) values(trim(p_name),auth.uid()) returning id into v_org;
  insert into app_groups(organization_id,name) values(v_org,'Mitglieder') returning id into v_group;
  insert into memberships(organization_id,user_id,group_id,role) values(v_org,auth.uid(),v_group,'admin');
  insert into org_beverages(organization_id,name,price) values(v_org,'Bier',3.50),(v_org,'Spezi',3.00),(v_org,'Cola',3.00),(v_org,'Wein',4.50);
  return v_org;
end $$;

create or replace function public.create_invitation(p_org uuid,p_group uuid,p_email text default null)
returns public.invitations language plpgsql security definer set search_path=public
as $$ declare v_row invitations; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if not exists(select 1 from app_groups where id=p_group and organization_id=p_org) then raise exception 'Ungültige Gruppe'; end if;
  insert into invitations(organization_id,group_id,email,created_by)
  values(p_org,p_group,nullif(lower(trim(p_email)),''),auth.uid()) returning * into v_row;
  return v_row;
end $$;

create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path=public
as $$ declare v_inv invitations; v_email text; begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select email into v_email from auth.users where id=auth.uid();
  select * into v_inv from invitations where token=p_token and accepted_at is null and expires_at>now() for update;
  if not found then raise exception 'Einladung ungültig oder abgelaufen'; end if;
  if v_inv.email is not null and lower(v_email)<>lower(v_inv.email) then raise exception 'Einladung gehört zu einer anderen E-Mail-Adresse'; end if;
  insert into memberships(organization_id,user_id,group_id,role) values(v_inv.organization_id,auth.uid(),v_inv.group_id,'member')
  on conflict(organization_id,user_id) do update set group_id=excluded.group_id;
  update invitations set accepted_by=auth.uid(),accepted_at=now() where id=v_inv.id;
  return v_inv.organization_id;
end $$;

create or replace function public.get_org_stock(p_org uuid,p_beverage uuid)
returns integer language sql stable security definer set search_path=public
as $$ select case when is_org_member(p_org) then
  coalesce((select sum(quantity) from org_stock_movements where organization_id=p_org and beverage_id=p_beverage),0)::integer-
  coalesce((select sum(quantity) from org_consumptions where organization_id=p_org and beverage_id=p_beverage),0)::integer
else 0 end $$;

create or replace function public.record_org_consumption(p_client text,p_org uuid,p_beverage uuid,p_quantity integer,p_at timestamptz)
returns public.org_consumptions language plpgsql security definer set search_path=public
as $$ declare v_bev org_beverages; v_balance numeric; v_row org_consumptions; begin
  if not is_org_member(p_org) then raise exception 'Kein Mitglied'; end if;
  select * into v_bev from org_beverages where id=p_beverage and organization_id=p_org and active for update;
  if not found or p_quantity<1 then raise exception 'Ungültige Buchung'; end if;
  select coalesce((select sum(amount) from org_deposits where organization_id=p_org and user_id=auth.uid()),0)-
         coalesce((select sum(quantity*unit_price) from org_consumptions where organization_id=p_org and user_id=auth.uid()),0) into v_balance;
  if v_balance<p_quantity*v_bev.price then raise exception 'Guthaben reicht nicht aus'; end if;
  if get_org_stock(p_org,p_beverage)<p_quantity then raise exception 'Lagerbestand reicht nicht aus'; end if;
  insert into org_consumptions(client_id,organization_id,user_id,beverage_id,quantity,unit_price,consumed_at)
  values(p_client,p_org,auth.uid(),p_beverage,p_quantity,v_bev.price,p_at)
  on conflict(client_id) do update set client_id=excluded.client_id returning * into v_row;
  return v_row;
end $$;

alter table organizations enable row level security; alter table app_groups enable row level security;
alter table memberships enable row level security; alter table invitations enable row level security;
alter table org_beverages enable row level security; alter table org_stock_movements enable row level security;
alter table org_consumptions enable row level security; alter table org_deposits enable row level security;

drop policy if exists "org_read" on organizations; drop policy if exists "groups_read" on app_groups;
drop policy if exists "groups_admin" on app_groups; drop policy if exists "members_read" on memberships;
drop policy if exists "members_admin" on memberships; drop policy if exists "invites_admin" on invitations;
drop policy if exists "org_bev_read" on org_beverages; drop policy if exists "org_bev_admin" on org_beverages;
drop policy if exists "org_stock_read" on org_stock_movements; drop policy if exists "org_stock_admin" on org_stock_movements;
drop policy if exists "org_consume_read" on org_consumptions; drop policy if exists "org_consume_delete" on org_consumptions;
drop policy if exists "org_deposit_read" on org_deposits; drop policy if exists "org_deposit_insert" on org_deposits;

create policy "org_read" on organizations for select to authenticated using(is_org_member(id));
create policy "groups_read" on app_groups for select to authenticated using(is_org_member(organization_id));
create policy "groups_admin" on app_groups for all to authenticated using(is_org_admin(organization_id)) with check(is_org_admin(organization_id));
create policy "members_read" on memberships for select to authenticated using(is_org_member(organization_id));
create policy "members_admin" on memberships for update to authenticated using(is_org_admin(organization_id)) with check(is_org_admin(organization_id));
create policy "invites_admin" on invitations for select to authenticated using(is_org_admin(organization_id));
create policy "org_bev_read" on org_beverages for select to authenticated using(is_org_member(organization_id));
create policy "org_bev_admin" on org_beverages for all to authenticated using(is_org_admin(organization_id)) with check(is_org_admin(organization_id));
create policy "org_stock_read" on org_stock_movements for select to authenticated using(is_org_member(organization_id));
create policy "org_stock_admin" on org_stock_movements for insert to authenticated with check(is_org_admin(organization_id) and created_by=auth.uid());
create policy "org_consume_read" on org_consumptions for select to authenticated using(user_id=auth.uid() or is_org_admin(organization_id));
create policy "org_consume_delete" on org_consumptions for delete to authenticated using(user_id=auth.uid() or is_org_admin(organization_id));
create policy "org_deposit_read" on org_deposits for select to authenticated using(user_id=auth.uid() or is_org_admin(organization_id));
create policy "org_deposit_insert" on org_deposits for insert to authenticated with check(user_id=auth.uid() and is_org_member(organization_id));

grant execute on function create_workspace(text),create_invitation(uuid,uuid,text),accept_invitation(text),get_org_stock(uuid,uuid),record_org_consumption(text,uuid,uuid,integer,timestamptz) to authenticated;
