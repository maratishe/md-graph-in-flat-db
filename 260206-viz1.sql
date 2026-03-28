-- Get unique trace_id lists that contain more than 1 id (space-delimited), top 10
SELECT DISTINCT trace_ids
FROM BusinessLog
WHERE trace_ids IS NOT NULL 
  AND trace_ids != '' 
  AND LENGTH(trace_ids) - LENGTH(REPLACE(trace_ids, ' ', '')) >= 1
ORDER BY trace_ids
LIMIT 10;