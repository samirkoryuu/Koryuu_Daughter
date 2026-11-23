import { config } from "./config.js";

const endpoint = `https://discord.com/api/v10/applications/${config.clientId}/role-connections/metadata`;
const field = {
  key: "linked",
  name: "Discord account linked",
  description: "The user authorized linking their Discord account with Koryuu.",
  type: 7
};

const existingResponse = await fetch(endpoint, {
  headers: { authorization: `Bot ${config.discordToken}` }
});
if (!existingResponse.ok) {
  throw new Error(`Discord metadata lookup failed with HTTP ${existingResponse.status}.`);
}
const existing = await existingResponse.json() as Array<{ key?: unknown }>;
if (!Array.isArray(existing)) throw new Error("Discord returned an invalid linked-role metadata schema.");
const metadata = [...existing.filter(item => item.key !== field.key), field];
if (metadata.length > 5) throw new Error("Discord allows at most five linked-role metadata fields.");

const updatedResponse = await fetch(endpoint, {
  method: "PUT",
  headers: {
    authorization: `Bot ${config.discordToken}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(metadata)
});
if (!updatedResponse.ok) {
  throw new Error(`Discord metadata registration failed with HTTP ${updatedResponse.status}.`);
}
console.log("Registered the Koryuu Linked Roles metadata field.");
