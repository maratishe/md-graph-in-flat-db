# Hands-on: Embedding Graphs into plaintext/flat DB and using them for tracing and/or MD visualization

**Duration:** ~20–30 min reading, ~1–2 hours hands-on with code  
**Prerequisites:** Node.js (v16+), SQLite3 CLI, a text editor or VS Code  
**Dataset:** Anonymized log entries (provided as JSON)

## Overview

In many enterprise systems, a single file — such as a recorded meeting audio — passes through multiple processing stages, is handled by different employees, and appears across many sessions. Understanding the full lifecycle of such a file typically requires graph-based analysis, but deploying a dedicated graph database (e.g., Neo4j [1], TigerGraph [2]) is often impractical when your infrastructure is built around relational databases.

This hands-on demonstrates a lightweight alternative: **embedding multi-dimensional graph relationships into a single text field** in a flat relational database (SQLite [3]), then extracting and visualizing those relationships using SQL, Mermaid [4], and Graphviz [5].

By the end of this session, you will be able to:

1. Understand how to encode graph-like relationships in a flat DB schema
2. Write recursive SQL queries to split, deduplicate, and trace multi-valued fields
3. Visualize trace relationships as metromap-style diagrams



## Table of Contents

1. **The Data:** Show actual log entries with multiple dimensions (filename, employee, session, processing stage, etc.)
2. **The Problem:** Why we need to embed multiple dimensions into a single field
3. **Answer 1:** Define graph nodes (files, sessions, processing stages, employees)
4. **Answer 2:** Identify each unique node by its MD5 hash and store all IDs in a single DB field
5. **Answer 3:** Query using recursive SQL to split, deduplicate, and trace
6. **Answer 4:** Extract unique identifiers in bulk and visualize as metromap graphs
7. **References**


## (1) The Data: Multiple Dimensions in Business Logs

Each log entry in our system records an event that may reference **multiple dimensions simultaneously**:

| Dimension | Field(s) | Example |
|-----------|----------|---------|
| **File** | `file_id`, `file_ids`, `deleted_files` | `file_0008.mp3` |
| **Employee** | `employee_code` | `POOW` |
| **Session** | `session_id`, `trace_ids` | `7de98ea6e91a` |
| **Processing stage** | `span_id` | `BE.function2.get` |
| **Location** | `location` | `location1-backend-somewhere` |
| **Time** | `created_at` | `2026-02-04T08:48:56.816835+00:00` |

Here are three representative log entries from the anonymized dataset. Notice how each entry combines several of these dimensions — a single `BE.function2.get` call references 9 files, while a `BE.file.new` entry links a file to a session via `trace_ids`:

Here are three representative log entries from the anonymized dataset. Notice how each entry combines several of these dimensions — a single `BE.function2.get` call references 9 files, while a `BE.file.new` entry links a file to a session via `trace_ids`:

```
...
{
    "id": 398279,
    "level": "INFO",
    "created_at": "2026-02-04T08:48:56.816835+00:00",
    "employee_code": "POOW",
    "trace_ids": "",
    "location": "location1-backend-somewhere",
    "span_id": "BE.function2.get",
    "details": "{\"date\":null,\"cutoff_date\":\"2026-01-29 00:00:00\",\"file_ids\":[\"file_0001.mp3\",\"file_0002.mp3\",\"file_0003.mp3\",\"file_0004.mp3\",\"file_0005.mp3\",\"file_0006.mp3\",\"file_0007.mp3\",\"file_0008.mp3\",\"file_0009.mp3\"]}",
    "_bulk_data": null,
    "_bulk_data_error": null
},
{
    "id": 398277,
    "level": "INFO",
    "created_at": "2026-02-04T08:48:48.618631+00:00",
    "employee_code": "POOW",
    "trace_ids": "7de98ea6e91a",
    "location": "location1-backend-somewhere",
    "span_id": "BE.file.new",
    "details": "{\"file_id\":\"file_0008.mp3\",\"date\":\"20260204\",\"meeting\":\"45872081\",\"some_flag\":false}",
    "_bulk_data": null,
    "_bulk_data_error": null
},
{
    "id": 395996,
    "level": "INFO",
    "created_at": "2026-01-31T00:01:24.190825+00:00",
    "employee_code": "POOW",
    "trace_ids": "",
    "location": "location1-backend-somewhere",
    "span_id": "BE.function2.deletebefore.list",
    "details": "{\"yyyymmdd\":\"20260129\",\"files\":[\"file_0041.mp3\"]}",
    "_bulk_data": null,
    "_bulk_data_error": null
}
...
```

