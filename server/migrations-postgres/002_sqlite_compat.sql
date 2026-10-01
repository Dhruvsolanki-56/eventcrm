CREATE OR REPLACE FUNCTION gather_compat_strftime(format_text text, base_time text, modifiers text[])
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  timestamp_value timestamptz;
  modifier text;
  parts text[];
BEGIN
  IF lower(base_time) = 'now' THEN
    timestamp_value := clock_timestamp();
  ELSE
    timestamp_value := base_time::timestamptz;
  END IF;

  FOREACH modifier IN ARRAY modifiers LOOP
    parts := regexp_match(btrim(modifier), '^([+-]?[0-9]+)\s+(seconds?|minutes?|hours?|days?|months?|years?)$', 'i');
    IF parts IS NULL THEN
      RAISE EXCEPTION 'Unsupported SQLite date modifier: %', modifier;
    END IF;
    timestamp_value := timestamp_value + (parts[1] || ' ' || parts[2])::interval;
  END LOOP;

  IF format_text <> '%Y-%m-%dT%H:%M:%fZ' THEN
    RAISE EXCEPTION 'Unsupported date format requested by Gather: %', format_text;
  END IF;
  RETURN to_char(timestamp_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END;
$$;

CREATE OR REPLACE FUNCTION strftime(format_text text, base_time text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT gather_compat_strftime(format_text, base_time, ARRAY[]::text[])
$$;

CREATE OR REPLACE FUNCTION strftime(format_text text, base_time text, modifier text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT gather_compat_strftime(format_text, base_time, ARRAY[modifier])
$$;

CREATE OR REPLACE FUNCTION strftime(format_text text, base_time text, modifier_one text, modifier_two text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT gather_compat_strftime(format_text, base_time, ARRAY[modifier_one,modifier_two])
$$;

CREATE OR REPLACE FUNCTION datetime(base_time text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', base_time)
$$;

CREATE OR REPLACE FUNCTION datetime(base_time text, modifier text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', base_time, modifier)
$$;

CREATE OR REPLACE FUNCTION json_extract(document_text text, json_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  key_name text;
BEGIN
  key_name := regexp_replace(json_path, '^\$\.', '');
  IF key_name = json_path OR key_name = '' OR position('.' IN key_name) > 0 THEN
    RETURN NULL;
  END IF;
  RETURN document_text::jsonb ->> key_name;
END;
$$;
