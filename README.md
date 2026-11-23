# Koryuu — Cloudflare Discord relationship bot

Koryuu is a Groq-powered Discord bot backed by Cloudflare D1. The Worker owns database access, authorization, Discord interactions, and media access. R2-backed media is temporarily disabled; image uploads and retrieval are unavailable, while other bot features continue to work. A small Discord Gateway companion runs on an always-on host to receive DMs and explicit @Koryuu mentions; it calls the Worker through a signed, replay-protected API.

Koryuu can also inspect live server resources and prepare approved server changes and reusable automations. Discord mutations and automation-rule changes are previewed and require confirmation from Lilith's configured Discord ID.

## What it does

- Chats with any Discord user in DMs and when mentioned in a server. It does not answer every server message.
- When mentioned in a server channel, receives up to 12 recent messages from that same channel for short-term context. Separately, after posting an archive notice in the configured server's system channel, the Gateway archives new messages from that server's channels and threads, including private channels. It synchronizes edits and deletions and does not backfill older messages. If immediate channel history cannot be read, Koryuu will say so rather than claim she has it.
- Can send one short, explicitly requested direct message to the caller or one person they mention, including when asked to “DM me.” For another person, Koryuu requires an explicit mention; the DM is sent by Koryuu, not impersonating the caller, and the reply in a server channel is kept private. She can also post one requested message in the current server channel to an explicitly mentioned member, subject to live membership and channel-permission checks.
- Members with Moderator role ID `1568982117176713398` can ask Koryuu to DM a group of explicitly mentioned members or all current human members by using `@everyone`. These are separate individual DMs, not a Discord group chat; bots and the requesting moderator are excluded from `@everyone`. Campaigns are queued, paced, and stop if the requester loses the Moderator role.
- Keeps a per-Discord-user sliding **5-minute** short-term conversation history, shared between DMs and server mentions and capped to the latest 20 messages sent to Groq. Each interaction refreshes that user's expiry. A turn is saved only after a successful model response; identities are keyed by Discord user ID, not username. Members who first mention Koryuu in the configured server are assigned the no-permission `client-koryuu` role and enrolled in persistent private chat memory. The shared logical quota is 150 MB, divided equally among enrolled members; when enrollment changes, the oldest turns are evicted as needed. Members can search only their own persistent memory.
- Keeps a rolling archive of up to 150 MB of message content and metadata for the configured server, evicting the oldest messages across channels when full. The 300 MB combined logical quota leaves about 200 MB under D1 Free's 500 MB per-database limit for other bot data and physical overhead. Archive queries are limited to the current channel; DMs are not archived. These logical byte caps are estimates, not exact limits on physical D1 usage, which also includes indexes and database overhead.
- Recognizes Lilith as Koryuu's creator only when the authenticated Discord user ID matches `LILITH_USER_ID`; chat claims cannot set identity. Asterion's private relationship context remains ID-gated and separate.
- Replies to Asterion as **“honorable bastard.”** Asterion's identity, relationship data, collections, and profile are selected by configured Discord user ID, not display name.
- Uses `general_kn` as shared factual context. It retrieves from `relationship_kn`, Asterion's private memories, status, statistics, collection, and active trait only after verifying Asterion's ID. In server channels, ordinary replies stay in the channel without a routing question. If an answer needs Asterion's private context, Koryuu asks whether he wants it here or in a DM, then follows his choice; private context is not included in the answer before he chooses.
- Implements `/koryuu`, `/linked-role`, `/afk` (five preset statuses or a custom status, saved per server and user; Koryuu reports an AFK member's status when mentioned and clears a sender's AFK status after their next server message, notifying them privately), `/memory list` and staged `/memory add`, `/shop`, `/balance`, staged `/rp award` and `/rp deduct`, `/dprint`, `/dprint_r`, `/dprint_c`, `/dprint_a`, `/collection`, `/buy`, and private `/admin authenticate` and `/admin logout`.
- Supports catalog categories `memories`, `pins`, `traits`, `tokens`, `letters`, `portraits`, and `titles`; tokens have `date`, `food`, `visual`, and `creative` subtypes.
- Stages shop purchases and administrator changes with a private preview and a separate Confirm/Cancel action. A purchase atomically deducts RP, records the purchase, marks the listing sold, updates the collection, and increments token inventory if applicable.
- R2-backed picture uploads and retrieval are temporarily unavailable. Shop and collection text features continue to work without images.
- Supports administrator-managed knowledge, memories, shop items, Asterion profile, RP ledger, missions, milestones, achievements, and temporary traits.
- Reads current server roles and permissions, channels and permission overwrites, members and role assignments, and Koryuu's own permissions and role hierarchy.
- Previews role/channel creation, editing permissions, deletion, overwrites, member-role changes, kicks, bans, and timeouts; checks bot permissions and role hierarchy again before applying a confirmed change.
- Creates team records with a no-permissions team role, a private team channel, a leader, and initial members after owner confirmation; member assignments are audited in D1.
- Stores configurable `shop.purchase` and `member.join` automation rules with conditions and allowlisted actions. Purchases made in a server generate generic events; rule-specific rewards are stored as data, not hardcoded in the application.
- Supports temporary role grants with D1-backed expiration, rule enable/disable/update/archive, idempotent event processing, and execution history.
- Accepts natural-language service, commission, complaint, suggestion, information, application, access, team, verification, and discount requests; saves private records, forwards new requests to the owner, and tracks review status/outcomes.
- For a server complaint, members can mention the involved person(s) instead of typing Discord IDs. Koryuu resolves each mention against the live server member list and stores the verified IDs; complaint details are still forwarded privately.
- Rotates every Groq request atomically through eight API-key slots (`GROQ_API_KEY` and `GROQ_API_KEY_2` through `_8`) using D1, so concurrent conversations are assigned successive keys with no fixed primary key. If a key is unauthorized or rate-limited, Koryuu tries the next configured key; missing slots are skipped.
- Supports native Discord Linked Roles OAuth: members who authorize account linking receive `linked=1` role metadata, and Discord applies a server-configured linked role.
- On a member join, checks for role `1566823723305271428` (`100% Organic`) and sends one onboarding DM if it is absent; onboarding does not enroll the member in reminders. The instructions include [the onboarding GIF](https://imgflip.com/gif/b5dv6n), and `/linked-role` displays them on demand. Members may separately opt in to a private 20-minute reminder with `/linked-role reminders:true`, or opt out with `/linked-role reminders:false`. The scheduled reminder checks the member's current role before each DM and stops when the role is obtained or the member leaves. Reminder delivery failures are logged and retried at the next interval only for subscribers.
- A current member with Moderator role ID `1568982117176713398` may run `/verification_reminder` in the configured server to start a one-time campaign. Koryuu scans current human members, excludes anyone with `100% Organic`, rechecks eligibility before delivery, and queues at most one DM per member for that campaign. The worker sends at a controlled pace, records delivery history, and uses varied verification wording; each DM includes the previous campaign send time (or says none), the current send time, and an embedded preview of the [verification GIF](https://imgflip.com/gif/b5dv6n). A second invocation cannot duplicate an active campaign.
- Queues approved Minecraft applications in D1 for a separate whitelist worker; Koryuu does not connect to the Minecraft server.
- Prunes expired conversations and pending actions and processes automation events and temporary effects every minute.

## Architecture and hosting note

```text
Discord slash commands ── signed interactions ──> Cloudflare Worker
                                                     ├─ Discord REST API
                                                     ├─ D1
                                                     └─ Groq Chat Completions API

Discord DMs / @mentions ──> always-on Gateway service ── signed API ──> Worker
Discord member joins / daily activity ──> always-on Gateway ─ signed API ──> Worker
```

**Standard Cloudflare Workers cannot maintain the persistent Discord Gateway connection required for ordinary DMs and message mentions.** Host `src/gateway.ts` as a small always-on Node.js service (for example, on a VPS or another Node host). Cloudflare still hosts the Worker and D1. If you choose a Workers-only deployment, you must give up the Gateway message flow and use Discord interactions only.

## D1 schema

The initial migration creates:

- `general_kn`, `relationship_kn`, and `memories`
- `status_astri`
- `shop_storage` and `astri_collection`
- Category tables: `memory_collectibles`, `pins`, `traits`, `tokens`, `letters`, `portraits`, and `titles`
- Separate `date_tokens`, `food_tokens`, `visual_tokens`, and `creative_tokens`
- RP wallets and ledger, purchases, missions/completions, milestones, achievements/awards, media metadata, audit logs, admin sessions, pending actions, chat history, and rate-limit/replay records
- Approved server-change proposals and automation-rule proposals
- `automation_rules`, durable/deduplicated `automation_events`, `automation_runs`, and `temporary_effects`
- `community_requests` and `community_request_events` for private intake, review, assignment, and outcomes
- `community_teams`, `community_team_members`, and `community_team_events` for team rosters and audit history
- `community_member_activity_days` for privacy-minimized recruitment eligibility evidence
- `minecraft_whitelist_queue` for approved Minecraft requests handed off to an external worker
- `linked_role_oauth_states` and `linked_role_events` for one-time Discord OAuth state and audit records; OAuth access tokens are never persisted
- `linked_role_onboarding` for deduplicated onboarding, reminder schedule, delivery history, and role-completion state per member and server
- `client_memory_members` and `client_memory_messages` for enrolled members' quota-managed private chat histories
- `server_message_archive`, `server_archive_usage`, and `server_archive_notice_state` for the configured guild's rolling message archive, storage accounting, and capture notice
- `afk_statuses` for each member's current AFK status per server

Pins and portraits require image storage and cannot be added while media storage is disabled. Trait items require a configured duration (up to seven days) and can be activated by an administrator; the active mode is included only in Asterion's context. Legacy shop items are imported as `memories`, because the old SQLite schema did not store their categories.

## Requirements

- Node.js 22.13 or newer (the optional SQLite importer uses `node:sqlite`)
- A Cloudflare account with Workers and D1 enabled
- A Discord application and bot, including the privileged **Message Content Intent** for DMs and mentions and **Server Members Intent** for member listing and join events
- A Groq API key
- An always-on Node.js host for the Gateway companion

The Worker uses Groq's OpenAI-compatible Chat Completions endpoint with `openai/gpt-oss-120b` by default. Override the model with `GROQ_MODEL` in `wrangler.toml`; keep `GROQ_API_KEY` only in Worker secrets or local `.dev.vars`. Temporary provider errors and rate limits receive up to three bounded retries, honoring `Retry-After` when supplied.

## Cloudflare setup

1. Install dependencies and sign in:

   ```powershell
   npm install
   npx wrangler login
   ```

2. Create the D1 database:

   ```powershell
   npx wrangler d1 create koryuu
   ```

3. Copy the D1 `database_id` from Wrangler's output into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Set `LILITH_USER_ID`, `ASTERION_USER_ID`, `WORKER_PUBLIC_URL` (the public Worker origin), and your Discord application's public key in `[vars]`.

4. Apply the D1 migration:

   ```powershell
   npx wrangler d1 migrations apply koryuu --remote
   ```

5. Add Worker secrets. `GATEWAY_SHARED_SECRET` must be at least 32 characters of random data and also configured on the Gateway host. Generate a value with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Store the SHA-256 **hex digest** of your admin password as `ADMIN_PASSWORD_SHA256`; never use or send the raw password in a Discord message. On Windows, generate its digest with:

   ```powershell
   .\scripts\hash-admin-password.ps1
   ```

   Enter the digest (not the raw password) when Wrangler prompts for `ADMIN_PASSWORD_SHA256`:

   ```powershell
   npx wrangler secret put GROQ_API_KEY
   npx wrangler secret put GROQ_API_KEY_2
   npx wrangler secret put GROQ_API_KEY_3
   npx wrangler secret put GROQ_API_KEY_4
   npx wrangler secret put GROQ_API_KEY_5
   npx wrangler secret put GROQ_API_KEY_6
   npx wrangler secret put GROQ_API_KEY_7
   npx wrangler secret put GROQ_API_KEY_8
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put GATEWAY_SHARED_SECRET
   npx wrangler secret put ADMIN_PASSWORD_SHA256
   ```

6. Deploy the Worker:

   ```powershell
   npm run deploy
   ```

   Check `https://<your-worker-domain>/health`.

7. In Discord Developer Portal, configure **Interactions Endpoint URL** as `https://<your-worker-domain>/discord/interactions`. Set the application's public key in `wrangler.toml`. To have Discord request the full server permission set when installing, use this authorization URL, replacing the client ID:

   ```text
   https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&permissions=8&integration_type=0&scope=bot+applications.commands
   ```

   Permission `8` is Discord's **Administrator** permission. The server owner must review and approve that prompt; a bot cannot grant itself permissions. Enable Message Content Intent and Server Members Intent for the Gateway service. Some Discord capabilities additionally require their privileged intents, scopes, or provider-specific setup, and Discord still enforces role hierarchy and platform restrictions.

## Gateway companion setup

On the always-on Node host, deploy this project, install dependencies, and configure these environment variables (see `.env.example`):

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`
- `LILITH_USER_ID`, `ASTERION_USER_ID`
- `WORKER_API_URL` (the deployed Worker URL)
- `GATEWAY_SHARED_SECRET` (the same value stored as a Worker secret)
- Optional `DISCORD_GUILD_ID` for quicker command registration during development

Set `DISCORD_GUILD_ID` to the server whose messages should be archived; it must match `ARCHIVE_GUILD_ID` in `wrangler.toml`. The Gateway needs permission to view/read message history for the channels to archive and permission to post in the server's system channel. It will post the capture notice there before storing messages. Archive capture begins with new Gateway events after deployment; messages sent earlier are not backfilled. The bot also needs Manage Roles and a role position above `client-koryuu` to enroll members.

Then register commands and start the Gateway service:

```powershell
npm run register
npm run start:gateway
```

The Gateway service needs Discord Message Content Intent to read DMs and mentions. Keep the bot token and shared secret private. Do not expose the shared secret in client-side code.

After adding or updating bot commands, run `npm run register` from the Gateway host so `/linked-role` becomes available.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in Worker-only secrets. Create `.env` for Gateway variables. These files are ignored by Git. Run `npm run dev` for Wrangler and `npm run dev:gateway` in a second terminal. A local Worker URL is not reachable by Discord; use a secure tunnel or test against a deployed Worker.

### Automatic deployment to an Oracle Cloud VM

The GitHub Actions workflow in `.github/workflows/deploy.yml` runs type-checks and tests for pull requests and pushes to `main`. After a successful push to `main`, it applies pending D1 migrations, deploys the Cloudflare Worker, then uploads and starts the Gateway on your VM. If your production branch is named `master` or something else, update the branch names in the `pull_request`, `push`, and deploy-condition sections of the workflow.

The VM must be running Ubuntu with Node.js 22.13 or newer, npm, OpenSSH, and systemd. The following setup is done once on the VM. Do not put `.env`, Discord tokens, or the shared secret in GitHub or in the release archive.

1. Install Node.js 22.13+ and create the service and deployment accounts:

   ```bash
   sudo apt update
   sudo apt install -y curl openssh-server
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   node --version
   sudo useradd --system --home-dir /opt/koryuu --create-home --shell /usr/sbin/nologin koryuu
   sudo useradd --create-home --shell /bin/bash deploy
   sudo install -d -o koryuu -g koryuu /opt/koryuu/releases
   ```

   `node --version` must report at least `v22.13.0`. In the Oracle Cloud network security rules, allow inbound TCP port 22 from the IP ranges you need for SSH. GitHub-hosted runner IPs change, so do not treat an unrestricted SSH rule as ideal; for tighter network access, use a self-hosted runner or a private network.

2. Make an SSH key pair for GitHub Actions on your own computer:

   ```bash
   ssh-keygen -t ed25519 -C github-actions-koryuu
   ```

   On the VM, create `/home/deploy/.ssh` with owner `deploy:deploy` and mode `700`, add the **public** key to `/home/deploy/.ssh/authorized_keys`, then set that file's owner to `deploy:deploy` and mode to `600`. Save the **private** key for the `ORACLE_VM_SSH_KEY` GitHub secret; do not copy it to the VM.

   Pin the VM's SSH host key rather than accepting an unknown key in the workflow. On the VM, get the Ed25519 host-key fingerprint with `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. On your computer, obtain the `ssh-keyscan -H <exact-hostname-or-IP-used-as-ORACLE_VM_HOST>` output and verify its fingerprint matches before saving that output as the `ORACLE_VM_KNOWN_HOSTS` secret.

3. Install the deployment script and service unit from your local project checkout. For example, from PowerShell, replacing `<VM-public-IP>`:

   ```powershell
   scp .\deploy\oracle-vm-deploy.sh .\deploy\koryuu-gateway.service deploy@<VM-public-IP>:/tmp/
   ssh deploy@<VM-public-IP> "sudo install -o root -g root -m 0755 /tmp/oracle-vm-deploy.sh /usr/local/sbin/koryuu-deploy && sudo install -o root -g root -m 0644 /tmp/koryuu-gateway.service /etc/systemd/system/koryuu-gateway.service && echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/koryuu-deploy' | sudo tee /etc/sudoers.d/koryuu-deploy >/dev/null && sudo chmod 0440 /etc/sudoers.d/koryuu-deploy && sudo visudo -cf /etc/sudoers.d/koryuu-deploy && sudo systemctl daemon-reload && sudo systemctl enable koryuu-gateway.service"
   ```

   The deploy user's sudo permission is limited to the deployment script. The script installs dependencies into a new commit-specific release, switches the `current` symlink, restarts the service, and restores the previous release if the service fails to start.

4. Create `/etc/koryuu-gateway.env` on the VM, readable only by root, with the Gateway values from `.env.example`:

   ```bash
   sudo install -o root -g root -m 0600 /dev/null /etc/koryuu-gateway.env
   sudo nano /etc/koryuu-gateway.env
   ```

   Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `LILITH_USER_ID`, `ASTERION_USER_ID`, `WORKER_API_URL` (the **public deployed Worker URL**, not `127.0.0.1`), and `GATEWAY_SHARED_SECRET`. Set `DISCORD_GUILD_ID` if this Gateway should archive a particular server; it must match `ARCHIVE_GUILD_ID` in `wrangler.toml`. Store the same `GATEWAY_SHARED_SECRET` as a Cloudflare Worker secret. Keep this file private.

5. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret** and add:

   | Secret | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Cloudflare API token permitted to deploy this Worker and apply D1 migrations |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID containing the Worker and D1 database |
   | `ORACLE_VM_HOST` | VM public IP address or SSH hostname |
   | `ORACLE_VM_USER` | `deploy` |
   | `ORACLE_VM_SSH_KEY` | Private half of the SSH key pair from step 2 |
   | `ORACLE_VM_KNOWN_HOSTS` | Verified host-key line(s) from step 2 |

   The Cloudflare token should have the minimum Workers and D1 permissions needed for this account. The workflow never needs your Discord bot token: the Gateway reads it from `/etc/koryuu-gateway.env`, and the Worker reads its secrets from Cloudflare.

6. Push a commit to `main`. In GitHub, open **Actions → Test and deploy** to see each step and its logs. Verify that `koryuu-gateway.service` is active on the VM with `sudo systemctl status koryuu-gateway` and inspect logs with `sudo journalctl -u koryuu-gateway -f`. A failed test prevents deployment; a failed Gateway restart restores its previous release. Cloudflare deployment happens before the VM deployment, so a VM/SSH failure does not roll back a successful Worker deployment.

The first successful deployment starts the Gateway service. After that, each successful push to `main` automatically updates it; no terminal needs to poll GitHub or remain open.

### Discord Linked Roles verification

The Linked Roles flow uses native Discord OAuth with `identify role_connections.write`. Set the Worker `DISCORD_CLIENT_SECRET` secret, set `WORKER_PUBLIC_URL` to the public Worker origin, and add `https://<worker-domain>/discord/linked-role/callback` as an OAuth2 redirect URI in the Developer Portal. Set the application's **Linked Roles Verification URL** to `https://<worker-domain>/discord/linked-role`. Copy `.dev.vars.example` to `.dev.vars` for local work and fill `DISCORD_CLIENT_SECRET` and `WORKER_PUBLIC_URL` there.

Register the metadata schema once from the Gateway host, where `.env` contains `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`:

```powershell
npm run register:linked-role
```

In the Discord server, create the `100% Organic` role and configure its Linked Roles requirement to use Koryuu's **Discord account linked** metadata equal to `1`. Any member who authorizes the Discord OAuth link qualifies; Discord itself applies/removes the linked role based on that configured requirement. Koryuu does not store OAuth tokens. See [Discord's Linked Roles setup guide](https://docs.discord.com/developers/tutorials/configuring-app-metadata-for-linked-roles).

On join, the Gateway reports the event to the Worker. The Worker checks the member's current roles before attempting a one-time onboarding DM and claims the `(guild_id, member_id)` record to prevent duplicate delivery. This onboarding does not subscribe anyone to recurring reminders. Members in the configured server can independently opt in or out with `/linked-role reminders:true` or `/linked-role reminders:false`. The scheduled Worker checks only subscribed members' current roles, sends reminders every 20 minutes while they remain unverified, and stops when the role is detected or the member leaves. Failed deliveries remain subscribed and are retried after the next interval. `/linked-role` remains available for on-demand instructions. Apply migrations before deploying; the opted-in reminder schedule continues independently of the Gateway.

For a one-time server-wide reminder campaign, a current member assigned role ID `1568982117176713398` can run `/verification_reminder` in the configured server. The Worker verifies the caller's role from Discord, scans the current member list in pages, excludes bots and members with role `1566823723305271428`, and queues one message per remaining member. A scheduled Worker rechecks membership and role status before delivery, processes recipients at a controlled pace, records send history, and marks the campaign complete. Each DM contains the last campaign delivery time for that member (or notes that no prior reminder exists) and the current send time. Only one campaign per server can be active at once; a later command starts a new one-time campaign after completion.

## Server authority and automations

Ask Koryuu in the target server (for example, by mentioning her) to inspect or change server configuration. Read-only tools discover current role IDs/permissions, channels/overwrites, member roles, and the bot's effective permissions and hierarchy. Koryuu does not guess missing resources. A server change is stored as a short-lived proposal and is applied only after Lilith's configured Discord ID confirms it; the Worker revalidates the target and bot permissions immediately before calling Discord.

The current Discord action allowlist includes role and channel creation/deletion, role permissions, channel overwrites, member-role assignment, team workflows, kicks, bans, and communication timeouts. Every mutation requires owner confirmation. Deletions and moderation are destructive and their previews state the target and effect. This is not a guarantee of every Discord client capability: Discord may require a particular API permission, privileged intent, OAuth scope, eligible target/hierarchy, or an external provider, and some client-only/account-owner functions are not exposed to bots. Never grant permissions beyond what you intend to delegate.

Automation rules are likewise previewed and confirmed before saving. Supported triggers are:

- `shop.purchase` — emitted transactionally for a purchase made in a server; rules can match purchase fields such as `unique_id`, buyer ID, or price.
- `member.join` — sent by the Gateway companion when a member joins.

Conditions use approved event fields with equality, inequality, contains, or numeric comparisons. Allowlisted actions can add/remove a role or send a channel message. An `add_role` action may specify `duration_minutes` from 1 to 10080; expiration is stored in D1 and processed by the scheduled Worker. Message templates may use `{{member_id}}`, `{{username}}`, `{{display_name}}`, `{{unique_id}}`, `{{item_title}}`, and `{{price_paid}}`. Mentions in automation-generated messages are disabled.

Use the live inspection tools before proposing a rule, and use Koryuu's automation tools to list rules and recent runs or stage create/update/enable/disable/archive changes. Role actions require Manage Roles and a target role below Koryuu's highest role; message actions require View Channel and Send Messages. Guild-scoped purchase events require a purchase initiated in that guild; purchases made in DMs have no guild context and do not enter guild automations.

The Gateway needs the **Server Members Intent** enabled in the Discord Developer Portal for member-list reads and join events. It reports one record per member, guild, and UTC date when it observes a message; message text is not stored, and activity records are deleted after 90 days. Configure `DISCORD_BOT_TOKEN` as a Worker secret so the Worker can inspect and manage Discord resources; do not expose it to Groq or users. Apply all numbered D1 migrations before deploying.

Members can submit or check their own requests through natural language. New submissions are routed to the configured owner and privately forwarded by Discord DM; if delivery fails, the request remains recorded and the response explicitly reports the failed notification. Reviewers with the application's existing admin access can list the review queue and record status, assignment, and outcome. This shared request foundation records applications but does not itself approve service work, grant access, or integrate external providers. Category-specific eligibility and execution flows are added by their respective modules.

For an approved personal-channel application, Lilith can ask Koryuu to stage channel provisioning by request ID. The preview is private and requires a separate owner confirmation. Before creation, Koryuu rechecks the approved request, its applicant and gathered partners, member existence, channel-name availability, and Manage Channels permission. The resulting text channel denies `View Channel` to `@everyone` and grants explicit access only to the applicant, listed partners, and Koryuu. On success, the request moves to `in_progress` and records the channel ID; Discord server administrators can still bypass channel overwrites.

Lilith can ask Koryuu to list, create, update, and archive teams. Creation, adding/removing members, changing the leader, and archiving each require a private preview and confirmation. A new team gets a role with no Discord permissions, a private text channel visible to that role, and a D1 roster/audit record. A linked team application must already be approved and match its applicant and listed members. Updating a roster changes the corresponding Discord role; changing leaders retains the previous leader as a member. Archiving removes the team role from active members while retaining the role, channel, and history for audit.

Staff applications collect experience, motivation, intended responsibilities, and a self-reported activity summary. The Gateway stores only whether it observed a member send at least one message on a UTC date, never the message contents; approving a staff application is blocked until at least three dates are observed within the 90-day retention window. That is a minimum presence check, not an automated judgment that activity was meaningful. The owner/reviewer must assess that qualitatively. Development applications collect skills and contributions; supporter and investor proposals require a contribution description.

When an authorized reviewer approves a Minecraft access application, Koryuu transactionally adds it to `minecraft_whitelist_queue` with the applicant's Discord ID, Minecraft username, partner IDs, and request ID. The other worker can claim `queued` rows by atomically changing them to `processing`, then set `completed` or `failed`, `worker_result`, and `updated_at`. Declining an unclaimed queued request marks it `cancelled`. Koryuu does not connect to a Minecraft server or send server credentials.

Discount requests must include a service/rank, contribution history, and requested percentage from 10% to 35%. Only the configured owner can record an approved percentage or decline; the applicant is notified and every decision is retained. A decision is an offer record only: no checkout, payment, or shop pricing integration is configured, so discounts are not automatically applied to purchases.

## Administrator workflow

- Lilith's configured Discord user ID is an administrator. A password is an optional additional path.
- Other administrators must use `/admin authenticate` in the server where they want the ticket; Discord opens a private modal. On success, the Worker stores a 15-minute session, assigns a no-permissions `creator15` marker role, and creates a private channel for that member and Koryuu. Discord server administrators can still bypass channel visibility overwrites. The bot needs Manage Roles and Manage Channels, and its highest role must be above the temporary marker role. The Worker removes the role and channel at logout or shortly after expiry (cleanup runs every minute). The role itself grants no Discord permissions.
- In the private ticket or a **DM**, ask Koryuu to make a supported change. The Worker session—not the Discord role or model—authorizes each action. Koryuu shows a private preview and Confirm/Cancel buttons. Confirming rechecks authorization and applies only a validated, allowlisted action. Pending changes expire after two minutes. Admin sessions and ticket cleanup are enforced by the Worker; the scheduled cleanup runs every minute.
- Set `DISCORD_BOT_TOKEN` as a Cloudflare Worker secret for ticket provisioning. Never give `creator15` Discord Administrator permissions; that would bypass Koryuu's application safeguards.
- The AI cannot run SQL, shell commands, JavaScript, or arbitrary updates. The raw `/admin password` message trigger is intentionally not supported.
- Changes are written to `system_logs`. Purchases and RP changes are reflected in the ledger.

## Optional import from the old SQLite starter

Back up the existing `data/koryuu.sqlite` first. The importer opens the source read-only and writes a reviewable SQL file; it does not alter the original database. Generate the file in the ignored `data/` directory:

```powershell
npm run import:sqlite -- "data\koryuu.sqlite" "data\legacy.import.sql"
```

Review the generated file, then apply it **once** to the migrated D1 database:

```powershell
npx wrangler d1 execute koryuu --remote --file="data\legacy.import.sql"
```

The legacy schema did not distinguish catalog categories or media. Existing shop products are imported as memory-category items; historical purchases, balances, ledger rows, memories, and logs are retained. The generated import contains private records: do not commit or share it.

## Data and privacy notes

- Groq receives a user's message and relevant saved context. Relationship context is fetched only for Asterion's configured Discord ID. Review Groq's data policies before storing sensitive personal content.
- Conversation history is keyed by Discord user ID, expires after ten minutes of inactivity, and is capped to the latest 20 messages sent to Groq. It is not keyed by a username, which may change or collide.
- Media storage is currently disabled. Existing media metadata remains in D1, but media cannot be uploaded or retrieved until storage is re-enabled.
- Use a private test server first. Back up D1 according to your needs.

## Verification

```powershell
npm run typecheck
npm test
```

The tests cover relationship-data authorization, chat-history isolation/expiry, atomic purchases and token inventory, staged changes, live Discord permission checks, automation proposals and execution, temporary-effect expiry, private media access, Discord signature validation, and Gateway request replay protection.
