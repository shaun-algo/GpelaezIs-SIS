-- Run against the selected application database after taking a backup.
-- Additive and repeatable: LIS import logs are the only recovery source.
ALTER TABLE learners
    ADD COLUMN IF NOT EXISTS birth_province_text VARCHAR(150) DEFAULT NULL AFTER birth_province_id;

START TRANSACTION;

-- Recover missing birthplace text only from successful imports, never preview/error rows.
-- Existing reference-backed birthplaces take precedence over historical import logs.
UPDATE learners l
JOIN (
    SELECT logs.lrn, JSON_UNQUOTE(JSON_EXTRACT(logs.raw_data, '$.raw_birth_province')) AS birthplace
    FROM import_log_rows logs
    JOIN (
        SELECT lrn, MAX(row_id) AS row_id
        FROM import_log_rows
        WHERE row_action IN ('Inserted', 'Updated')
          AND JSON_VALID(raw_data)
          AND NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.raw_birth_province'))), '') IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.raw_birth_province')) <> 'null'
        GROUP BY lrn
    ) latest ON latest.row_id = logs.row_id
) source ON source.lrn = l.lrn
SET l.birth_province_text = TRIM(source.birthplace), l.updated_at = l.updated_at
WHERE NULLIF(TRIM(l.birth_province_text), '') IS NULL
  AND l.birth_province_id IS NULL;

COMMIT;
