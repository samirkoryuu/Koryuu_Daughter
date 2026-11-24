import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  escapeMarkdown
} from "discord.js";
import {
  chatWithWorker,
  confirmWithWorker,
  fetchPrivateImage,
  recordMemberActivity,
  recordMemberJoin,
  recordLinkedRoleJoin,
  archiveGatewayMessage,
  processAfkGatewayMessage,
  deleteGatewayMessages,
  removeClientMemoryMember,
  storeImage
} from "./gateway-api.js";
import { config } from "./config.js";
import { safeReply } from "./discord-replies.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

process.on("unhandledRejection", reason => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", error => {
  console.error("Unhandled process exception:", error);
});

client.on(Events.Error, error => {
  console.error("Discord gateway client error:", error);
});

client.once(Events.ClientReady, ready => {
  console.log(`Koryuu Gateway online as ${ready.user.tag}`);
});

let activityCacheDate = "";
const reportedActivity = new Set<string>();

function archivedMessageContent(message: import("discord.js").Message): string {
  const parts = [message.content];
  for (const attachment of message.attachments.values()) {
    parts.push(`[Attachment: ${attachment.name ?? "unnamed file"}${attachment.contentType ? ` (${attachment.contentType})` : ""}]`);
  }
  for (const embed of message.embeds) {
    const text = [embed.title, embed.description].filter(Boolean).join("\n");
    if (text) parts.push(`[Embed]\n${text}`);
  }
  return parts.filter(Boolean).join("\n").slice(0, 8000);
}

function reportArchivedMessage(message: import("discord.js").Message): void {
  if (!message.guildId || message.guildId !== config.guildId) return;
  archiveGatewayMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    content: archivedMessageContent(message),
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null
  }).catch(error => {
    console.error(`Could not archive message ${message.id} in channel ${message.channelId}:`, error);
  });
}

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    reportArchivedMessage(message);
  } catch (error) {
    console.error("Could not retrieve an edited message for archive synchronization:", error);
  }
});

client.on(Events.MessageDelete, message => {
  if (!message.guildId || message.guildId !== config.guildId) return;
  deleteGatewayMessages(message.guildId, message.channelId, [message.id]).catch(error => {
    console.error(`Could not remove deleted message ${message.id} from the archive:`, error);
  });
});

client.on(Events.MessageBulkDelete, (messages, channel) => {
  if (!channel.isTextBased() || !("guildId" in channel) ||
    typeof channel.guildId !== "string" || channel.guildId !== config.guildId) return;
  deleteGatewayMessages(channel.guildId, channel.id, [...messages.keys()]).catch(error => {
    console.error(`Could not remove bulk-deleted messages from channel ${channel.id}:`, error);
  });
});

client.on(Events.GuildMemberRemove, member => {
  removeClientMemoryMember(member.guild.id, member.id).catch(error => {
    console.error(`Could not remove persistent memory for departing member ${member.id}:`, error);
  });
});

client.on(Events.GuildMemberAdd, member => {
  const joinedAt = member.joinedAt?.toISOString() ?? new Date().toISOString();
  recordMemberJoin(
    member.guild.id,
    member.id,
    member.user.username,
    member.displayName,
    joinedAt
  ).catch(error => {
    console.error(`Could not report member join for ${member.id}:`, error);
  });
  if (!member.user.bot) {
    recordLinkedRoleJoin(member.guild.id, member.id, joinedAt).catch(error => {
      console.error(`Could not run Linked Role onboarding for ${member.id}:`, error);
    });
  }
});

