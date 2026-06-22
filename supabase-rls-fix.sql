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
