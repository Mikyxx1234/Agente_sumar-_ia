-- Coluna id_lead em chat_messages_sum (histórico por lead Kommo).
-- Aplicar no Supabase principal antes do deploy do agente.

ALTER TABLE chat_messages_sum ADD COLUMN IF NOT EXISTS id_lead bigint;

CREATE INDEX IF NOT EXISTS idx_chat_messages_sum_id_lead ON chat_messages_sum(id_lead);
