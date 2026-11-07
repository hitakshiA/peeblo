-- A message is claimed once per app: each teammate's app decides for itself whether it was addressed (its own
-- mention, its own DM, or a thread it is in), and the claim drops Slack's retries and the message + app_mention
-- pair it sends for one mention.
ALTER TABLE slack_claims DROP CONSTRAINT IF EXISTS slack_claims_pkey;
ALTER TABLE slack_claims ADD PRIMARY KEY (team_id, channel, ts, app_id);
