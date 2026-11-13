import { X_HANDLE } from '../lib/site'

export function Terms() {
  return (
    <div className="page legal">
      <h1>Terms</h1>
      <p className="muted">Cashtags launches Pumpfun coins on Solana when an X account asks it to by tagging @{X_HANDLE}. The account that posts is the creator of that coin, and is responsible for what it launches and how it is promoted.</p>
      <p className="muted">Cashtags does not issue, sell, endorse or vouch for any coin. Coins can lose all of their value. Nothing on this site is financial advice.</p>
      <p className="muted">Creator rewards are collected from Pumpfun and paid to the creator, or airdropped to holders when the creator chooses that, as described in How it works. Cashtags may refuse or delay launches to protect the service, for example from spam, abuse or impersonation.</p>
      <p className="muted">The service is provided as is. Blockchain transactions cannot be reversed: check every address before you use it.</p>
    </div>
  )
}

export function Privacy() {
  return (
    <div className="page legal">
      <h1>Privacy</h1>
      <p className="muted">When you tag @{X_HANDLE}, Cashtags reads the public post and your public profile (handle, name, picture, follower count, account age) to launch the coin and apply its limits.</p>
      <p className="muted">Signing in with X reads your public profile only. Cashtags stores your X id, the payout settings you choose and a sign-in cookie. It never posts for you.</p>
      <p className="muted">Payout addresses and payouts are public on the Solana blockchain. Cashtags does not sell data.</p>
    </div>
  )
}
