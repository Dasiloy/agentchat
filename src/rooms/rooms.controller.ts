import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StandardResponse } from '../@types/interface/response';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { CreateDmDto } from './dto/create-dm.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { RemoveMemberDto } from './dto/remove-member.dto';
import { RoomMemberResponse, RoomResponse, RoomWithMetaResponse } from './response/response';

@ApiTags('Rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  // ================================================================
  //. Create room
  // ================================================================
  @Post()
  @ApiOperation({ summary: 'Create a new room' })
  @ApiBody({
    description: 'Room creation payload',
    required: true,
    type: CreateRoomDto,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Room created successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        message: 'Room created',
        data: {
          id: 'clh0abc123roomid0001',
          name: 'general',
          description: 'General discussion',
          type: 'CHANNEL',
          isPrivate: true,
          createdBy: 'clh0abc123userid0001',
          memberCount: 1,
          createdAt: '2026-04-04T10:00:00.000Z',
          updatedAt: '2026-04-04T10:00:00.000Z',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  @ApiResponse({ status: HttpStatus.INTERNAL_SERVER_ERROR, description: 'An error occurred' })
  async createRoom(
    @Body() dto: CreateRoomDto,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<RoomResponse>> {
    const data = await this.roomsService.createRoom(dto, user.id);
    return { success: true, message: 'Room created', data, statusCode: HttpStatus.CREATED };
  }

  // ================================================================
  //. Get my rooms
  // ================================================================
  @Get()
  @ApiOperation({ summary: 'Get all rooms the current user belongs to, with lastMessage and unreadCount' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Room list fetched successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Rooms fetched',
        data: [
          {
            id: 'clh0abc123roomid0001',
            name: 'general',
            description: 'General discussion',
            type: 'CHANNEL',
            isPrivate: true,
            createdBy: 'clh0abc123userid0001',
            memberCount: 5,
            createdAt: '2026-04-04T10:00:00.000Z',
            updatedAt: '2026-04-04T10:00:00.000Z',
            role: 'OWNER',
            lastMessage: {
              id: 'clh0abc123msgid0001',
              content: 'Hello everyone!',
              type: 'TEXT',
              createdAt: '2026-04-04T11:00:00.000Z',
              userId: 'clh0abc123userid0002',
            },
            unreadCount: 3,
          },
        ],
      },
    },
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async getMyRooms(
    @CurrentUser() user: any,
  ): Promise<StandardResponse<RoomWithMetaResponse[]>> {
    const data = await this.roomsService.getMyRooms(user.id);
    return { success: true, message: 'Rooms fetched', data, statusCode: HttpStatus.OK };
  }

  // ================================================================
  //. Get single room
  // ================================================================
  @Get(':id')
  @ApiOperation({ summary: 'Get a room by ID (caller must be a member)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Room fetched successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Room fetched',
        data: {
          id: 'clh0abc123roomid0001',
          name: 'general',
          description: 'General discussion',
          type: 'CHANNEL',
          isPrivate: true,
          createdBy: 'clh0abc123userid0001',
          memberCount: 5,
          createdAt: '2026-04-04T10:00:00.000Z',
          updatedAt: '2026-04-04T10:00:00.000Z',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found or caller is not a member' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async getRoom(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<RoomResponse>> {
    const data = await this.roomsService.getRoom(id, user.id);
    return { success: true, message: 'Room fetched', data, statusCode: HttpStatus.OK };
  }

  // ================================================================
  //. Get room members
  // ================================================================
  @Get(':id/members')
  @ApiOperation({ summary: 'Get all members of a room — caller must be a member' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Members fetched successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Members fetched',
        data: [
          {
            userId: 'clh0abc123userid0001',
            role: 'OWNER',
            joinedAt: '2026-04-04T10:00:00.000Z',
            user: { id: 'clh0abc123userid0001', name: 'Alice', email: 'alice@example.com', avatar: null },
          },
        ],
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found or caller is not a member' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async getRoomMembers(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<RoomMemberResponse[]>> {
    const data = await this.roomsService.getRoomMembers(id, user.id);
    return { success: true, message: 'Members fetched', data, statusCode: HttpStatus.OK };
  }

  // ================================================================
  //. Leave room (any member)
  // ================================================================
  @Delete(':id/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Leave a room',
    description:
      'Any member can leave. OWNER with remaining members must delete the room or remove members first. OWNER as last member deletes the room.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Left the room successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Left room',
        data: null,
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Not a member of this room' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Owner must remove members first' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async leaveRoom(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<null>> {
    await this.roomsService.leaveRoom(id, user.id);
    return { success: true, message: 'Left room', data: null, statusCode: HttpStatus.OK };
  }

  // ================================================================
  //. Delete room (OWNER only)
  // ================================================================
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a room — OWNER only. Cascades to members, messages and receipts.' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Room deleted successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Room deleted',
        data: null,
      },
    },
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Caller is not the room owner' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async deleteRoom(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<null>> {
    await this.roomsService.deleteRoom(id, user.id);
    return { success: true, message: 'Room deleted', data: null, statusCode: HttpStatus.OK };
  }

  // ================================================================
  //. Open or create DM
  // ================================================================
  @Post('dm')
  @ApiOperation({ summary: 'Open or create a DM room with another user by email. Idempotent: returns existing DM if one exists.' })
  @ApiBody({
    description: 'Email address of the user to DM',
    required: true,
    type: CreateDmDto,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'DM room returned (created or existing)',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        message: 'DM ready',
        data: {
          id: 'clh0abc123roomid0001',
          name: null,
          description: null,
          type: 'DM',
          isPrivate: true,
          createdBy: 'clh0abc123userid0001',
          memberCount: 2,
          createdAt: '2026-04-04T10:00:00.000Z',
          updatedAt: '2026-04-04T10:00:00.000Z',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No user found with that email' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Cannot DM yourself' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async openDm(
    @Body() dto: CreateDmDto,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<RoomResponse>> {
    const data = await this.roomsService.createOrGetDm(user.id, dto.email);
    return { success: true, message: 'DM ready', data, statusCode: HttpStatus.CREATED };
  }

  // ================================================================
  //. Invite user (OWNER only)
  // ================================================================
  @Post(':id/invite')
  @ApiOperation({ summary: 'Invite a user to a room — OWNER only. Idempotent: duplicate invites are safe.' })
  @ApiBody({
    description: 'Email address of the user to invite',
    required: true,
    type: InviteUserDto,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User invited successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        message: 'User invited',
        data: null,
      },
    },
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Caller is not the room owner' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async inviteUser(
    @Param('id') id: string,
    @Body() dto: InviteUserDto,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<null>> {
    await this.roomsService.inviteUser(id, user.id, dto.email);
    return { success: true, message: 'User invited', data: null, statusCode: HttpStatus.CREATED };
  }

  // ================================================================
  //. Remove member (OWNER only)
  // ================================================================
  @Delete(':id/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a member from a room by email — OWNER only. Idempotent if member does not exist.' })
  @ApiBody({
    description: 'Email address of the member to remove',
    required: true,
    type: RemoveMemberDto,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Member removed successfully',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Member removed',
        data: null,
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No user found with that email' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Caller is not the room owner, or tried to remove themselves (use leave-room instead)' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  async removeMember(
    @Param('id') id: string,
    @Body() dto: RemoveMemberDto,
    @CurrentUser() user: any,
  ): Promise<StandardResponse<null>> {
    await this.roomsService.removeMember(id, user.id, dto.email);
    return { success: true, message: 'Member removed', data: null, statusCode: HttpStatus.OK };
  }
}
