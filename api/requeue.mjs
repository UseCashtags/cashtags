/**
 * Operator: put ONE refused or failed post back in the launch queue. Run on the box with the api's env:
 *   node api/requeue.mjs <tweet id> [--allow-taken-ticker]
 * --allow-taken-ticker lets this post past the 24 h cashtag rule (every other rule still applies). The bot then launches it
 * on its next pass (within ~2 s) and replies with the CA. Nothing else in the queue changes.
 */
import { join } from 'node:path'
import { openDb, now } from './db.mjs'

const [id, flag] = process.argv.slice(2)
if (!/^[0-9]{5,25}$/.test(id ?? '')) { console.error('usage: node api/requeue.mjs <tweet id> [--allow-taken-ticker]'); process.exit(1) }
const db = openDb(process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'cashtags.db'))
const m = db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(id)
if (!m) { console.error(`no post ${id} in the queue's history (the bot has not read it yet?)`); process.exit(1) }
if (!['rejected', 'failed'].includes(m.state)) { console.error(`post ${id} is ${m.state}: only a refused or failed post can be requeued`); process.exit(1) }
const r = db.prepare(`UPDATE mentions SET state = 'queued', code = NULL, reason = NULL, attempts = 0, next_try_at = 0, payload = NULL,
  reply_state = 'none', reply_after = 0, reply_attempts = 0, ticker_override = ?, updated_at = ? WHERE tweet_id = ? AND state IN ('rejected', 'failed')`).run(flag === '--allow-taken-ticker' ? 1 : 0, now(), id)
console.log(r.changes ? `requeued ${id} ($${m.symbol}${m.for_handle ? ` for @${m.for_handle}` : ''})${flag === '--allow-taken-ticker' ? ', allowed past the 24 h cashtag rule' : ''}` : 'nothing changed')
