-- Account freshness (stage 10). Never edit 0001–0004: they are applied on
-- running instances.
--
-- Google discovery reads each accessible customer's hierarchy separately. When
-- one of those reads fails (a transient error, or a manager account Google did
-- not answer for), the accounts reached through it are not confirmed but not
-- known to be gone either. Rediscovery then keeps their rows as they were (id,
-- selection and project assignment included) and marks them here, instead of
-- deleting them and cascading their project assignments away. A later complete
-- read clears the mark, or deletes the account if it really is gone.

-- Epoch ms of the first discovery that could not confirm the account; NULL when
-- the latest discovery listed it.
ALTER TABLE connected_account ADD COLUMN stale_since INTEGER;