The key observation is that **relationships between entities are implicit** — they are buried inside JSON blobs in the `details` field and scattered across the `trace_ids`, `employee_code`, and `span_id` columns. To trace a file's lifecycle, you would need to join across all of these dimensions, which is exactly what a graph database excels at — but we want to do it without one.



## (2) The Problem: Embedding Multiple Dimensions in a Single Field

### Why not use a graph database?

Graph-native solutions like Neo4j [1] or TigerGraph [2] are purpose-built for multi-dimensional relationship data. They can natively represent nodes (files, employees, sessions) and edges (relationships between them). However:

- They require **additional infrastructure** — a separate database server, new query languages (Cypher [6], GSQL), and operational overhead
- Many teams already have **existing relational databases** (PostgreSQL, MySQL, SQLite) that store these logs
- For exploratory analysis and small-to-medium datasets (thousands to low millions of rows), the overhead of a graph DB is not justified

### Why not use visualization tools directly?

Tools like Graphviz [5] (dot notation, metromaps) and Mermaid [4] are excellent for rendering graphs, but they require **structured input**. Raw log data needs a parsing and extraction stage before it can be visualized.

### The approach: graph-in-flat-DB

The idea is simple:

1. **Extract** all unique identifiers (file names, session IDs, etc.) from each log entry
2. **Hash** each identifier to a short, collision-resistant string (14-character MD5 prefix)
3. **Store** all hashes for a given log entry in a single space-delimited `trace_ids` field
4. **Query** using recursive SQL to split, join, and trace relationships
5. **Visualize** by exporting unique co-occurrence patterns as metromap graphs

This lets you leverage your existing relational database while capturing the multi-dimensional relationships between entities. The two ultimate goals are:

1. **Lifecycle tracing:** follow a single file across processing stages, sessions, and employees over time
2. **Pattern discovery:** identify clusters, central nodes, and anomalies using graph analysis libraries in Python [7], R, or other tools — fed by batches of trace IDs extracted from the DB





## (3) Answer 1: Define Graph Nodes

In a traditional graph model, you would define explicit node types and edge types. In our approach, we take a simpler stance:

> **One log entry is a node. Whatever unique identifiers appear in that entry are "links" to other nodes that share the same identifiers.**

This means:

- A **file** (`file_0008.mp3`) is not a node itself — rather, every log entry that mentions `file_0008.mp3` becomes connected to every other log entry that also mentions it
- An **employee** (`POOW`) similarly connects all log entries associated with that employee
- A **session** connects all log entries that share the same session ID

The "edges" are implicit: two log entries are connected if they share at least one identifier in their `trace_ids` field. The more identifiers they share, the stronger the connection. This is essentially a **hypergraph** [8] projected onto a flat relational schema.


## (4) Answer 2: Hash-Based Identification

To store multiple identifiers efficiently in a single text field, we hash each unique value (file name, session ID, etc.) using MD5 and truncate to the first 14 hexadecimal characters:

- `md5("file_0001.mp3")` → `e2c569be17396eca2a2e3c11578123ed` → **`e2c569be17396e`**

**Why 14 characters?** The collision probability for 14 hex chars is approximately 1 in 16¹⁴ ≈ 7.2 × 10¹⁶. For datasets with thousands to millions of unique identifiers, this is effectively zero. The truncation saves storage space and makes the `trace_ids` field more readable.

The hashing is performed by the [`runme-js-to-db.js`](md-graph-in-flat-db/runme-js-to-db.js) script during database initialization. It parses the `details` JSON field of each log entry, extracts file IDs, session IDs, and other unique values, hashes each one, and concatenates them with spaces into the `trace_ids` field.

The resulting schema looks like this:
 - filename -> `md5("file_0001.mp3")` -> `e2c569be17396eca2a2e3c11578123`
 - unique to 14 head chars: `e2c569be17396e`, collision probability is very low (1 in 16^14 = 1 in 7.2e16)

