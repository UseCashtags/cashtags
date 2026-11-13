/**
 * By-hand fallback: takes one X post (by id) in exactly as a mention would be, so the running bot launches and answers
 * it. For the operator's own "@UseCashtags launch $CASHTAG" if neither the mention search nor the reply watch saw it.
 *   on the server, with the api's env loaded:  node api/platform-ingest.mjs <post id>
 * Prints what the queue row looks like. Sends nothing on chain itself.
 */
import { join } from 'node:path'
import { openDb } from './db.mjs'
import { createBot } from './bot.mjs'
import { guardConfig } from './guards.mjs'
import { TwitterApiIo } from './x.mjs'

const id = String(process.argv[2] ?? '').match(/(\d{5,25})/)?.[1]
if (!id) { console.error('usage: node api/platform-ingest.mjs <post id or link>'); process.exit(1) }
const env = process.env
const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? '/var/lib/cashtags', 'cashtags.db'))
const x = new TwitterApiIo({ apiKey: env.TWITTERAPI_IO_KEY, handle: env.X_HANDLE ?? 'UseCashtags' })
const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig(env), env, publicUrl: env.PUBLIC_URL ?? 'https://cashtags.family' })
const r = await bot.ingestTweetId(id)
console.log(JSON.stringify(r))
if (r.row?.platform === 1 && r.row.state === 'queued') console.log('queued as the platform launch: the bot launches it within seconds and replies')
else if (r.row) console.log(`not a platform launch (state ${r.row.state}${r.row.code ? `, ${r.row.code}` : ''})`)
process.exit(0)
