import { MemberRole, MessageType, RoomType } from '../../generated/prisma/enums';

export interface RoomResponse {
  id: string;
  name: string | null;
  description: string | null;
  type: RoomType;
  isPrivate: boolean;
  createdBy: string | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LastMessagePreview {
  id: string;
  content: string;
  type: MessageType;
  createdAt: Date;
  userId: string | null;
}

export interface RoomWithMetaResponse extends RoomResponse {
  role: MemberRole;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  dmPartner: { id: string; name: string; avatar: string | null } | null;
}

export interface RoomMemberResponse {
  userId: string;
  role: MemberRole;
  joinedAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  };
}
