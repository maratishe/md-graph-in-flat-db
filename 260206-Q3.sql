-- Get all unique trace_ids
WITH RECURSIVE split_trace(id, span_id, created_at, trace_id, rest) AS (
    SELECT 
        id,
        span_id,
        created_at,
        CASE 
            WHEN INSTR(trace_ids || ' ', ' ') > 0 
            THEN SUBSTR(trace_ids || ' ', 1, INSTR(trace_ids || ' ', ' ') - 1)
            ELSE trace_ids
        END,
        CASE 
            WHEN INSTR(trace_ids || ' ', ' ') > 0 
            THEN SUBSTR(trace_ids || ' ', INSTR(trace_ids || ' ', ' ') + 1)
            ELSE ''
        END
    FROM BusinessLog
    WHERE trace_ids IS NOT NULL AND trace_ids != ''
    
    UNION ALL
    
    SELECT 
        id,
        span_id,
        created_at,
        CASE 
            WHEN INSTR(rest, ' ') > 0 
            THEN SUBSTR(rest, 1, INSTR(rest, ' ') - 1)
            ELSE rest
        END,
        CASE 
            WHEN INSTR(rest, ' ') > 0 
            THEN SUBSTR(rest, INSTR(rest, ' ') + 1)
            ELSE ''
        END
    FROM split_trace
    WHERE rest != ''
)
SELECT DISTINCT trace_id
FROM split_trace
WHERE trace_id != ''
ORDER BY trace_id;