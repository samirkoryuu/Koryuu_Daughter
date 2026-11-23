import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandData } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);
if (config.guildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commandData });
  console.log(`Registered ${commandData.length} guild commands.`);
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
  console.log(`Registered ${commandData.length} global commands. Global updates may take time to appear.`);
}