So, in db we have:
```
span_id                             | details (with embedded md5 hash ids for files, sessions, etc.) | trace_ids (md5 of file names, session ids, etc.)
BE.function2.get                     | file_0051.mp3, file_0086.mp3, file_0087.mp3, fil | 4931d3afc6e672 4d22a4251f1d1c 4eb6bf15031600 2479dde7ed882b 807b6b1724d30e
BE.function3.post.done               | file_0024                                        | f90197d492238b
BE.function3.files.after             | file_0024                                        | f90197d492238b
BE.function3.files.before            | file_0024                                        | f90197d492238b
```

Each row's `trace_ids` field is a space-delimited list of 14-character hashes. A `BE.function2.get` call that returns 5 files will have 5 hashes in its `trace_ids`. A `BE.function3.post.done` call that processes a single file will have just 1 hash. This encoding is the foundation for all subsequent queries.



## (5) Answer 3: Querying with Recursive SQL

Now that identifiers are embedded in the `trace_ids` field, we need SQL queries to extract and analyze them. SQLite's support for recursive Common Table Expressions (CTEs) [9] makes this possible without any application code.

### Setup

Before running the queries, set up the local SQLite database:

1. Ensure you have **Node.js** (v16 or later) installed
2. Install the `better-sqlite3` package: `npm install better-sqlite3`
3. Initialize the database from the anonymized dataset:

```bash
node runme-js-to-db.js --db 260206.db --command initdb --input 260206-dataset-anonymized.json 
```


This creates a `260206.db` SQLite file with a `BusinessLog` table containing all the anonymized log entries, complete with pre-computed `trace_ids`.

The following subsections build up query complexity incrementally — from simple viewing to full lifecycle tracing.


### (5-1) Step 1: View raw trace_ids (query: `260206-Q1.sql`)

The simplest query just retrieves all log entries that have at least one trace ID. This gives you a feel for the data volume and the structure of the `trace_ids` field:


```sql
-- Simple view of all entries with trace_ids
SELECT 
    id,
    span_id,
    trace_ids,
    created_at
FROM BusinessLog
WHERE trace_ids IS NOT NULL AND trace_ids != ''
ORDER BY created_at;
```

run sql against the local db:

```bash
sqlite3 260206.db < 260206-Q1.sql
378739|BE.function2.get|c71b345135dfd9|2026-01-20T07:34:30.695348+00:00
378741|BE.function2.get|c71b345135dfd9|2026-01-20T07:35:01.299873+00:00
378752|BE.function3.files.before|73e39054576368|2026-01-20T07:39:33.745497+00:00
378753|BE.function3.files.after|73e39054576368|2026-01-20T07:39:33.763494+00:00
378754|BE.function3.post.kakutei|73e39054576368|2026-01-20T07:39:33.826545+00:00
378755|BE.function3.post.done|73e39054576368|2026-01-20T07:39:35.131301+00:00
378772|BE.function2.get|e844141f43e3f7 ae7a40b9fa4a21|2026-01-20T07:46:13.195698+00:00
378775|BE.function2.get|c71b345135dfd9|2026-01-20T07:47:20.786875+00:00
378777|BE.function2.get|c71b345135dfd9|2026-01-20T07:47:40.710533+00:00
378779|BE.function2.get|e844141f43e3f7 ae7a40b9fa4a21|2026-01-20T07:47:56.210949+00:00
378780|BE.function2.get|c71b345135dfd9|2026-01-20T07:48:08.105727+00:00
378784|BE.function2.get|e844141f43e3f7 ae7a40b9fa4a21|2026-01-20T07:49:45.603084+00:00
378793|BE.function2.get|61070dafab8640 89c1323e7bf0a6 009f2d25f54896 ff3b3983d02faa ecfeb81a6c3c26 aa725923904dda 2b010e839d0848 3db16a2410a415 ec25183f3acb1
8 618a8690c39cc5 2f03d8f0f21d0a 47f541dc92bbe0 73e39054576368 c67b53076a53f7|2026-01-20T07:53:49.812955+00:00
378817|BE.function2.get|e844141f43e3f7 ae7a40b9fa4a21|2026-01-20T08:04:22.870693+00:00
...
```

Notice that some entries have a single hash (e.g., `c71b345135dfd9` — a single file), while others have many hashes separated by spaces (e.g., the `BE.function2.get` entry with 14 file hashes). The multi-valued entries are the ones that encode relationships — they tell us which files were "seen together" in a single API call.


### (5-2) Step 2: Split space-delimited trace_ids into rows (query: `260206-Q2.sql`)

