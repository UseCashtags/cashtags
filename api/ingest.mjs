/**
 * Operator: feed ONE post the mention feed missed into the queue (e.g. a reply in a thread where @UseCashtags is only in
 * X's "replying to" prefix: twitterapi.io's /user/mentions leaves those out). Run on the box with the api's env:
 *   node api/ingest.mjs <tweet id>
 * The post goes through exactly the same rules as any mention; the running bot launches it and replies with the CA.
 */
import { join } from 'node:path'
import { openDb } from './db.mjs'
import { createBot } from './bot.mjs'
import { TwitterApiIo } from './x.mjs'
import { guardConfig } from './guards.mjs'

const id = process.argv[2]
if (!/^[0-9]{5,25}$/.test(id ?? '')) { console.error('usage: node api/ingest.mjs <tweet id>'); process.exit(1) }
const env = process.env
const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? './data', 'cashtags.db'))
const x = new TwitterApiIo({ apiKey: env.TWITTERAPI_IO_KEY, handle: env.X_HANDLE ?? 'UseCashtags' })
const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig(env), env, publicUrl: env.PUBLIC_URL ?? 'https://cashtags.family' })
const r = await bot.ingestTweetId(id)
console.log(JSON.stringify(r))
process.exit(0)
