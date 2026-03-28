// npm install better-sqlite3
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Parse command line arguments
function parseArgs() {
  const args = {
    db: null,
    command: null,
    input: null
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    
    if (arg === '--db' && process.argv[i + 1]) {
      args.db = process.argv[++i];
    } else if (arg === '--command' && process.argv[i + 1]) {
      args.command = process.argv[++i];
    } else if (arg === '--input' && process.argv[i + 1]) {
      args.input = process.argv[++i];
    }
  }

  return args;
}

// Generate 14-char MD5 hash
function generateTraceId(value) {
  if (!value) return null;
  const hash = crypto.createHash('md5').update(String(value)).digest('hex');
  return hash.substring(0, 14);
}

// Extract file_id values from details JSON
function extractFileIds(details) {
  if (!details) return [];
  
  const fileIds = [];
  
  try {
    const parsed = typeof details === 'string' ? JSON.parse(details) : details;
    
    // Check for single file_id
    if (parsed.file_id) {
      fileIds.push(parsed.file_id);
    }
    
    // Check for id field (some entries use 'id' for file identifier)
    if (parsed.id && typeof parsed.id === 'string' && parsed.id.includes('.')) {
      // Likely a file_id if it contains a dot (e.g., "81770192105580.test_file_002.mp3")
      fileIds.push(parsed.id);
    }
    
    // Check for file_ids array
    if (parsed.file_ids && Array.isArray(parsed.file_ids)) {
      fileIds.push(...parsed.file_ids);
    }
    
    // Check for files field (space-delimited or array)
    if (parsed.files) {
      if (Array.isArray(parsed.files)) {
        fileIds.push(...parsed.files);
      } else if (typeof parsed.files === 'string') {
        fileIds.push(...parsed.files.split(' ').filter(f => f.trim()));
      }
    }
    
    // Check for filename in session data
    if (parsed.what) {
      fileIds.push(parsed.what);
    }
    if ( parsed.session_id) fileIds.push(parsed.session_id);
    
  } catch (e) {
    // Failed to parse details, return empty array
  }
  
  return [...new Set(fileIds)]; // Return unique file_ids
}

// Generate trace_ids from file_ids
function generateTraceIds(fileIds) {
  if (!fileIds || fileIds.length === 0) return '';
  
  const traceIds = fileIds
    .map(fileId => generateTraceId(fileId))
    .filter(id => id !== null);
  
  return [...new Set(traceIds)].join(' ');
}

// Create SQLite database and table
function createDatabase(dbPath) {
  const db = new Database(dbPath);
  
  // Create BusinessLog table
  db.exec(`
    CREATE TABLE IF NOT EXISTS BusinessLog (
      id INTEGER PRIMARY KEY,
      level TEXT,
      created_at TEXT,
      employee_code TEXT,
      trace_ids TEXT,
      location TEXT,
      span_id TEXT,
      details TEXT
    )
  `);
  
  // Create index on trace_ids for efficient filtering
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_ids ON BusinessLog(trace_ids)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_span_id ON BusinessLog(span_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_created_at ON BusinessLog(created_at)`);
  
  return db;
}

// Process and insert BusinessLog entries
function initDatabase(db, inputFile) {
  console.log(`Reading input file: ${inputFile}`);
  
  let data;
  try {
    const content = fs.readFileSync(path.resolve(inputFile), 'utf8');
    data = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading input file: ${error.message}`);
    process.exit(1);
  }
  
  // Handle both array and single object
  const entries = Array.isArray(data) ? data : [data];
  
  console.log(`Processing ${entries.length} BusinessLog entries...`);
  console.log('');
  console.log('SPAN_ID                              | FILE_ID(s)                                       | TRACE_IDS');
  console.log('-'.repeat(120));
  
  // Prepare insert statement
  const insert = db.prepare(`
    INSERT INTO BusinessLog (id, level, created_at, employee_code, trace_ids, location, span_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // Begin transaction for better performance
  const insertMany = db.transaction((entries) => {
    for (const entry of entries) {
      // Extract file_ids from details
      const fileIds = extractFileIds(entry.details);
      
      // Generate trace_ids
      const traceIds = generateTraceIds(fileIds);
      
      // Output processing info
      const spanId = (entry.span_id || 'N/A').padEnd(36);
      const fileIdStr = fileIds.length > 0 
        ? fileIds.join(', ').substring(0, 48).padEnd(48)
        : 'N/A'.padEnd(48);
      const traceIdStr = traceIds || 'N/A';
      
      console.log(`${spanId} | ${fileIdStr} | ${traceIdStr}`);
      
      // Insert into database
      insert.run(
        entry.id,
        entry.level,
        entry.created_at,
        entry.employee_code,
        traceIds,
        entry.location,
        entry.span_id,
        entry.details
      );
    }
  });
  
  // Execute transaction
  insertMany(entries);
  
  console.log('');
  console.log(`Successfully processed ${entries.length} entries.`);
}

// Main function
function main() {
  const args = parseArgs();
  
  // Validate required arguments
  if (!args.db) {
    console.error('Error: --db argument is required');
    console.error('Usage: node runme-js-to-db --db <database.db> --command <command> [--input <input.json>]');
    process.exit(1);
  }
  
  if (!args.command) {
    console.error('Error: --command argument is required');
    console.error('Available commands: initdb');
    process.exit(1);
  }
  
  // Handle commands
  switch (args.command) {
    case 'initdb':
      if (!args.input) {
        console.error('Error: --input argument is required for initdb command');
        process.exit(1);
      }
      
      console.log(`Initializing database: ${args.db}`);
      // remove the file
      if (fs.existsSync(args.db)) {
        fs.unlinkSync(args.db);
      }
      const db = createDatabase(args.db);
      
      try {
        initDatabase(db, args.input);
      } finally {
        db.close();
      }
      break;
      
    default:
      console.error(`Error: Unknown command '${args.command}'`);
      console.error('Available commands: initdb');
      process.exit(1);
  }
}

// Run main function
main();