async function getChatContext(message: import("discord.js").Message): Promise<{
  mentionedUsers: Array<{ id: string; displayName: string }>;
  everyoneMentioned: boolean;
  recentMessages: Array<{ authorId: string; authorName: string; content: string; createdAt: string }>;
  recentMessagesUnavailable: boolean;
}> {
  const mentionedUsers = [...message.mentions.users.values()]
    .filter(user => user.id !== client.user?.id && user.id !== message.author.id)
    .map(user => ({ id: user.id, displayName: user.globalName ?? user.username }));
  const everyoneMentioned = /(^|\s)@everyone\b/i.test(message.content);
  if (!message.channel.isTextBased() || !("messages" in message.channel)) {
    return { mentionedUsers, everyoneMentioned, recentMessages: [], recentMessagesUnavailable: true };
  }

  let messages;
  try {
    messages = await message.channel.messages.fetch({ limit: 12, before: message.id });
  } catch (error) {
    console.error(`Could not read recent messages in channel ${message.channelId}:`, error);
    return { mentionedUsers, everyoneMentioned, recentMessages: [], recentMessagesUnavailable: true };
  }
  let totalCharacters = 0;
  const recentMessages = [...messages.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .flatMap(item => {
      const content = item.content.trim().slice(0, 600);
      if (!content || totalCharacters >= 4500) return [];
      const bounded = content.slice(0, 4500 - totalCharacters);
      totalCharacters += bounded.length;
      return [{
        authorId: item.author.id,
        authorName: item.member?.displayName ?? item.author.globalName ?? item.author.username,
        content: bounded,
        createdAt: item.createdAt.toISOString()
      }];
    });
  return { mentionedUsers, everyoneMentioned, recentMessages, recentMessagesUnavailable: false };
}

function isImage(contentType: string | null): contentType is string {
  return contentType !== null && /^image\/(?:png|jpeg|gif|webp)$/.test(contentType);
}

async function uploadAttachments(
  actorId: string,
  attachments: Iterable<{ name: string; contentType: string | null; size: number; url: string }>
): Promise<string[]> {
  if (actorId !== config.asterionId && actorId !== config.lilithId) return [];
  const mediaIds: string[] = [];
  for (const attachment of attachments) {
    if (!isImage(attachment.contentType) || attachment.size > 8 * 1024 * 1024) continue;
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Discord image download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("The attached image exceeded the 8 MB limit.");
    mediaIds.push(await storeImage(actorId, attachment.name, attachment.contentType, bytes));
  }
  return mediaIds;
}

async function makeComponents(
  actorId: string,
  actionId?: string
): Promise<ActionRowBuilder<ButtonBuilder>[]> {
  if (!actionId) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`action_confirm:${actionId}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`action_cancel:${actionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  )];
}

async function makeFiles(actorId: string, mediaIds: string[] | undefined): Promise<AttachmentBuilder[]> {
  if (!mediaIds?.length) return [];
  const files: AttachmentBuilder[] = [];
  for (const id of mediaIds.slice(0, 3)) {
    const media = await fetchPrivateImage(actorId, id);
    files.push(new AttachmentBuilder(media.bytes, { name: media.fileName }));
  }
  return files;
}

