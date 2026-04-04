import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { AccountProvider } from '../generated/prisma/enums';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const BCRYPT_ROUNDS = 10;
const USER_CACHE_TTL = 300; // cache user for 5min, this way we dont visit postgress too often

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * @description Registers a new user with a local account, hashes the password,
   *   creates the user and Account records, and returns a signed JWT.
   *
   *
   * @param dto - Registration payload containing email, password, and name
   * @returns Signed access token
   * @throws {ConflictException} when email already exists
   */
  async register(dto: RegisterDto): Promise<{ accessToken: string }> {
    try {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
        include: { accounts: { select: { provider: true } } },
      });

      if (existing) {
        const hasSocialAccount = existing.accounts.some(
          (a) => a.provider !== AccountProvider.LOCAL,
        );
        throw new ConflictException(
          hasSocialAccount
            ? 'This email is linked to a Socail  account.'
            : 'Email already registered',
        );
      }

      const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          hashedPassword,
          accounts: {
            create: {
              provider: AccountProvider.LOCAL,
              providerAccountId: dto.email,
            },
          },
        },
      });

      const accessToken = this.signToken(user.id, user.email);
      return { accessToken };
    } catch (error) {
      this.logger.error('Register error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  /**
   * @description Validates credentials and returns a signed JWT. Caches the user
   *   in Redis on success to reduce subsequent DB lookups.
   *
   *
   * @param dto - Login payload containing email and password
   * @returns Signed access token
   * @throws {UnauthorizedException} when credentials are invalid
   */
  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (!user || !user.hashedPassword) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const passwordMatch = await bcrypt.compare(
        dto.password,
        user.hashedPassword,
      );

      if (!passwordMatch) {
        throw new UnauthorizedException('Invalid credentials');
      }

      await this.redis.set(
        `user:${user.id}`,
        JSON.stringify(user),
        'EX',
        USER_CACHE_TTL,
      );

      const accessToken = this.signToken(user.id, user.email);
      return { accessToken };
    } catch (error) {
      this.logger.error('Login error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  /**
   * @description Issues a JWT for a user that authenticated via Google OAuth.
   *   Caches the user in Redis after issuing the token.
   * @param user - The user object returned by the Google strategy
   * @returns Signed access token
   */
  async googleLogin(user: any): Promise<{ accessToken: string }> {
    try {
      await this.redis.set(
        `user:${user.id}`,
        JSON.stringify(user),
        'EX',
        USER_CACHE_TTL,
      );
      const accessToken = this.signToken(user.id, user.email);
      return { accessToken };
    } catch (error) {
      this.logger.error('Google Login error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  /**
   * @description Clears the user session from Redis on logout.
   * @param userId - The ID of the user logging out
   */
  /**
   * @description Fetches the current user's profile directly from the database.
   * @param userId - The authenticated user's ID
   * @returns The user record
   * @throws {UnauthorizedException} when user no longer exists
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        avatar: true,
        createdAt: true,
        name: true,
        updatedAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('Unauthorized');
    return user;
  }

  async logout(userId: string): Promise<void> {
    await this.redis.del(`user:${userId}`);
  }

  private signToken(userId: string, email: string): string {
    return this.jwtService.sign({ sub: userId, email });
  }

  /**
   * @description Encrypts text using AES-256-CBC with the configured AES_KEY.
   *
   *
   * @param text - Plain text to encrypt
   * @returns Encrypted string in the format `ciphertext:iv`
   */
  encrypt(text: string): string {
    const secretBuffer = Buffer.from(
      this.configService.getOrThrow('AES_KEY'),
      'hex',
    );
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', secretBuffer, iv);
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf-8'),
      cipher.final(),
    ]);
    return `${encrypted.toString('hex')}:${iv.toString('hex')}`;
  }

  /**
   * @description Decrypts an AES-256-CBC encrypted string.
   *
   *
   * @param text - Encrypted string in the format `ciphertext:iv`
   * @returns Plain text
   */
  decrypt(text: string): string {
    const secretBuffer = Buffer.from(
      this.configService.getOrThrow('AES_KEY'),
      'hex',
    );
    const [encrypt, iv] = text.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      secretBuffer,
      Buffer.from(iv, 'hex'),
    );
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypt, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  }
}
