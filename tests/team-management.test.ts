import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmServerChange, listGuildTeams, stageServerChange } from "../src/discord-server.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const BOT_ID = "100000000000000020";
const LEADER_ID = "100000000000000030";
const MEMBER_ID = "100000000000000031";
const NEXT_MEMBER_ID = "100000000000000032";
const BOT_ROLE_ID = "100000000000000050";
const TEAM_ROLE_ID = "100000000000000051";
const CHANNEL_ID = "100000000000000060";

test("team creation provisions a no-permissions role and private channel only after owner confirmation", async () => {
  const { env, database } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let teamRoleCreated = false;
  let teamChannelCreated = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({ path, method, body });
    if (path === "/api/v10/users/@me") return Response.json({ id: BOT_ID });
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: BOT_ROLE_ID, name: "Koryuu", permissions: String((1n << 4n) | (1n << 28n)), position: 10, managed: false, hoist: false, mentionable: false, color: 0 },
        ...(teamRoleCreated
          ? [{ id: TEAM_ROLE_ID, name: "Builders", permissions: "0", position: 1, managed: false, hoist: false, mentionable: false, color: 0 }]
          : [])
      ]);
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      return Response.json(teamChannelCreated
        ? [{ id: CHANNEL_ID, name: "team-builders", type: 0, parent_id: null, permission_overwrites: [] }]
        : []);
    }
    if (method === "GET" && new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/\\d+$`).test(path)) {
      const id = path.split("/").pop();
      return Response.json({
        user: { id, username: "team-member", global_name: null },
        roles: id === BOT_ID ? [BOT_ROLE_ID] : [],
        nick: null
      });
    }
    if (method === "POST" && path === `/api/v10/guilds/${GUILD_ID}/roles`) {
      assert.equal(body?.permissions, "0");
      teamRoleCreated = true;
      return Response.json({
        id: TEAM_ROLE_ID,
        name: body?.name,
        permissions: "0",
        position: 1,
        managed: false,
        hoist: false,
        mentionable: false,
        color: 0
      });
    }
    if (method === "POST" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      teamChannelCreated = true;
      const overwrites = body?.permission_overwrites as Array<{ id: string; deny: string }>;
      assert.equal(overwrites[0].id, GUILD_ID);
      assert.equal(BigInt(overwrites[0].deny) & (1n << 10n), 1n << 10n);
      assert.equal(overwrites[1].id, TEAM_ROLE_ID);
      return Response.json({
        id: CHANNEL_ID,
        name: body?.name,
        type: 0,
        parent_id: null,
        permission_overwrites: []
      });
    }
    if ((method === "PUT" || method === "DELETE") &&
      new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/\\d+/roles/${TEAM_ROLE_ID}$`).test(path)) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: `Unexpected Discord request: ${method} ${path}` }, { status: 500 });
  };
  try {
    await assert.rejects(stageServerChange(env, "100000000000000099", GUILD_ID, {
      operation: "create_team",
      team_name: "Builders",
      role_name: "Builders",
      channel_name: "team-builders",
      leader_id: LEADER_ID,
      member_ids: [MEMBER_ID]
    }), /configured server owner/);

    const staged = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "create_team",
      team_name: "Builders",
      role_name: "Builders",
      channel_name: "team-builders",
      leader_id: LEADER_ID,
      member_ids: [MEMBER_ID]
    });
    assert.match(staged.preview, /@everyone will be denied View Channel/);
    assert.equal(calls.some(call => call.method === "POST"), false);

    const result = await confirmServerChange(env, env.LILITH_USER_ID, staged.id);
    assert.match(result, new RegExp(TEAM_ROLE_ID));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM community_teams").get()?.count, 1);
    assert.equal(database.prepare(
      "SELECT leader_id FROM community_teams WHERE name = 'Builders'"
    ).get()?.leader_id, LEADER_ID);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_team_members WHERE active = 1"
    ).get()?.count, 2);
    assert.equal(database.prepare(
      "SELECT member_role FROM community_team_members WHERE user_id = ?"
    ).get(LEADER_ID)?.member_role, "leader");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_team_events WHERE event_type = 'created'"
    ).get()?.count, 1);
    const teamId = String(database.prepare("SELECT id FROM community_teams WHERE name = 'Builders'").get()?.id);

    const addMember = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "update_team",
      team_id: teamId,
      action: "add_member",
      member_id: NEXT_MEMBER_ID
    });
    await confirmServerChange(env, env.LILITH_USER_ID, addMember.id);
    assert.equal(database.prepare(
      "SELECT active FROM community_team_members WHERE team_id = ? AND user_id = ?"
    ).get(teamId, NEXT_MEMBER_ID)?.active, 1);

    const changeLeader = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "update_team",
      team_id: teamId,
      action: "set_leader",
      member_id: NEXT_MEMBER_ID
    });
    await confirmServerChange(env, env.LILITH_USER_ID, changeLeader.id);
    assert.equal(database.prepare("SELECT leader_id FROM community_teams WHERE id = ?").get(teamId)?.leader_id, NEXT_MEMBER_ID);
    assert.equal(database.prepare(
      "SELECT member_role FROM community_team_members WHERE team_id = ? AND user_id = ?"
    ).get(teamId, LEADER_ID)?.member_role, "member");

    const removeMember = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "update_team",
      team_id: teamId,
      action: "remove_member",
      member_id: LEADER_ID
    });
    await confirmServerChange(env, env.LILITH_USER_ID, removeMember.id);
    assert.equal(database.prepare(
      "SELECT active FROM community_team_members WHERE team_id = ? AND user_id = ?"
    ).get(teamId, LEADER_ID)?.active, 0);

    const teams = await listGuildTeams(env, env.LILITH_USER_ID, GUILD_ID) as Array<{ id: string; members: unknown[] }>;
    assert.equal(teams[0].members.length, 2);
    const archive = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "archive_team",
      team_id: teamId
    });
    await confirmServerChange(env, env.LILITH_USER_ID, archive.id);
    assert.equal(database.prepare("SELECT status FROM community_teams WHERE id = ?").get(teamId)?.status, "archived");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_team_members WHERE team_id = ? AND active = 1"
    ).get(teamId)?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