To work with individual trace IDs, we need to split the space-delimited string into separate rows. SQLite doesn't have a built-in `STRING_SPLIT` function (unlike PostgreSQL's `STRING_TO_TABLE` or SQL Server's `STRING_SPLIT`), so we use a **recursive CTE** [9] that peels off one token at a time:

```sql
-- Split space-delimited trace_ids into individual rows
WITH RECURSIVE split_trace(id, span_id, created_at, trace_id, rest) AS (
    -- Base case: get the first trace_id and the rest of the string
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
    
    -- Recursive case: continue splitting the rest
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
SELECT id, span_id, created_at, trace_id
FROM split_trace
WHERE trace_id != ''
ORDER BY created_at;
```

run it against the local db:

```bash
sqlite3 260206.db < 260206-Q2.sql
378739|BE.function2.get|2026-01-20T07:34:30.695348+00:00|c71b345135dfd9
378741|BE.function2.get|2026-01-20T07:35:01.299873+00:00|c71b345135dfd9
378752|BE.function3.files.before|2026-01-20T07:39:33.745497+00:00|73e39054576368
378753|BE.function3.files.after|2026-01-20T07:39:33.763494+00:00|73e39054576368
378754|BE.function3.post.kakutei|2026-01-20T07:39:33.826545+00:00|73e39054576368
378755|BE.function3.post.done|2026-01-20T07:39:35.131301+00:00|73e39054576368
378772|BE.function2.get|2026-01-20T07:46:13.195698+00:00|e844141f43e3f7
378772|BE.function2.get|2026-01-20T07:46:13.195698+00:00|ae7a40b9fa4a21
378775|BE.function2.get|2026-01-20T07:47:20.786875+00:00|c71b345135dfd9
378777|BE.function2.get|2026-01-20T07:47:40.710533+00:00|c71b345135dfd9
378779|BE.function2.get|2026-01-20T07:47:56.210949+00:00|e844141f43e3f7
378779|BE.function2.get|2026-01-20T07:47:56.210949+00:00|ae7a40b9fa4a21
378780|BE.function2.get|2026-01-20T07:48:08.105727+00:00|c71b345135dfd9
378784|BE.function2.get|2026-01-20T07:49:45.603084+00:00|e844141f43e3f7
378784|BE.function2.get|2026-01-20T07:49:45.603084+00:00|ae7a40b9fa4a21
378793|BE.function2.get|2026-01-20T07:53:49.812955+00:00|61070dafab8640
378793|BE.function2.get|2026-01-20T07:53:49.812955+00:00|89c1323e7bf0a6
378793|BE.function2.get|2026-01-20T07:53:49.812955+00:00|009f2d25f54896
378793|BE.function2.get|2026-01-20T07:53:49.812955+00:00|ff3b3983d02faa
```

The recursive CTE works in two phases:

1. **Base case:** For each row in `BusinessLog`, extract the first token (everything before the first space) and store the remainder
2. **Recursive case:** From the remainder, extract the next token and repeat until nothing is left

The result is that a single row like `378772|BE.function2.get|e844141f43e3f7 ae7a40b9fa4a21|...` is expanded into two rows — one for each trace ID. This "exploded" view is the foundation for all downstream analysis: counting, grouping, joining, and tracing.



### (5-3) Step 3: Extract unique trace IDs (query: `260206-Q3.sql`)

Building on the split CTE, we can extract the complete set of unique identifiers in the dataset with `SELECT DISTINCT`:

```sql
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
```

run it against the local db:

```bash
sqlite3 260206.db < 260206-Q3.sql | more
009f2d25f54896
03951b21d95b3a
046ffc14874a96
05cbaf5a147acf
0601fa72f290d5
0676a877cacfbd
0677bce5c0013e
097cbcf89a0720
0b3761bed30f35
0cc1916a516854
0cda7748102fdb
0d792633305cd6
...
```

A flat list of unique IDs is not very useful on its own — you cannot tell which ID represents a file, a session, or something else (that information is lost during hashing, by design). However, this list serves two important purposes:

1. **Cardinality check:** How many unique entities exist in the dataset? This helps you gauge the complexity of the graph.
2. **Building block:** Combined with the split CTE and additional joins, these IDs become the foundation for the full lifecycle query in the next step.



### (5-4) Step 4: Full lifecycle tracing (query: `260206-Q4.sql`)

