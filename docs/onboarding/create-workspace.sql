-- onboarding:create
do $onboard$
declare
  -- ======================= EDIT BELOW THIS LINE =======================
  org_slug text := 'acme-foods';           -- permanent: lowercase, digits, hyphens
  org_name text := 'Acme Foods, Inc.';     -- the legal name the packet signs with
  fee_bps  int  := 2500;                   -- contingency in basis points: 2500 = 25%

  -- role: owner | approver | analyst | read_only | accountant_guest
  people jsonb := $people$[
    {"email": "controller@acme-foods.example", "full_name": "Dana Reyes",  "role": "owner"},
    {"email": "ap.lead@acme-foods.example",    "full_name": "Sam Ortiz",   "role": "approver"},
    {"email": "analyst@ourfirm.example",       "full_name": "Our Analyst", "role": "analyst"}
  ]$people$;

  -- retailer_key: lowercase words joined by _, permanent, one per payer.
  -- display_name: the name people know it by. Printed names that match neither
  -- (after capitals, punctuation and Inc/LLC/Corp are ignored) go to
  -- pnpm link:retailer as aliases (runbook §3).
  payers jsonb := $payers$[
    {"retailer_key": "sysco",    "display_name": "Sysco"},
    {"retailer_key": "us_foods", "display_name": "US Foods"},
    {"retailer_key": "pfg",      "display_name": "Performance Food Group"},
    {"retailer_key": "gordon",   "display_name": "Gordon Food Service"}
  ]$payers$;
  -- ======================= EDIT ABOVE THIS LINE =======================

  v_org        uuid;
  v_org_new    boolean := false;
  v_user       uuid;
  v_fee        int;
  v_role       membership_role;
  v_have       membership_role;
  v_email      text;
  v_name       text;
  v_key        text;
  v_display    text;
  v_existing   text;
  v_count      int;
  p            jsonb;
  users_new    int := 0;
  users_reused int := 0;
  members_new  int := 0;
  payers_new   int := 0;
begin
  -- ---- the inputs, checked before anything is written -------------------
  if org_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'org_slug % must be lowercase letters and digits joined by single hyphens', org_slug;
  end if;
  if btrim(coalesce(org_name, '')) = '' then
    raise exception 'org_name is empty';
  end if;
  if fee_bps is null or fee_bps not between 0 and 10000 then
    raise exception 'fee_bps % must be between 0 and 10000 (2500 = 25%%)', fee_bps;
  end if;
  if jsonb_typeof(people) <> 'array' or jsonb_array_length(people) = 0 then
    raise exception 'people must be a non-empty JSON array';
  end if;
  if jsonb_typeof(payers) <> 'array' then
    raise exception 'payers must be a JSON array (it may be empty: [])';
  end if;

  select lower(e.value ->> 'email') into v_email
    from jsonb_array_elements(people) e
   group by lower(e.value ->> 'email')
  having count(*) > 1
   limit 1;
  if v_email is not null then
    raise exception '% is listed twice in people (addresses are compared ignoring capitals)', v_email;
  end if;

  -- ---- the organization ---------------------------------------------------
  select id, name into v_org, v_existing from organizations where slug = org_slug;
  if v_org is null then
    insert into organizations (slug, name) values (org_slug, btrim(org_name))
    returning id into v_org;
    v_org_new := true;
  elsif v_existing <> btrim(org_name) then
    raise exception 'slug % already belongs to workspace "%", not "%": check the slug before going on',
      org_slug, v_existing, btrim(org_name);
  end if;

  -- ---- its settings: every default except the fee -------------------------
  insert into org_settings (org_id, fee_pct_bps) values (v_org, fee_bps)
  on conflict (org_id) do nothing;
  select fee_pct_bps into v_fee from org_settings where org_id = v_org;
  if v_fee <> fee_bps then
    raise exception 'workspace % already has fee_pct_bps %, not %: changing a contract term is a deliberate UPDATE, not a re-run',
      org_slug, v_fee, fee_bps;
  end if;

  -- ---- people: a users row per address, ignoring capitals; a membership ---
  for p in select value from jsonb_array_elements(people) loop
    v_email := btrim(coalesce(p ->> 'email', ''));
    v_name  := nullif(btrim(coalesce(p ->> 'full_name', '')), '');
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'not an email address: "%"', v_email;
    end if;
    begin
      v_role := (p ->> 'role')::membership_role;
    exception when invalid_text_representation or null_value_not_allowed then
      raise exception 'role "%" for % is not one of owner, approver, analyst, read_only, accountant_guest',
        p ->> 'role', v_email;
    end;
    if v_role is null then
      raise exception 'no role given for %', v_email;
    end if;

    select count(*) into v_count from users where lower(email) = lower(v_email);
    if v_count > 1 then
      raise exception 'two users rows answer to % in different capitals (VERIFY-CHECKLIST R4): that person cannot sign in until one is removed',
        v_email;
    elsif v_count = 1 then
      select id into v_user from users where lower(email) = lower(v_email);
      users_reused := users_reused + 1;
    else
      insert into users (email, full_name) values (v_email, v_name) returning id into v_user;
      users_new := users_new + 1;
    end if;

    select role into v_have from memberships where org_id = v_org and user_id = v_user;
    if v_have is null then
      insert into memberships (org_id, user_id, role) values (v_org, v_user, v_role);
      members_new := members_new + 1;
    elsif v_have <> v_role then
      raise exception '% is already % in %, not %: change a role with runbook §5.1, not by re-running this block',
        v_email, v_have, org_slug, v_role;
    end if;
  end loop;

  -- ---- payers: one debtors row each ---------------------------------------
  for p in select value from jsonb_array_elements(payers) loop
    v_key     := btrim(coalesce(p ->> 'retailer_key', ''));
    v_display := btrim(coalesce(p ->> 'display_name', ''));
    if v_key !~ '^[a-z0-9]+(_[a-z0-9]+)*$' then
      raise exception 'retailer_key "%" must be lowercase letters and digits joined by single underscores', v_key;
    end if;
    if v_display = '' then
      raise exception 'payer % has no display_name', v_key;
    end if;
    select display_name into v_existing from debtors where org_id = v_org and retailer_key = v_key;
    if v_existing is null then
      insert into debtors (org_id, retailer_key, display_name) values (v_org, v_key, v_display);
      payers_new := payers_new + 1;
    elsif v_existing <> v_display then
      raise exception 'payer % is already "%" in %, not "%"', v_key, v_existing, org_slug, v_display;
    end if;
  end loop;

  -- ---- the end state must be able to finish a case -------------------------
  if not exists (select 1 from memberships where org_id = v_org and role = 'owner') then
    raise exception 'workspace % would have no owner: nobody could connect QuickBooks or issue an email address', org_slug;
  end if;
  select count(*) into v_count from memberships
   where org_id = v_org and role in ('owner', 'approver', 'analyst');
  if v_count < 2 then
    raise exception 'workspace % needs at least two people who can write (owner, approver, analyst): the preparer of a decision can never approve it',
      org_slug;
  end if;

  raise notice 'onboard %: organization %; users created %, reused %; memberships created %; payers created %',
    org_slug, case when v_org_new then 'created' else 'existed' end,
    users_new, users_reused, members_new, payers_new;
end
$onboard$;
