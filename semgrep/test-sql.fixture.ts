import { DatabaseSync } from 'node:sqlite'
import { MIGRATION_1 } from './store'
declare const thread: string
const H1 = 'h_11111111-1111-1111-1111-111111111111'
const raw = new DatabaseSync(':memory:')

// ok: cs-sql-built-by-string-test
raw.exec(`${MIGRATION_1}\nPRAGMA user_version = 1;`)
// ok: cs-sql-built-by-string-test
raw.exec(`INSERT INTO handoff_turns (handoff_id, turn_id) VALUES ('${H1}', 1), ('${H1}', 2);`)
// ruleid: cs-sql-built-by-string-test
raw.exec(`DELETE FROM threads WHERE id = '${thread}'`)
// ruleid: cs-sql-built-by-string-test
raw.prepare('SELECT * FROM threads WHERE id = ' + thread)
