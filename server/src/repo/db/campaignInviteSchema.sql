-- Campaign invitations: single-use role grants redeemed into a real principal
-- and campaign membership. Only a SHA-256 digest of the bearer token is stored;
-- the raw token is returned once at creation and never persisted.
CREATE TABLE campaign_invites_v1 (
      invite_id TEXT PRIMARY KEY
        CHECK(length(invite_id) BETWEEN 1 AND 128 AND invite_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL
        CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      role TEXT NOT NULL CHECK(role IN ('gm','player','observer')),
      token_digest TEXT NOT NULL UNIQUE
        CHECK(length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
      created_by_principal_id TEXT NOT NULL
        CHECK(length(created_by_principal_id) BETWEEN 1 AND 128 AND created_by_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL
        CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
      ),
      expires_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL
        AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
        AND expires_at > created_at
      ),
      redeemed_at TEXT CHECK(
        redeemed_at IS NULL
        OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', redeemed_at) IS NOT NULL
          AND redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ', redeemed_at)
        )
      ),
      redeemed_principal_id TEXT
        CHECK(
          redeemed_principal_id IS NULL
          OR (
            length(redeemed_principal_id) BETWEEN 1 AND 128
            AND redeemed_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          )
        ),
      UNIQUE(campaign_id, idempotency_key),
      CHECK((redeemed_at IS NULL) = (redeemed_principal_id IS NULL)),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
      FOREIGN KEY(redeemed_principal_id) REFERENCES principals(id) ON DELETE RESTRICT
    );
CREATE INDEX campaign_invites_v1_campaign ON campaign_invites_v1(campaign_id, created_at);
CREATE INDEX campaign_invites_v1_redeemed_principal
      ON campaign_invites_v1(redeemed_principal_id) WHERE redeemed_principal_id IS NOT NULL;
