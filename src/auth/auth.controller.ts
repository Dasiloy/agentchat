import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { StandardResponse } from '../@types/interface/response';
import { AuthResponse } from '../auth/response/response';
import { User } from '../generated/prisma/client';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ================================================================
  //. Register a new User via local Credentials
  // ================================================================
  @Post('register')
  @Public()
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({
    description: 'Payload for registering user via local credentials',
    required: true,
    type: RegisterDto,
  })
  @ApiResponse({
    status: 201,
    description: 'User registered, returns accessToken',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        data: {
          accessToken:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjI5NDA3ZGMzLWQ2MmQtNGIwYS1iODQyLWZlODExM2MwYWFmMyIsInR5cGUiOiJlbWFpbF9vdHAiLCJlbWFpbCI6ImRhc2lsb3lAZGFzeS5jb20iLCJhdmF0YXIiOm51bGwsImZpcnN0TmFtZSI6ImRhc2lsb3kiLCJsYXN0TmFtZSI6ImRhc3kiLCJpYXQiOjE3NzE0OTk0MDgsImV4cCI6MTc3MTUwMTIwOH0.5JACriWw9C6QsswTSUESfqwi4nYJ6QCEUMimjz804PM',
        },
        message: 'User registered Successfully',
      },
    },
  })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  @ApiResponse({ status: 500, description: 'An error occured' })
  async register(
    @Body() dto: RegisterDto,
  ): Promise<StandardResponse<AuthResponse>> {
    const data = await this.authService.register(dto);

    return {
      success: true,
      message: 'User registered successfully',
      data,
      statusCode: HttpStatus.CREATED,
    };
  }

  // ================================================================
  //. Login  a new User via local Credentials
  // ================================================================
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({
    description: 'Payload for signing in user via local credentials',
    required: true,
    type: LoginDto,
  })
  @ApiResponse({
    status: 201,
    description: 'User logged in, returns accessToken',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        data: {
          accessToken:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjI5NDA3ZGMzLWQ2MmQtNGIwYS1iODQyLWZlODExM2MwYWFmMyIsInR5cGUiOiJlbWFpbF9vdHAiLCJlbWFpbCI6ImRhc2lsb3lAZGFzeS5jb20iLCJhdmF0YXIiOm51bGwsImZpcnN0TmFtZSI6ImRhc2lsb3kiLCJsYXN0TmFtZSI6ImRhc3kiLCJpYXQiOjE3NzE0OTk0MDgsImV4cCI6MTc3MTUwMTIwOH0.5JACriWw9C6QsswTSUESfqwi4nYJ6QCEUMimjz804PM',
        },
        message: 'User registered Successfully',
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Returns accessToken' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 500, description: 'An error occured' })
  async login(@Body() dto: LoginDto): Promise<StandardResponse<AuthResponse>> {
    const data = await this.authService.login(dto);

    return {
      success: true,
      message: 'User logged in successfully',
      data,
      statusCode: HttpStatus.OK,
    };
  }

  // ================================================================
  //. Google OAuth
  // ================================================================
  @Get('google')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Redirect to Google OAuth' })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description:
      'Redirects the browser to Google’s consent screen (Location header).',
  })
  @ApiResponse({ status: 401, description: 'OAuth configuration error' })
  googleAuth() {}

  @Get('google/callback')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({
    summary: 'Google OAuth callback',
    description:
      'Passport validates the OAuth code, then the app redirects to the frontend with a JWT.',
  })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description:
      'Redirects to NEXT_PUBLIC_APP_URL/auth/callback?token=<jwt> (JWT in query string).',
    headers: {
      Location: {
        description: 'Frontend URL with access token',
        schema: {
          type: 'string',
          example:
            'https://your-frontend.example.com/auth/callback?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Google authentication failed' })
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { accessToken } = await this.authService.googleLogin(
      (req as any).user,
    );
    res.redirect(`/?token=${accessToken}`);
  }

  // ================================================================
  //. Current user
  // ================================================================
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'User fetched successfully',
        data: {
          id: 'clh0abc123sampleuserid0001',
          email: 'user@example.com',
          name: 'Ada Lovelace',
          avatar: 'https://cdn.example.com/avatars/ada.png',
          createdAt: '2026-04-01T12:00:00.000Z',
          updatedAt: '2026-04-04T10:15:00.000Z',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMe(
    @CurrentUser() user: any,
  ): Promise<StandardResponse<Partial<User>>> {
    const data = await this.authService.getMe(user.id);
    return {
      success: true,
      message: 'User fetched successfully',
      data,
      statusCode: HttpStatus.OK,
    };
  }

  // ================================================================
  //. Refresh tokens — POST /auth/refresh
  // ================================================================
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  @ApiBody({
    schema: { example: { refreshToken: '<refresh-jwt>' } },
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a new accessToken and refreshToken',
    schema: {
      example: {
        success: true,
        statusCode: 200,
        message: 'Tokens refreshed',
        data: { accessToken: '...', refreshToken: '...' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body('refreshToken') refreshToken: string,
  ): Promise<StandardResponse<AuthResponse>> {
    const data = await this.authService.refresh(refreshToken);
    return {
      success: true,
      message: 'Tokens refreshed',
      data,
      statusCode: HttpStatus.OK,
    };
  }

  // ================================================================
  //.  Logout
  // ================================================================
  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and clear session cache' })
  @ApiResponse({
    status: 200,
    description: 'Session cache cleared',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        message: 'Logged out successfully',
        data: null,
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@CurrentUser() user: any): Promise<StandardResponse<null>> {
    await this.authService.logout(user.id);
    return {
      success: true,
      message: 'Logged out successfully',
      data: null,
      statusCode: HttpStatus.OK,
    };
  }
}
