-- Simple view of all entries with trace_ids
SELECT 
    id,
    span_id,
    trace_ids,
    created_at
FROM BusinessLog
WHERE trace_ids IS NOT NULL AND trace_ids != ''
ORDER BY created_at;