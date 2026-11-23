import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody
} from "discord.js";

export const commandData = [
  new SlashCommandBuilder().setName("koryuu").setDescription("View Koryuu system status"),
  new SlashCommandBuilder().setName("linked-role").setDescription("Get Linked Role instructions or manage opt-in reminders")
    .addBooleanOption(option => option.setName("reminders")
      .setDescription("Opt in to or out of a private reminder every 20 minutes until verified")),
  new SlashCommandBuilder().setName("verification_reminder")
    .setDescription("DM each currently unverified server member once (configured Moderator role required)"),
  new SlashCommandBuilder().setName("afk").setDescription("Choose a preset or custom AFK status"),
  new SlashCommandBuilder().setName("dprint").setDescription("View Asterion's Dreamprint profile"),
  new SlashCommandBuilder().setName("dprint_r").setDescription("View Asterion's relationship statistics"),
  new SlashCommandBuilder().setName("dprint_c").setDescription("View Asterion's collection statistics"),
  new SlashCommandBuilder().setName("dprint_a").setDescription("View Asterion's achievements"),
  new SlashCommandBuilder().setName("memory").setDescription("Manage shared memories")
    .addSubcommand(subcommand => subcommand.setName("list").setDescription("List Asterion's saved memories"))
    .addSubcommand(subcommand => subcommand.setName("add").setDescription("Prepare a shared memory (administrator only)")
      .addStringOption(option => option.setName("title").setDescription("Memory title").setRequired(true))
      .addStringOption(option => option.setName("content").setDescription("Memory text").setRequired(true))),
  new SlashCommandBuilder().setName("shop").setDescription("List items currently on sale")
    .addSubcommand(subcommand => subcommand.setName("list").setDescription("List the on-sale catalog")),
  new SlashCommandBuilder().setName("collection").setDescription("View Asterion's collection"),
  new SlashCommandBuilder().setName("balance").setDescription("Check your RP balance"),
  new SlashCommandBuilder().setName("rp").setDescription("Prepare an RP ledger change (administrator only)")
    .addSubcommand(subcommand => subcommand.setName("award").setDescription("Prepare an RP award")
      .addUserOption(option => option.setName("user").setDescription("Configured recipient").setRequired(true))
      .addIntegerOption(option => option.setName("amount").setDescription("Amount of RP").setMinValue(1).setRequired(true))
      .addStringOption(option => option.setName("note").setDescription("Reason").setRequired(true)))
    .addSubcommand(subcommand => subcommand.setName("deduct").setDescription("Prepare an RP deduction")
      .addUserOption(option => option.setName("user").setDescription("Configured recipient").setRequired(true))
      .addIntegerOption(option => option.setName("amount").setDescription("Amount of RP").setMinValue(1).setRequired(true))
      .addStringOption(option => option.setName("note").setDescription("Reason").setRequired(true))),
  new SlashCommandBuilder().setName("buy").setDescription("Request a shop purchase")
    .addStringOption(option => option.setName("unique_id").setDescription("Unique shop item ID").setRequired(true)),
  new SlashCommandBuilder().setName("admin").setDescription("Private administrator access")
    .addSubcommand(subcommand => subcommand.setName("authenticate").setDescription("Authenticate through a private form"))
    .addSubcommand(subcommand => subcommand.setName("logout").setDescription("End this temporary admin session"))
].map(command => command.toJSON()) as RESTPostAPIChatInputApplicationCommandsJSONBody[];