This is the culminating query. It combines the recursive split with aggregation (`COUNT`, `MIN`, `MAX`) and a join to produce a complete timeline for every trace ID, ordered by frequency:

```sql
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
```


run it against the local db:

```bash
sqlite3 260206.db < 260206-Q4.sql | more
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:10:45.754536+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:10:48.282510+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:10:56.865942+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:11:41.030037+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:11:43.278977+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:11:46.350796+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-01-30T08:11:52.555053+00:00|POOW
c7a6ba3a2c7b1b|630|BE.file.new|2026-01-30T08:13:31.492183+00:00|POOW
c7a6ba3a2c7b1b|630|BE.file.linked|2026-01-30T08:13:31.553724+00:00|POOW
c7a6ba3a2c7b1b|630|function6.session.complete|2026-01-30T08:13:38.933844+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function1.post.file|2026-01-30T08:32:29.819139+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-02-01T23:56:30.500816+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-02-01T23:56:30.502671+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-02-01T23:56:30.502809+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-02-01T23:56:39.708242+00:00|POOW
c7a6ba3a2c7b1b|630|BE.function2.get|2026-02-01T23:56:41.229994+00:00|POOW
...
```

The query has three logical stages:

1. **`split_trace`** — Recursive CTE that splits `trace_ids` into individual rows, carrying along `log_id`, `span_id`, `created_at`, and `employee_code`
2. **`trace_entries`** — Simple filter to remove empty trace IDs
3. **`trace_counts`** — Aggregation: how many log entries reference each trace ID, and when it was first/last seen

The final `SELECT` joins entries with counts, producing a denormalized timeline sorted by most-referenced trace IDs first.



The output columns are:

| Column | Description |
|--------|-------------|
| `hash_id` | 14-char MD5 hash of a file name, session ID, or other unique identifier |
| `entry_count` | Total number of log entries that reference this trace ID |
| `span_id` | Processing stage or function name (e.g., `BE.function2.get`, `BE.file.new`) |
| `created_at` | Timestamp of the log entry (ISO 8601) |
| `employee_code` | Anonymized employee identifier |

### Reading the output

The most-referenced trace ID (`c7a6ba3a2c7b1b`, 630 entries) tells a clear story when read chronologically:

1. **Polling phase** (`BE.function2.get`, repeated): The user checks the file list multiple times
2. **Upload phase** (`BE.file.new` → `BE.file.linked`): A new file is created and linked
3. **External processing** (`function6.session.complete`): An external service (e.g., transcription) completes its work
4. **Post-processing** (`BE.function1.post.file`): The backend finalizes the file
5. **Subsequent polling** (`BE.function2.get`, repeated again): The file now appears in future list retrievals

This is the **lifecycle of a single file** — from upload through external processing to availability — traced entirely from flat log data using SQL.



## (6) Answer 4: Metromap Visualization

The lifecycle query (5-4) gives us a textual timeline. But for pattern discovery across many trace IDs simultaneously, we need a **visual representation**. We use the "metromap" metaphor:

- Each **unique hash ID** is a "station"
- Each **unique combination of hash IDs** (i.e., a distinct `trace_ids` value from a log entry) is a "train line" that passes through those stations
- Stations that appear together frequently are tightly connected — they represent entities that co-occur in the same operations

This is essentially a **co-occurrence graph** [10] projected as a transit map.

### (6-1) Extracting train lines via SQL

The following query selects the top 10 distinct `trace_ids` values that contain more than one hash (i.e., multi-entity relationships):


(6-1) let's get some trains via sql:

```sql
-- Get unique trace_id lists that contain more than 1 id (space-delimited), top 10
SELECT DISTINCT trace_ids
FROM BusinessLog
WHERE trace_ids IS NOT NULL 
  AND trace_ids != '' 
  AND LENGTH(trace_ids) - LENGTH(REPLACE(trace_ids, ' ', '')) >= 1
ORDER BY trace_ids
LIMIT 10;
```


### (6-1) Extracting train lines via SQL

The following query selects the top 10 distinct `trace_ids` values that contain more than one hash (i.e., multi-entity relationships):