client.on(Events.MessageCreate, async message => {
  if (message.guildId) reportArchivedMessage(message);
  if (message.author.bot) return;
  if (message.guildId) {
    try {
      const afk = await processAfkGatewayMessage({
        guildId: message.guildId,
        authorId: message.author.id,
        mentionedUserIds: [...message.mentions.users.keys()]
      });
      if (afk.mentionedAfkUsers.length) {
        const lines = afk.mentionedAfkUsers.map(({ userId, status }) =>
          `<@${userId}> is AFK: ${escapeMarkdown(status.replace(/\s+/g, " "))}`
        );
        let chunk = "";
        for (const line of lines) {
          if (chunk && chunk.length + line.length + 1 > 1900) {
            await safeReply(message, { content: chunk, allowedMentions: { parse: [] } });
            chunk = "";
          }
          chunk = chunk ? `${chunk}\n${line}` : line;
        }
        if (chunk) await safeReply(message, { content: chunk, allowedMentions: { parse: [] } });
      }
      if (afk.clearedStatus) {
        try {
          await message.author.send("Your AFK status has been cleared because you sent a message.");
        } catch (error) {
          console.error(`Could not privately notify member ${message.author.id} that their AFK status was cleared:`, error);
        }
      }
    } catch (error) {
      console.error(`Could not check AFK status for message ${message.id}:`, error);
    }
  }
  if (message.guildId) {
    const activityDate = new Date().toISOString().slice(0, 10);
    if (activityCacheDate !== activityDate) {
      activityCacheDate = activityDate;
      reportedActivity.clear();
    }
    const activityKey = `${message.guildId}:${message.author.id}`;
    if (!reportedActivity.has(activityKey)) {
      reportedActivity.add(activityKey);
      recordMemberActivity(message.guildId, message.author.id).catch(error => {
        if (activityCacheDate === activityDate) reportedActivity.delete(activityKey);
        console.error(`Could not record daily server activity for ${message.author.id}:`, error);
      });
    }
  }
  const isDm = !message.guild;
  const mentioned = Boolean(client.user && message.mentions.has(client.user));
  const isAdminTicketChannel = !isDm &&
    "name" in message.channel &&
    typeof message.channel.name === "string" &&
    message.channel.name.startsWith("creator15-");
  if (!isDm && !mentioned && !isAdminTicketChannel) return;

  const cleanText = message.content
    .replace(new RegExp(`<@!?${client.user?.id ?? "0"}>`, "g"), "")
    .trim();
  if (!cleanText && message.attachments.size === 0) {
    await safeReply(message, "Koryuu is listening. Tell me what you need.");
    return;
  }

  try {
    await message.channel.sendTyping();
    const chatContext = await getChatContext(message);
    let text = cleanText || "I attached an image.";
    try {
      const mediaIds = await uploadAttachments(message.author.id, message.attachments.values());
      if (mediaIds.length) text += `\n[Private image attachment IDs: ${mediaIds.join(", ")}]`;
    } catch (error) {
      console.error("Private image upload failed:", error);
      text += "\n[The image could not be securely stored.]";
    }

    const result = await chatWithWorker(
      message.author.id,
      text,
      isDm,
      message.guildId,
      message.channelId,
      chatContext
    );
    const components = await makeComponents(message.author.id, result.pendingAction?.id);
    const files = await makeFiles(message.author.id, result.mediaIds);
    if (result.private && !isDm) {
      try {
        await message.author.send({
          content: result.reply.slice(0, 1900),
          components,
          files,
          allowedMentions: { parse: [] }
        });
        await safeReply(message, "Sent that in a DM, as requested.");
      } catch (error) {
        console.error("Could not deliver the requested private response by DM:", error);
        await safeReply(message, "I couldn't send that DM. Please enable DMs from this server and try again.");
      }
      return;
    }
    await safeReply(message, {
      content: result.reply.slice(0, 1900),
      components,
      files,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error("Gateway chat failed:", error);
    await safeReply(message, "A system error occurred. No operation was confirmed.");
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  const match = /^(action_confirm|action_cancel):([0-9a-f-]{36})$/i.exec(interaction.customId);
  if (!match) return;
  try {
    const confirmed = match[1] === "action_confirm";
    const result = await confirmWithWorker(interaction.user.id, match[2], confirmed);
    await interaction.update({
      content: confirmed ? `**[ CONFIRMED ]** ${result}`.slice(0, 1900) : "Action cancelled.",
      components: [],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error("Gateway action confirmation failed:", error);
    const message = error instanceof Error ? error.message : "The action failed.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `**[ SYSTEM DENIED ]** ${message}`, ephemeral: true })
        .catch(followUpError => console.error("Could not report the interaction failure:", followUpError));
    } else {
      await interaction.reply({ content: `**[ SYSTEM DENIED ]** ${message}`, ephemeral: true })
        .catch(replyError => console.error("Could not report the interaction failure:", replyError));
    }
  }
});

client.login(config.discordToken).catch(error => {
  console.error("Could not connect to Discord:", error);
});
