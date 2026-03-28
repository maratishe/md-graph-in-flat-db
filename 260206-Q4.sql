-- Summary: count of entries per trace_id with timeline
WITH RECURSIVE split_trace(log_id, span_id, created_at, employee_code, trace_id, rest) AS (
    SELECT 
        id,
        span_id,
        created_at,
        employee_code,
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
        log_id,
        span_id,
        created_at,
        employee_code,
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
),
trace_entries AS (
    SELECT 
        trace_id,
        span_id,
        created_at,
        employee_code,
        log_id
    FROM split_trace
    WHERE trace_id != ''
),
trace_counts AS (
    SELECT 
        trace_id,
        COUNT(*) as entry_count,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen
    FROM trace_entries
    GROUP BY trace_id
)
SELECT 
    e.trace_id AS hash_id,
    c.entry_count,
    e.span_id,
    e.created_at,
    e.employee_code
FROM trace_entries e
JOIN trace_counts c ON e.trace_id = c.trace_id
ORDER BY c.entry_count DESC, e.trace_id, e.created_at;