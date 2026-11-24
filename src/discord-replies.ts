import type { Message, MessageCreateOptions, MessageReplyOptions } from "discord.js";

export async function safeReply(
  message: Message,
  payload: string | MessageReplyOptions
): Promise<Message | null> {
  try {
    if (typeof payload === "string") {
      return await message.reply({
        content: payload,
        failIfNotExists: false,
        allowedMentions: { parse: [] }
      });
    }
    return await message.reply({ ...payload, failIfNotExists: false });
  } catch (error) {
    console.error(`Could not send the Discord reply for message ${message.id}:`, error);
    try {
      if (!("send" in message.channel)) return null;
      if (typeof payload === "string") {
        return await message.channel.send({
          content: payload,
          allowedMentions: { parse: [] }
        });
      }
      const { failIfNotExists: _failIfNotExists, ...sendPayload } =
        payload as MessageReplyOptions & { failIfNotExists?: boolean };
      return await message.channel.send(sendPayload as MessageCreateOptions);
    } catch (fallbackError) {
      console.error(`Could not send the Discord fallback response for message ${message.id}:`, fallbackError);
      return null;
    }
  }
}
