import { createHmac, randomUUID } from "node:crypto";
import { config } from "./config.js";

interface ApiError {
  error?: string;
}

class WorkerApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkerApiError";
  }
}

function requestHeaders(
  method: string,
  path: string,
  actorId: string,
  body: Uint8Array,
  contentType: string,
  fileName = ""
): Headers {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const prefix = `${timestamp}.${nonce}.${method}.${path}.${actorId}.${contentType}.${fileName}.`;
  const signature = createHmac("sha256", config.gatewaySharedSecret)
    .update(prefix)
    .update(body)
    .digest("hex");
  return new Headers({
    "x-koryuu-timestamp": timestamp,
    "x-koryuu-nonce": nonce,
    "x-koryuu-actor": actorId,
    "x-koryuu-signature": signature,
    ...(contentType ? { "content-type": contentType } : {}),
    ...(fileName ? { "x-koryuu-file-name": fileName } : {})
  });
}

async function request(
  path: string,
  actorId: string,
  body: Uint8Array,
  method: "GET" | "POST",
  contentType: string,
  fileName = ""
): Promise<Response> {
  const headers = requestHeaders(method, path, actorId, body, contentType, fileName);
  const response = await fetch(`${config.workerApiUrl}${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: Buffer.from(body) } : {})
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `Worker API returned HTTP ${response.status}.`;
    try {
      const error = JSON.parse(text) as ApiError;
      if (error.error) message = error.error;
    } catch (error) {
      console.error("Worker API returned invalid error JSON:", error);
    }
    throw new WorkerApiError(message, response.status);
  }
  return response;
}

export async function chatWithWorker(
  actorId: string,
  text: string,
  isDm: boolean,
  guildId: string | null,
  channelId: string,
  context: {
    mentionedUsers: Array<{ id: string; displayName: string }>;
    everyoneMentioned?: boolean;
    recentMessages: Array<{ authorId: string; authorName: string; content: string; createdAt: string }>;
    recentMessagesUnavailable: boolean;
  }
): Promise<{ reply: string; private: boolean; mediaIds?: string[]; pendingAction?: { id: string; label: string } }> {
  const body = Buffer.from(JSON.stringify({ actorId, text, isDm, guildId, channelId, ...context }), "utf8");
  const response = await request("/api/chat", actorId, body, "POST", "application/json");
  return await response.json() as {
    reply: string;
    private: boolean;
    mediaIds?: string[];
    pendingAction?: { id: string; label: string };
  };
}

export async function confirmWithWorker(
  actorId: string,
  actionId: string,
  confirm: boolean
): Promise<string> {
  const body = Buffer.from(JSON.stringify({ actionId, confirm }), "utf8");
  const response = await request("/api/confirm", actorId, body, "POST", "application/json");
  const result = await response.json() as { result: string };
  return result.result;
}

export async function recordMemberJoin(
  guildId: string,
  memberId: string,
  username: string,
  displayName: string,
  joinedAt: string
): Promise<void> {
  const body = Buffer.from(JSON.stringify({
    guildId,
    memberId,
    username,
    displayName,
    joinedAt
  }), "utf8");
  for (let retry = 0; ; retry++) {
    try {
      await request("/api/automation/member-join", config.lilithId, body, "POST", "application/json");
      return;
    } catch (error) {
      const retryable = error instanceof TypeError ||
        (error instanceof WorkerApiError &&
          (error.status === 408 || error.status === 429 || error.status >= 500));
      if (!retryable || retry >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * 2 ** retry));
    }
  }
}

export async function recordMemberActivity(guildId: string, memberId: string): Promise<void> {
  const body = Buffer.from(JSON.stringify({ guildId, memberId }), "utf8");
  for (let retry = 0; ; retry++) {
    try {
      await request("/api/community/member-activity", config.lilithId, body, "POST", "application/json");
      return;
    } catch (error) {
      const retryable = error instanceof TypeError ||
        (error instanceof WorkerApiError &&
          (error.status === 408 || error.status === 429 || error.status >= 500));
      if (!retryable || retry >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * 2 ** retry));
    }
  }
}

export async function recordLinkedRoleJoin(
  guildId: string,
  memberId: string,
  joinedAt: string
): Promise<void> {
  const body = Buffer.from(JSON.stringify({ guildId, memberId, joinedAt }), "utf8");
  await request("/api/community/linked-role-join", config.lilithId, body, "POST", "application/json");
}

export async function archiveGatewayMessage(input: {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
}): Promise<void> {
  const body = Buffer.from(JSON.stringify(input), "utf8");
  await request("/api/archive/message", input.authorId, body, "POST", "application/json");
}

export async function processAfkGatewayMessage(input: {
  guildId: string;
  authorId: string;
  mentionedUserIds: string[];
}): Promise<{ mentionedAfkUsers: Array<{ userId: string; status: string }>; clearedStatus: string | null }> {
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const response = await request("/api/afk/message", input.authorId, body, "POST", "application/json");
  return await response.json() as {
    mentionedAfkUsers: Array<{ userId: string; status: string }>;
    clearedStatus: string | null;
  };
}

export async function deleteGatewayMessages(
  guildId: string,
  channelId: string,
  messageIds: string[]
): Promise<void> {
  const body = Buffer.from(JSON.stringify({ guildId, channelId, messageIds }), "utf8");
  await request("/api/archive/delete", config.lilithId, body, "POST", "application/json");
}

export async function removeClientMemoryMember(guildId: string, memberId: string): Promise<void> {
  const body = Buffer.from(JSON.stringify({ guildId, memberId }), "utf8");
  await request("/api/archive/member-leave", config.lilithId, body, "POST", "application/json");
}

export async function storeImage(
  actorId: string,
  fileName: string,
  contentType: string,
  bytes: Uint8Array
): Promise<string> {
  const safeFileName = fileName.replace(/[\r\n"]/g, "_").slice(0, 120) || "image";
  const response = await request("/api/media", actorId, bytes, "POST", contentType, safeFileName);
  const result = await response.json() as { id: string };
  return result.id;
}

export async function fetchPrivateImage(
  actorId: string,
  mediaId: string
): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
  const response = await request(`/api/media/${mediaId}`, actorId, new Uint8Array(), "GET", "");
  const fileName = response.headers.get("content-disposition")?.match(/filename="([^"]*)"/)?.[1] ?? "koryuu-image";
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  return { fileName, contentType, bytes: Buffer.from(await response.arrayBuffer()) };
}
