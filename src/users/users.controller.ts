import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StandardResponse } from '../@types/interface/response';
import { UsersService } from './users.service';
import { SearchUserDto } from './dto/serach.query.dto';
import { User } from '../generated/prisma/client';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ================================================================
  //. Search User by name or email
  // ================================================================
  @Get('search')
  @ApiOperation({
    summary: 'Search users by name or email prefix (min 3 chars)',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Search term (min 3 characters)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Users matching the query',
    schema: {
      example: {
        success: true,
        statusCode: 200,
        message: 'Users found',
        data: [
          {
            id: 'clh0abc',
            name: 'Alice',
            email: 'alice@example.com',
            avatar: null,
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Query must be at least 3 characters',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'An error occured',
  })
  async searchUsers(
    @Query() query: SearchUserDto,
    @CurrentUser() user: User,
  ): Promise<StandardResponse<Partial<User>[]>> {
    const data = await this.usersService.searchUsers(query.q, user);
    return {
      success: true,
      message: 'Users found',
      data,
      statusCode: HttpStatus.OK,
    };
  }
}
