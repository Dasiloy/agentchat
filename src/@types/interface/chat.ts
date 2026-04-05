export interface JoinRoomPayload {
  roomId: string;
  lastMessageId?: string; // client's most recent message — skip fetch if already up to date
}

export interface SendMessagePayload {
  roomId: string;
  content: string;
}

export interface TypingPayload {
  roomId: string;
}

export interface MessageDeliveredPayload {
  messageId: string;
}

export interface MessagesReadPayload {
  roomId: string;
  upToMessageId: string;
}

export interface SubscribeRoomsPayload {
  roomIds: string[];
}