```bash
03951b21d95b3a 7d99009ec76167
03951b21d95b3a 7d99009ec76167 881b35c825cfef
03951b21d95b3a 881b35c825cfef
046ffc14874a96 843a36d3028503
046ffc14874a96 c3736083f514d9 2329edd4ec5a22 fcb338a9e961f7
046ffc14874a96 c3736083f514d9 d274b4f22ada77 fcb338a9e961f7 6d84c4164522d2 edcee1d5463a87 2329edd4ec5a22
046ffc14874a96 c3736083f514d9 fcb338a9e961f7 2329edd4ec5a22
046ffc14874a96 c3736083f514d9 fcb338a9e961f7 6d84c4164522d2 2329edd4ec5a22
046ffc14874a96 c3736083f514d9 fcb338a9e961f7 6d84c4164522d2 edcee1d5463a87 2329edd4ec5a22
046ffc14874a96 c3736083f514d9 fcb338a9e961f7 6d84c4164522d2 edcee1d5463a87 2329edd4ec5a22 d274b4f22ada77
```


### (6-2) Mermaid metromap

We can convert these train lines into a Mermaid [4] `graph LR` diagram. Each unique hash becomes a labeled node (showing the first 6 and last 6 characters for readability), and each train line becomes a sequence of directed edges labeled with the line number:

```
graph LR
    %% Define stations (unique trace_ids) with short labels
    A["03951b<br/>...d95b3a"]
    B["7d9900<br/>...c76167"]
    C["881b35<br/>...25cfef"]
    D["046ffc<br/>...874a96"]
    E["843a36<br/>...028503"]
    F["c37360<br/>...f514d9"]
    G["2329ed<br/>...c5a22"]
    H["fcb338<br/>...961f7"]
    I["d274b4<br/>...ada77"]
    J["6d84c4<br/>...522d2"]
    K["edcee1<br/>...463a87"]

    %% Train 1: 03951b --> 7d9900
    A -->|line1| B

    %% Train 2: 03951b --> 7d9900 --> 881b35
    A -->|line2| B -->|line2| C

    %% Train 3: 03951b --> 881b35
    A -->|line3| C

    %% Train 4: 046ffc --> 843a36
    D -->|line4| E

    %% Train 5: 046ffc --> c37360 --> 2329ed --> fcb338
    D -->|line5| F -->|line5| G -->|line5| H

    %% Train 6: 046ffc --> c37360 --> d274b4 --> fcb338 --> 6d84c4 --> edcee1 --> 2329ed
    D -->|line6| F -->|line6| I -->|line6| H -->|line6| J -->|line6| K -->|line6| G

    %% Train 7: 046ffc --> c37360 --> fcb338 --> 2329ed
    D -->|line7| F -->|line7| H -->|line7| G

    %% Train 8: 046ffc --> c37360 --> fcb338 --> 6d84c4 --> 2329ed
    D -->|line8| F -->|line8| H -->|line8| J -->|line8| G

    %% Train 9: 046ffc --> c37360 --> fcb338 --> 6d84c4 --> edcee1 --> 2329ed
    D -->|line9| F -->|line9| H -->|line9| J -->|line9| K -->|line9| G

    %% Train 10: 046ffc --> c37360 --> fcb338 --> 6d84c4 --> edcee1 --> 2329ed --> d274b4
    D -->|line10| F -->|line10| H -->|line10| J -->|line10| K -->|line10| G -->|line10| I

    %% Styling - red cluster for 03951b group, blue cluster for 046ffc group
    style A fill:#e74c3c,color:#fff
    style B fill:#e74c3c,color:#fff
    style C fill:#e74c3c,color:#fff
    style D fill:#3498db,color:#fff
    style E fill:#3498db,color:#fff
    style F fill:#2ecc71,color:#fff
    style G fill:#f39c12,color:#fff
    style H fill:#9b59b6,color:#fff
    style I fill:#1abc9c,color:#fff
    style J fill:#e67e22,color:#fff
    style K fill:#34495e,color:#fff
```

, which results in something like

![](README-sketch.png)


### (6-3) Graphviz alternative

Graphviz [5] offers a more compact syntax using its `dot` language. Each train line is a single statement with `--` connecting the stations. The layout engine automatically handles node positioning and edge routing:

```
graph G {
    line1 -- 03951b21d95b3a -- 7d99009ec76167
    line2 -- 03951b21d95b3a -- 7d99009ec76167 -- 881b35c825cfef
    line3 -- 03951b21d95b3a -- 881b35c825cfef
    line4 -- 046ffc14874a96 -- 843a36d3028503
    line5 -- 046ffc14874a96 -- c3736083f514d9 -- 2329edd4ec5a22 -- fcb338a9e961f7
    line6 -- 046ffc14874a96 -- c3736083f514d9 -- d274b4f22ada77 -- fcb338a9e961f7 -- 6d84c4164522d2 -- edcee1d5463a87 -- 2329edd4ec5a22
    line7 -- 046ffc14874a96 -- c3736083f514d9 -- fcb338a9e961f7 -- 2329edd4ec5a22
    line8 -- 046ffc14874a96 -- c3736083f514d9 -- fcb338a9e961f7 -- 6d84c4164522d2 -- 2329edd4ec5a22
    line9 -- 046ffc14874a96 -- c3736083f514d9 -- fcb338a9e961f7 -- 6d84c4164522d2 -- edcee1d5463a87 -- 2329edd4ec5a22
    line10 -- 046ffc14874a96 -- c3736083f514d9 -- fcb338a9e961f7 -- 6d84c4164522d2 -- edcee1d5463a87 -- 2329edd4ec5a22 -- d274b4f22ada77
}
```

, which results in:

![](README-sketch-graphviz.png)


### (6-4) Reading the metromap

Two distinct clusters are visible:

1. **Red cluster** (stations `03951b`, `7d9900`, `881b35`): Three stations connected by 3 train lines. This represents a small group of entities (likely 2–3 files or a file + session) that appear together in various combinations. The triangle pattern suggests these entities are closely related — perhaps files uploaded in the same batch.

2. **Blue/multi-color cluster** (stations `046ffc`, `843a36`, `c37360`, `fcb338`, `6d84c4`, `edcee1`, `2329ed`, `d274b4`): Eight stations connected by 7 train lines. This is a more complex lifecycle — a file that accumulates relationships over time as it passes through processing stages. The "core" stations (`046ffc`, `c37360`, `fcb338`) appear in almost every line, while peripheral stations (`843a36`, `d274b4`) appear in fewer lines.

The metromap reveals **structural patterns** that are invisible in tabular data:

- **Hub stations** (high degree) represent entities central to many operations
- **Peripheral stations** (low degree) represent entities involved in specific stages only
- **Line density** between stations indicates how frequently those entities co-occur

For larger datasets, you would export hundreds or thousands of train lines and analyze the resulting graph programmatically using libraries like NetworkX [7] (Python) or igraph [11] (R/Python) to compute centrality measures, detect communities, and identify anomalies.

---


## Summary

| Step | What | Tool |
|------|------|------|
| Data prep | Hash identifiers, store in `trace_ids` | Node.js + better-sqlite3 |
| Query 1 | View raw trace_ids | SQLite CLI |
| Query 2 | Split multi-valued field into rows | Recursive CTE |
| Query 3 | Extract unique identifiers | `SELECT DISTINCT` |
| Query 4 | Full lifecycle timeline | Recursive CTE + JOIN + aggregation |
| Visualize | Metromap diagram | Mermaid / Graphviz |

The key insight is that **you don't need a graph database to do graph analysis**. By encoding relationships as space-delimited hashes in a single field, you can use standard SQL to extract, split, and trace those relationships — and then feed the results into any visualization or graph analysis tool.



---

## References

[1] Neo4j Graph Database. https://neo4j.com/

[2] TigerGraph. https://www.tigergraph.com/

[3] SQLite. https://www.sqlite.org/

[4] Mermaid — Diagramming and charting tool. https://mermaid.js.org/

[5] Graphviz — Graph Visualization Software. https://graphviz.org/

[6] Francis, N., Green, A., Guagliardo, P., et al., "Cypher: An Evolving Query Language for Property Graphs," Proceedings of the 2018 International Conference on Management of Data (SIGMOD), pp. 1433–1445, 2018.

[7] Hagberg, A. A., Schult, D. A., Swart, P. J., "Exploring Network Structure, Dynamics, and Function using NetworkX," Proceedings of the 7th Python in Science Conference (SciPy), pp. 11–15, 2008. https://networkx.org/

[8] Berge, C., "Graphs and Hypergraphs," North-Holland Publishing Company, 1973.

[9] SQLite WITH clause (Common Table Expressions). https://www.sqlite.org/lang_with.html

[10] Newman, M. E. J., "Networks: An Introduction," Oxford University Press, 2010.

[11] Csardi, G., Nepusz, T., "The igraph software package for complex network research," InterJournal Complex Systems, 1695, 2006. https://igraph.org/


