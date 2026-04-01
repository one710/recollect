-- Recollect storage: tables, PostgREST roles, and RPC helpers (used by Supabase JS / PostgREST).

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id TEXT PRIMARY KEY,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  last_compaction_tokens_before INTEGER,
  last_compaction_tokens_after INTEGER,
  last_compaction_reason TEXT,
  canonical_context TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_events (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id
  ON session_events (session_id, id DESC);

-- PostgREST: authenticator switches to anon for requests (matches Supabase-style JWT role "anon").
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'authenticatorsecret';
  END IF;
END
$$;

GRANT anon TO authenticator;

GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_stats TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_events TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE recollect IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE recollect IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon;

CREATE OR REPLACE FUNCTION public.recollect_replace_messages(
  p_session_id text,
  p_records jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM messages WHERE session_id = p_session_id;
  INSERT INTO messages (session_id, run_id, data)
  SELECT
    p_session_id,
    CASE
      WHEN NOT (elem ? 'run_id') OR jsonb_typeof(elem->'run_id') = 'null' THEN NULL
      ELSE elem->>'run_id'
    END,
    elem->>'data'
  FROM jsonb_array_elements(p_records) AS elem;
END;
$$;

REVOKE ALL ON FUNCTION public.recollect_replace_messages(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recollect_replace_messages(text, jsonb) TO anon;

CREATE OR REPLACE FUNCTION public.recollect_truncate_for_testing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE messages, session_events, session_stats RESTART IDENTITY CASCADE;
END;
$$;

REVOKE ALL ON FUNCTION public.recollect_truncate_for_testing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recollect_truncate_for_testing() TO anon;
