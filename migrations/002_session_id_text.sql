-- Session identifiers are opaque 64 character random hex strings, not UUIDs.
-- The cookie carries the id plus an HMAC signature, so the id only needs to be
-- unique and unguessable.
BEGIN;
ALTER TABLE session ALTER COLUMN id TYPE text USING id::text;
COMMIT;
