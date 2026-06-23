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

create table if not exists public.org_member_groups (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.app_groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(organization_id,user_id,group_id)
);

create table if not exists public.org_beverages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null check(price>0),
  purchase_price numeric(10,2) not null default 0 check(purchase_price>=0),
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
  gift_to_user uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.org_deposits (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  amount numeric(10,2) not null check(amount>0),
  gift_from_user uuid references auth.users(id),
  gift_beverage_id uuid references public.org_beverages(id),
  gift_quantity integer,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.org_chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.app_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check(length(trim(message)) between 1 and 500),
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
  insert into org_member_groups(organization_id,user_id,group_id) values(v_org,auth.uid(),v_group) on conflict do nothing;
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
  insert into org_member_groups(organization_id,user_id,group_id) values(v_inv.organization_id,auth.uid(),v_inv.group_id) on conflict do nothing;
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
  if not is_org_admin(p_org) then raise exception 'Nur fÃ¼r Administratoren'; end if;
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

create or replace function public.add_org_deposit(p_client text,p_org uuid,p_amount numeric)
returns public.org_deposits language plpgsql security definer set search_path=public
as $$ declare v_row org_deposits; begin
  if not is_org_member(p_org) then raise exception 'Kein Mitglied'; end if;
  if p_amount<=0 then raise exception 'Ungültiger Betrag'; end if;
  insert into org_deposits(client_id,organization_id,user_id,amount)
  values(p_client,p_org,auth.uid(),round(p_amount,2))
  on conflict(client_id) do update set client_id=excluded.client_id returning * into v_row;
  return v_row;
end $$;

create or replace function public.admin_add_user_deposit(p_client text,p_org uuid,p_user uuid,p_amount numeric)
returns public.org_deposits language plpgsql security definer set search_path=public
as $$ declare v_row org_deposits; begin
  if not is_org_admin(p_org) then raise exception 'Nur fÃ¼r Administratoren'; end if;
  if p_amount<=0 then raise exception 'UngÃ¼ltiger Betrag'; end if;
  if not exists(select 1 from memberships where organization_id=p_org and user_id=p_user) then raise exception 'Benutzer ist kein Mitglied'; end if;
  insert into org_deposits(client_id,organization_id,user_id,amount)
  values(p_client,p_org,p_user,round(p_amount,2))
  on conflict(client_id) do update set client_id=excluded.client_id returning * into v_row;
  return v_row;
end $$;

create or replace function public.add_member_by_email(p_org uuid,p_email text,p_group uuid)
returns public.memberships language plpgsql security definer set search_path=public
as $$ declare v_user uuid; v_row memberships; begin
  if not is_org_admin(p_org) then raise exception 'Nur fÃ¼r Administratoren'; end if;
  if not exists(select 1 from app_groups where id=p_group and organization_id=p_org) then raise exception 'Gruppe nicht gefunden'; end if;
  select id into v_user from auth.users where lower(email)=lower(trim(p_email)) limit 1;
  if v_user is null then raise exception 'Benutzer existiert noch nicht. Bitte Einladung senden.'; end if;
  insert into memberships(organization_id,user_id,group_id,role)
  values(p_org,v_user,p_group,'member')
  on conflict(organization_id,user_id) do update set group_id=excluded.group_id returning * into v_row;
  insert into org_member_groups(organization_id,user_id,group_id)
  values(p_org,v_user,p_group)
  on conflict do nothing;
  return v_row;
end $$;

create or replace function public.add_org_stock(p_org uuid,p_beverage uuid,p_quantity integer,p_note text default null)
returns public.org_stock_movements language plpgsql security definer set search_path=public
as $$ declare v_row org_stock_movements; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if p_quantity<1 then raise exception 'Ungültige Menge'; end if;
  if not exists(select 1 from org_beverages where id=p_beverage and organization_id=p_org and active) then raise exception 'Getränk nicht gefunden'; end if;
  insert into org_stock_movements(organization_id,beverage_id,quantity,note,created_by)
  values(p_org,p_beverage,p_quantity,p_note,auth.uid()) returning * into v_row;
  return v_row;
end $$;

create or replace function public.upsert_org_beverage(p_org uuid,p_name text,p_price numeric)
returns public.org_beverages language plpgsql security definer set search_path=public
as $$ declare v_row org_beverages; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if trim(p_name)='' or p_price<=0 then raise exception 'Name oder Preis ungültig'; end if;
  insert into org_beverages(organization_id,name,price,active)
  values(p_org,trim(p_name),round(p_price,2),true)
  on conflict(organization_id,name) do update set price=excluded.price, active=true returning * into v_row;
  return v_row;
end $$;

drop function if exists public.upsert_org_beverage(uuid,text,numeric);

create or replace function public.upsert_org_beverage(p_org uuid,p_name text,p_price numeric,p_purchase_price numeric default 0)
returns public.org_beverages language plpgsql security definer set search_path=public
as $$ declare v_row org_beverages; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if trim(p_name)='' or p_price<=0 or p_purchase_price<0 then raise exception 'Name oder Preis ungültig'; end if;
  insert into org_beverages(organization_id,name,price,purchase_price,active)
  values(p_org,trim(p_name),round(p_price,2),round(p_purchase_price,2),true)
  on conflict(organization_id,name) do update set price=excluded.price, purchase_price=excluded.purchase_price, active=true returning * into v_row;
  return v_row;
end $$;

create or replace function public.update_org_beverage_price(p_org uuid,p_beverage uuid,p_price numeric)
returns public.org_beverages language plpgsql security definer set search_path=public
as $$ declare v_row org_beverages; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if p_price<=0 then raise exception 'Preis ungültig'; end if;
  update org_beverages set price=round(p_price,2) where id=p_beverage and organization_id=p_org returning * into v_row;
  if not found then raise exception 'Getränk nicht gefunden'; end if;
  return v_row;
end $$;

create or replace function public.deactivate_org_beverage(p_org uuid,p_beverage uuid)
returns public.org_beverages language plpgsql security definer set search_path=public
as $$ declare v_row org_beverages; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  update org_beverages set active=false where id=p_beverage and organization_id=p_org returning * into v_row;
  if not found then raise exception 'Getränk nicht gefunden'; end if;
  return v_row;
end $$;

create or replace function public.update_org_beverage_purchase_price(p_org uuid,p_beverage uuid,p_purchase_price numeric)
returns public.org_beverages language plpgsql security definer set search_path=public
as $$ declare v_row org_beverages; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if p_purchase_price<0 then raise exception 'Einkaufspreis ungültig'; end if;
  update org_beverages set purchase_price=round(p_purchase_price,2) where id=p_beverage and organization_id=p_org returning * into v_row;
  if not found then raise exception 'Getränk nicht gefunden'; end if;
  return v_row;
end $$;

create or replace function public.create_org_group(p_org uuid,p_name text)
returns public.app_groups language plpgsql security definer set search_path=public
as $$ declare v_row app_groups; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if trim(p_name)='' then raise exception 'Name fehlt'; end if;
  insert into app_groups(organization_id,name) values(p_org,trim(p_name)) returning * into v_row;
  return v_row;
end $$;

create or replace function public.update_member_group(p_org uuid,p_user uuid,p_group uuid)
returns public.memberships language plpgsql security definer set search_path=public
as $$ declare v_row memberships; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if not exists(select 1 from app_groups where id=p_group and organization_id=p_org) then raise exception 'Gruppe nicht gefunden'; end if;
  update memberships set group_id=p_group where organization_id=p_org and user_id=p_user and role<>'admin' returning * into v_row;
  if not found then raise exception 'Mitglied nicht gefunden oder geschützt'; end if;
  return v_row;
end $$;

create or replace function public.delete_member(p_org uuid,p_user uuid)
returns void language plpgsql security definer set search_path=public
as $$ begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if p_user=auth.uid() then raise exception 'Du kannst dich nicht selbst entfernen'; end if;
  delete from memberships where organization_id=p_org and user_id=p_user and role<>'admin';
end $$;

create or replace function public.delete_org_group(p_org uuid,p_group uuid)
returns void language plpgsql security definer set search_path=public
as $$ begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if (select count(*) from app_groups where organization_id=p_org)<=1 then raise exception 'Die letzte Gruppe kann nicht gelöscht werden'; end if;
  update memberships set group_id=null where organization_id=p_org and group_id=p_group;
  delete from app_groups where id=p_group and organization_id=p_org;
end $$;

create or replace function public.delete_workspace(p_org uuid)
returns void language plpgsql security definer set search_path=public
as $$ begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  delete from organizations where id=p_org;
end $$;

create or replace function public.set_member_admin_role(p_org uuid,p_user uuid,p_admin boolean)
returns public.memberships language plpgsql security definer set search_path=public
as $$ declare v_row memberships; v_admin_count integer; begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if p_user=auth.uid() then raise exception 'Du kannst deine eigene Admin-Rolle nicht ändern'; end if;
  if not exists(select 1 from memberships where organization_id=p_org and user_id=p_user) then raise exception 'Mitglied nicht gefunden'; end if;
  if not p_admin then
    select count(*) into v_admin_count from memberships where organization_id=p_org and role='admin';
    if v_admin_count<=1 then raise exception 'Mindestens ein Admin erforderlich'; end if;
  end if;
  update memberships set role=case when p_admin then 'admin' else 'member' end
  where organization_id=p_org and user_id=p_user returning * into v_row;
  return v_row;
end $$;

create or replace function public.reset_workspace_values(p_org uuid)
returns void language plpgsql security definer set search_path=public
as $$ begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  delete from org_chat_messages where organization_id=p_org;
  delete from org_consumptions where organization_id=p_org;
  delete from org_deposits where organization_id=p_org;
  delete from org_stock_movements where organization_id=p_org;
end $$;

create or replace function public.send_group_chat_message(p_org uuid,p_group uuid,p_message text)
returns public.org_chat_messages language plpgsql security definer set search_path=public
as $$ declare v_row org_chat_messages; begin
  if not is_org_member(p_org) then raise exception 'Kein Mitglied'; end if;
  if not exists(select 1 from app_groups where id=p_group and organization_id=p_org) then raise exception 'Gruppe nicht gefunden'; end if;
  if not is_org_admin(p_org) and not exists(select 1 from org_member_groups where organization_id=p_org and user_id=auth.uid() and group_id=p_group) then raise exception 'Nicht in dieser Gruppe'; end if;
  if length(trim(p_message))<1 or length(trim(p_message))>500 then raise exception 'Nachricht ungültig'; end if;
  insert into org_chat_messages(organization_id,group_id,user_id,message)
  values(p_org,p_group,auth.uid(),trim(p_message)) returning * into v_row;
  return v_row;
end $$;

alter table public.org_consumptions add column if not exists gift_to_user uuid references auth.users(id);
alter table public.org_deposits add column if not exists gift_from_user uuid references auth.users(id), add column if not exists gift_beverage_id uuid references public.org_beverages(id), add column if not exists gift_quantity integer, add column if not exists note text;

create or replace function public.give_beer_to_user(p_client text,p_org uuid,p_to_user uuid,p_beverage uuid,p_quantity integer,p_at timestamptz)
returns public.org_consumptions language plpgsql security definer set search_path=public
as $$ declare v_bev org_beverages; v_sender_group uuid; v_receiver_group uuid; v_balance numeric; v_row org_consumptions; begin
  if not is_org_member(p_org) then raise exception 'Kein Mitglied'; end if;
  if p_to_user=auth.uid() then raise exception 'Du kannst dir nicht selbst Bier ausgeben'; end if;
  if p_quantity<1 then raise exception 'Ungültige Menge'; end if;
  select mg.group_id into v_sender_group from org_member_groups mg where mg.organization_id=p_org and mg.user_id=auth.uid() and exists(select 1 from org_member_groups rg where rg.organization_id=p_org and rg.user_id=p_to_user and rg.group_id=mg.group_id) limit 1;
  if v_sender_group is null then raise exception 'Benutzer ist nicht in deiner Gruppe'; end if;
  select * into v_bev from org_beverages where id=p_beverage and organization_id=p_org and name='Bier' and active for update;
  if not found then raise exception 'Bier nicht gefunden'; end if;
  select coalesce((select sum(amount) from org_deposits where organization_id=p_org and user_id=auth.uid()),0)-
         coalesce((select sum(quantity*unit_price) from org_consumptions where organization_id=p_org and user_id=auth.uid()),0) into v_balance;
  if v_balance<p_quantity*v_bev.price then raise exception 'Guthaben reicht nicht aus'; end if;
  if get_org_stock(p_org,p_beverage)<p_quantity then raise exception 'Lagerbestand reicht nicht aus'; end if;
  insert into org_consumptions(client_id,organization_id,user_id,beverage_id,quantity,unit_price,consumed_at,gift_to_user)
  values(p_client,p_org,auth.uid(),p_beverage,p_quantity,v_bev.price,p_at,p_to_user) returning * into v_row;
  insert into org_deposits(client_id,organization_id,user_id,amount,gift_from_user,gift_beverage_id,gift_quantity,note)
  values(p_client || '-gift',p_org,p_to_user,p_quantity*v_bev.price,auth.uid(),p_beverage,p_quantity,'Bier erhalten');
  return v_row;
end $$;

create or replace function public.get_member_balances(p_org uuid)
returns table(user_id uuid,balance numeric) language sql security definer set search_path=public
as $$
  select m.user_id,
         coalesce((select sum(d.amount) from org_deposits d where d.organization_id=p_org and d.user_id=m.user_id),0)
         - coalesce((select sum(c.quantity*c.unit_price) from org_consumptions c where c.organization_id=p_org and c.user_id=m.user_id),0) as balance
  from memberships m
  where m.organization_id=p_org and is_org_member(p_org);
$$;

create or replace function public.set_member_groups(p_org uuid,p_user uuid,p_groups uuid[])
returns void language plpgsql security definer set search_path=public
as $$ begin
  if not is_org_admin(p_org) then raise exception 'Nur für Administratoren'; end if;
  if not exists(select 1 from memberships where organization_id=p_org and user_id=p_user and role<>'admin') then raise exception 'Mitglied nicht gefunden oder geschützt'; end if;
  if coalesce(array_length(p_groups,1),0)<1 then raise exception 'Mindestens eine Gruppe erforderlich'; end if;
  if exists(select 1 from unnest(p_groups) as g(id) where not exists(select 1 from app_groups where id=g.id and organization_id=p_org)) then raise exception 'Ungültige Gruppe'; end if;
  delete from org_member_groups where organization_id=p_org and user_id=p_user;
  insert into org_member_groups(organization_id,user_id,group_id) select p_org,p_user,id from unnest(p_groups) as g(id) on conflict do nothing;
  update memberships set group_id=p_groups[1] where organization_id=p_org and user_id=p_user;
end $$;

create or replace function public.delete_org_consumption(p_org uuid,p_consumption uuid)
returns void language plpgsql security definer set search_path=public
as $$ declare v_row org_consumptions; begin
  select * into v_row from org_consumptions where id=p_consumption and organization_id=p_org;
  if not found then raise exception 'Eintrag nicht gefunden'; end if;
  if not is_org_admin(p_org) then
    if v_row.user_id<>auth.uid() then raise exception 'Nur eigene Einträge löschbar'; end if;
    if v_row.created_at<now()-interval '5 minutes' then raise exception 'Nur 5 Minuten löschbar'; end if;
  end if;
  delete from org_consumptions where id=p_consumption and organization_id=p_org;
end $$;

alter table organizations enable row level security; alter table app_groups enable row level security;
alter table memberships enable row level security; alter table invitations enable row level security;
alter table org_beverages enable row level security; alter table org_stock_movements enable row level security;
alter table org_consumptions enable row level security; alter table org_deposits enable row level security;
alter table org_chat_messages enable row level security;
alter table org_member_groups enable row level security;

drop policy if exists "org_read" on organizations; drop policy if exists "groups_read" on app_groups;
drop policy if exists "groups_admin" on app_groups; drop policy if exists "members_read" on memberships;
drop policy if exists "members_admin" on memberships; drop policy if exists "invites_admin" on invitations;
drop policy if exists "org_bev_read" on org_beverages; drop policy if exists "org_bev_admin" on org_beverages;
drop policy if exists "org_stock_read" on org_stock_movements; drop policy if exists "org_stock_admin" on org_stock_movements;
drop policy if exists "org_consume_read" on org_consumptions; drop policy if exists "org_consume_delete" on org_consumptions;
drop policy if exists "org_deposit_read" on org_deposits; drop policy if exists "org_deposit_insert" on org_deposits;
drop policy if exists "chat_group_read" on org_chat_messages;
drop policy if exists "member_groups_read" on org_member_groups;

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
create policy "org_consume_delete" on org_consumptions for delete to authenticated using(is_org_admin(organization_id) or (user_id=auth.uid() and created_at>=now()-interval '5 minutes'));
create policy "org_deposit_read" on org_deposits for select to authenticated using(user_id=auth.uid() or is_org_admin(organization_id));
create policy "org_deposit_insert" on org_deposits for insert to authenticated with check(is_org_admin(organization_id));
create policy "chat_group_read" on org_chat_messages for select to authenticated using(is_org_admin(organization_id) or exists(select 1 from org_member_groups where organization_id=org_chat_messages.organization_id and user_id=auth.uid() and group_id=org_chat_messages.group_id));
create policy "member_groups_read" on org_member_groups for select to authenticated using(is_org_member(organization_id));

grant execute on function create_workspace(text),create_invitation(uuid,uuid,text),accept_invitation(text),get_org_stock(uuid,uuid),get_member_balances(uuid),record_org_consumption(text,uuid,uuid,integer,timestamptz),add_org_deposit(text,uuid,numeric),admin_add_user_deposit(text,uuid,uuid,numeric),add_member_by_email(uuid,text,uuid),add_org_stock(uuid,uuid,integer,text),upsert_org_beverage(uuid,text,numeric,numeric),update_org_beverage_price(uuid,uuid,numeric),update_org_beverage_purchase_price(uuid,uuid,numeric),deactivate_org_beverage(uuid,uuid),create_org_group(uuid,text),update_member_group(uuid,uuid,uuid),delete_member(uuid,uuid),delete_org_group(uuid,uuid),delete_workspace(uuid),reset_workspace_values(uuid),send_group_chat_message(uuid,uuid,text),give_beer_to_user(text,uuid,uuid,uuid,integer,timestamptz),set_member_groups(uuid,uuid,uuid[]),set_member_admin_role(uuid,uuid,boolean),delete_org_consumption(uuid,uuid) to authenticated;
