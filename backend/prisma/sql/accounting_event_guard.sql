-- backend/prisma/sql/accounting_event_guard.sql
-- 禁止對 AccountingEvent 進行 UPDATE 與 DELETE 的安全 Trigger

CREATE OR REPLACE FUNCTION prevent_accounting_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AccountingEvent records are append-only and cannot be modified or deleted!';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_event_guard ON "AccountingEvent";

CREATE TRIGGER trg_accounting_event_guard
BEFORE UPDATE OR DELETE ON "AccountingEvent"
FOR EACH ROW
EXECUTE FUNCTION prevent_accounting_event_modification();
