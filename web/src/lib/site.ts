/** The bot people tag. Set per deployment (VITE_X_HANDLE). */
export const X_HANDLE: string = import.meta.env.VITE_X_HANDLE || 'UseCashtags'
export const SITE = 'cashtags.family'
/** How an account is written: `@handle` for an X account, a shortened address for one signed in with a wallet. */
export const at = (handle: string | null | undefined): string => { const h = handle ?? ''; return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `@${h}` : h.length > 12 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h }
/** True for an X handle (a wallet account's "handle" is its address). */
export const isXHandle = (handle: string | null | undefined) => /^[A-Za-z0-9_]{1,15}$/.test(handle ?? '')
/** A ready-to-post launch tweet on X. */
export const tweetIntent = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`
/** An amount in any asset: SOL, or a paired coin's token (big token amounts drop their decimals). */
export const amt = (n: number, unit: string, digits = 4) => `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : digits })} ${unit}`
export const sol = (n: number, digits = 4) => `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: digits })} SOL`
