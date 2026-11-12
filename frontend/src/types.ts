// Wire types for the rslack JSON API and WebSocket. These mirror the Rust structs
// that are serialized with serde (file and struct names noted on each type).
// i64 → number (ids and millisecond timestamps fit comfortably in a JS double).

/** src/auth.rs `User` */
export interface User {
  id: number;
  username: string;
  display_name: string;
  created_at: number;
}

/** Minimal shape needed to draw an avatar. */
export interface Person {
  username: string;
  display_name: string;
}

/** src/channels.rs `UserBrief` (channel members, DM partner) */
export interface UserBrief {
  id: number;
  username: string;
  display_name: string;
  online: boolean;
}

/** src/workspaces.rs `Workspace` */
export interface Workspace {
  id: number;
  name: string;
  invite_code: string;
  owner_id: number;
  created_at: number;
}

/** src/workspaces.rs `Member` */
export interface Member {
  id: number;
  username: string;
  display_name: string;
  role: string;
  online: boolean;
}

/** src/channels.rs `ChannelSummary` */
export interface ChannelSummary {
  id: number;
  workspace_id: number;
  name: string;
  topic: string;
  is_private: boolean;
  is_dm: boolean;
  created_by: number;
  created_at: number;
  last_read_id: number;
  unread_count: number;
  mention_count: number;
  member_count: number;
  dm_user: UserBrief | null;
}

/** src/channels.rs `BrowseRow` */
export interface BrowseRow {
  id: number;
  name: string;
  topic: string;
  member_count: number;
  joined: boolean;
}

/** src/messages.rs `Reaction` */
export interface Reaction {
  emoji: string;
  count: number;
  user_ids: number[];
}

/** src/messages.rs `Attachment` (`message_id` is not serialized) */
export interface Attachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  url: string;
}

/** src/messages.rs `Message` = flattened `MessageRow` + reactions + attachments */
export interface Message {
  id: number;
  channel_id: number;
  user_id: number;
  username: string;
  display_name: string;
  parent_id: number | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  reply_count: number;
  last_reply_at: number | null;
  reactions: Reaction[];
  attachments: Attachment[];
}

/** src/search.rs `ChannelRef` */
export interface ChannelRef {
  id: number;
  name: string;
  is_dm: boolean;
  is_private: boolean;
}

// ---------------------------------------------------------------- responses
export interface AuthResponse { user: User; token: string; }
export interface OkResponse { ok: true; }
export interface MessagePage { messages: Message[]; has_more: boolean; }
export interface ThreadResponse { parent: Message; replies: Message[]; }
export interface ReactionResponse { added: boolean; reactions: Reaction[]; }
export interface SearchHit { message: Message; channel: ChannelRef; }
export interface SearchResponse { results: SearchHit[]; }
export interface AddMemberResponse { ok: true; added: boolean; }
export interface ApiErrorBody { error: string; }

// ---------------------------------------------------------------- requests
export interface SignupRequest { username: string; password: string; display_name?: string; }
export interface CreateChannelRequest { name: string; topic?: string; is_private?: boolean; }
export interface PostMessageRequest { body: string; parent_id: number | null; attachment_ids: number[]; }

// ---------------------------------------------------------------- WebSocket (server → client)
export interface HelloEvent { type: 'hello'; user_id: number; online_user_ids: number[]; }
export interface PresenceEvent { type: 'presence'; user_id: number; online: boolean; }
export interface MessageNewEvent { type: 'message.new'; channel_id: number; message: Message; }
export interface MessageUpdatedEvent { type: 'message.updated'; channel_id: number; message: Message; }
export interface MessageDeletedEvent {
  type: 'message.deleted'; channel_id: number; message_id: number; parent_id: number | null; has_replies: boolean;
}
export interface ReactionUpdatedEvent {
  type: 'reaction.updated'; channel_id: number; message_id: number; parent_id: number | null; reactions: Reaction[];
}
export interface TypingEvent {
  type: 'typing'; channel_id: number; parent_id: number | null; user_id: number; username: string; display_name: string;
}
export interface ChannelUpdatedEvent { type: 'channel.updated'; channel_id: number; topic: string; }
export interface ChannelReadEvent { type: 'channel.read'; channel_id: number; message_id: number; }
export interface ChannelsChangedEvent { type: 'channels.changed'; workspace_id: number; }
export interface ChannelMembersChangedEvent { type: 'channel.members_changed'; channel_id: number; user_id: number; joined: boolean; }
export interface WorkspaceMemberJoinedEvent { type: 'workspace.member_joined'; workspace_id: number; user_id: number; }
export interface WorkspacesChangedEvent { type: 'workspaces.changed'; }
export interface PongEvent { type: 'pong'; }

export type ServerEvent =
  | HelloEvent | PresenceEvent | MessageNewEvent | MessageUpdatedEvent | MessageDeletedEvent
  | ReactionUpdatedEvent | TypingEvent | ChannelUpdatedEvent | ChannelReadEvent | ChannelsChangedEvent
  | ChannelMembersChangedEvent | WorkspaceMemberJoinedEvent | WorkspacesChangedEvent | PongEvent;

/** Fields `applyDelete` needs; both the WS event and a local delete provide them. */
export type DeleteInfo = Omit<MessageDeletedEvent, 'type'>;

// ---------------------------------------------------------------- WebSocket (client → server)
export type ClientEvent =
  | { type: 'typing'; channel_id: number; parent_id: number | null }
  | { type: 'ping' };
