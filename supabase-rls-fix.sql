-- Cafe Daniels: Korrektur für die Ersteinrichtung eines Bereichs
-- Diesen kompletten Inhalt einmal im Supabase SQL Editor ausführen.

create or replace function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path=public
set row_security=off
as $$
declare
  v_org uuid;
  v_group uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if trim(p_name) = '' then
    raise exception 'Name fehlt';
  end if;

  insert into public.organizations(name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_org;

  insert into public.app_groups(organization_id, name)
  values (v_org, 'Mitglieder')
  returning id into v_group;

  insert into public.memberships(organization_id, user_id, group_id, role)
  values (v_org, auth.uid(), v_group, 'admin');

  insert into public.org_beverages(organization_id, name, price)
  values
    (v_org, 'Bier', 3.50),
    (v_org, 'Spezi', 3.00),
    (v_org, 'Cola', 3.00),
    (v_org, 'Wein', 4.50);

  return v_org;
end
$$;

revoke all on function public.create_workspace(text) from public;
grant execute on function public.create_workspace(text) to authenticated;

create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.memberships
    where organization_id=p_org and user_id=auth.uid()
  )
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.memberships
    where organization_id=p_org and user_id=auth.uid() and role='admin'
  )
$$;

create or replace function public.add_org_deposit(p_client text, p_org uuid, p_amount numeric)
returns public.org_deposits
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.org_deposits;
begin
  if not public.is_org_member(p_org) then
    raise exception 'Kein Mitglied';
  end if;
  if p_amount <= 0 then
    raise exception 'Ungültiger Betrag';
  end if;

  insert into public.org_deposits(client_id, organization_id, user_id, amount)
  values(p_client, p_org, auth.uid(), round(p_amount, 2))
  on conflict(client_id) do update set client_id=excluded.client_id
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.add_org_stock(p_org uuid, p_beverage uuid, p_quantity integer, p_note text default null)
returns public.org_stock_movements
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.org_stock_movements;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'Nur für Administratoren';
  end if;
  if p_quantity < 1 then
    raise exception 'Ungültige Menge';
  end if;
  if not exists(select 1 from public.org_beverages where id=p_beverage and organization_id=p_org and active) then
    raise exception 'Getränk nicht gefunden';
  end if;

  insert into public.org_stock_movements(organization_id, beverage_id, quantity, note, created_by)
  values(p_org, p_beverage, p_quantity, p_note, auth.uid())
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.upsert_org_beverage(p_org uuid, p_name text, p_price numeric)
returns public.org_beverages
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.org_beverages;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'Nur für Administratoren';
  end if;
  if trim(p_name) = '' or p_price <= 0 then
    raise exception 'Name oder Preis ungültig';
  end if;

  insert into public.org_beverages(organization_id, name, price, active)
  values(p_org, trim(p_name), round(p_price, 2), true)
  on conflict(organization_id, name)
  do update set price=excluded.price, active=true
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.update_org_beverage_price(p_org uuid, p_beverage uuid, p_price numeric)
returns public.org_beverages
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.org_beverages;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'Nur für Administratoren';
  end if;
  if p_price <= 0 then
    raise exception 'Preis ungültig';
  end if;

  update public.org_beverages
  set price=round(p_price, 2)
  where id=p_beverage and organization_id=p_org
  returning * into v_row;

  if not found then
    raise exception 'Getränk nicht gefunden';
  end if;

  return v_row;
end
$$;

create or replace function public.deactivate_org_beverage(p_org uuid, p_beverage uuid)
returns public.org_beverages
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.org_beverages;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'Nur für Administratoren';
  end if;

  update public.org_beverages
  set active=false
  where id=p_beverage and organization_id=p_org
  returning * into v_row;

  if not found then
    raise exception 'Getränk nicht gefunden';
  end if;

  return v_row;
end
$$;

grant execute on function public.add_org_deposit(text, uuid, numeric) to authenticated;
grant execute on function public.add_org_stock(uuid, uuid, integer, text) to authenticated;
grant execute on function public.upsert_org_beverage(uuid, text, numeric) to authenticated;
grant execute on function public.update_org_beverage_price(uuid, uuid, numeric) to authenticated;
grant execute on function public.deactivate_org_beverage(uuid, uuid) to authenticated;
