# AI Fantasy Manager

Autonomous ESPN fantasy football manager: sets lineups, submits waiver claims,
scans for trades, and negotiates them over iMessage in your own texting voice.
Brain runs on AWS (Lambda + Bedrock Claude). A small agent on your Mac bridges
iMessage.

**Everything starts in DRY_RUN.** Nothing is submitted to ESPN or sent over
iMessage until you set `DRY_RUN=0`.

## Layout

```
packages/core       ESPN client, valuation, lineup/waiver/trade brains, voice, guardrails, store
packages/mac-agent  runs on the Mac: reads chat.db, sends iMessages, exports your texts
packages/lambdas    thin AWS handlers
packages/infra      CDK stack (Lambdas, schedules, DynamoDB, SQS, S3, Secrets, alarms)
config/             league.json (you create), rules.json (guardrail thresholds)
```

## Setup (local, dry run)

1. `npm install`
2. `cp config/league.example.json config/league.json` and fill in league id, season,
   your team id, and each team id → name + phone. Mark yourself with `"self": true`.
3. `cp .env.example .env`. Add `ESPN_S2` and `ESPN_SWID` (browser DevTools →
   Application → Cookies on fantasy.espn.com) and `ANTHROPIC_API_KEY` for local runs.
4. Smoke test the ESPN read path:

```bash
npm run espn:smoke
```

5. Dry-run the jobs (they log what they *would* do):

```bash
npm run lineup
npm run waivers
npm run trades
```

## Voice profile (on the Mac)

1. System Settings → Privacy & Security → Full Disk Access → add your terminal (or `node`).
2. Export your own texts (anonymized, stays local):

```bash
npm run export -w @ffm/mac-agent
```

3. Review `data/messages-export.json`, then build the profile and see sample drafts:

```bash
npm run voice:build
```

4. Blind test: mix 10 sample drafts with 10 real texts. If you can tell them apart,
   edit `data/voice-profile.json` (lexicon / avoid lists) and rerun the drafts.
   Upload when happy: `aws s3 cp data/voice-profile.json s3://<ProfileBucketName>/`.

## Deploy to AWS

```bash
aws login
```

Enable Claude model access in Bedrock (us-east-1) once in the console, then:

```bash
npx cdk bootstrap && npm run cdk -- deploy --require-approval never
```

Then:

- Put cookies in the secret: `aws secretsmanager put-secret-value --secret-id ffm/secrets --secret-string '{"ESPN_S2":"…","ESPN_SWID":"{…}","INBOUND_API_SECRET":"<keep the generated one>"}'`
  (read the generated `INBOUND_API_SECRET` first with `aws secretsmanager get-secret-value --secret-id ffm/secrets`).
- Copy the stack outputs into `.env` on the Mac: `INBOUND_API_URL`, `INBOUND_API_SECRET`,
  `OUTBOUND_QUEUE_URL`, and the Mac agent access key as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
- Start the Mac agent (System Settings → Privacy & Security → Automation → allow it to control Messages when prompted):

```bash
npm run mac-agent
```

  Install as a launchd service using the commands in `packages/mac-agent/launchd.plist`.
  Keep the Mac awake: System Settings → Energy → prevent sleep, or `caffeinate -dims`.

## Going live, in order

1. `DRY_RUN=0` for the Mac agent only, with only your own number in `league.json`. Confirm the daily summary text arrives at 9am.
2. Set `DRY_RUN=0` on the `ffm-lineup` Lambda after comparing one dry-run payload with a real request captured in DevTools (Network → POST …/transactions/).
3. Same for `ffm-waivers` after one dry Tuesday.
4. Add one trusted league mate's number, set `maxOpenTrades: 1` in rules.json, redeploy, and enable `ffm-trade-scan` + `ffm-inbound`.
5. Add everyone else.

Redeploy after any `config/` change (the Lambdas embed it).

## Fairness rules (config/rules.json)

The agent is meant to be an edge, not a scam. These are enforced in code, not just prompted:

- `maxTheirLossPct` 0.15: never propose or counter a deal where the other side loses more than 15% of value by our own model.
- `teamCooldownDays` 7: at most one unsolicited offer per person per week. Replies to people who text first are unlimited.
- `maxTextsPerPersonPerDay` 2 unsolicited texts (offers/nudges) per person per day; near-duplicate texts are suppressed; no texts 11pm–8am.
- Two channels: a texted offer at most once per person per week (`teamCooldownDays` 7), and silent ESPN proposals with no text, up to `maxSilentProposalsPerDay` 2, only when none of ours are pending. Replies to anyone who texts first are unlimited.
- No-offer list: someone who never answers an offer is left alone for `unresponsiveCooldownDays` 21; someone who says no, `declinedCooldownDays` 14.
- `acceptIncomingMinGainPct` 0.20: incoming offers are accepted only above a 20% gain and a clear lineup upgrade; otherwise countered or declined.
- Injured/IR players are never offered as trade pieces.

## Controls

- Text **STOP** to yourself to pause everything; **GO** resumes.
- `config/rules.json`: FAAB cap per week, max drops, max open trades, value-gain floor,
  top-N protected players, texts per person per day, quiet hours, negotiation expiry.
- `untouchables` in `league.json`: ESPN player ids that are never traded or dropped.
- Every action is logged to the `ffm-actions` table and summarized in the 9am text.

## Schedule (America/New_York)

| Job | When |
|---|---|
| waivers | Tue 9:00 pm |
| trade-scan (new offers, nudges, incoming reviews) | daily 10:00 am |
| lineup | Thu 6 pm, Sun 10 am, Sun 3 pm, Mon 6 pm |
| daily-summary | 9:00 am |
| inbound | whenever a league mate texts |

## Tests

```bash
npm test
```

## Known risks

- ESPN's write API is undocumented. If a payload shape changes, writes fail loudly
  (CloudWatch alarm → email) but the season doesn't set itself. Check the alarm email.
- macOS updates can reset Automation permission; the missing daily text is the tell.
- The trade-negotiation texts come from your phone number. Decide whether to tell the league.
