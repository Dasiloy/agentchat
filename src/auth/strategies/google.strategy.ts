import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountProvider } from '../../generated/prisma/enums';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      clientID: config.getOrThrow('AUTH_GOOGLE_ID'),
      clientSecret: config.getOrThrow('AUTH_GOOGLE_SECRET'),
      callbackURL: `http://localhost:${config.getOrThrow('PORT')}/api/auth/google/callback`,
      scope: ['email', 'profile'],
    });
  }

  /**
   * @description Finds or creates a user from the Google OAuth profile. Links
   *   googleId to an existing account if matched by email.
   *
   * @param _accessToken - Google access token (unused; not stored)
   * @param _refreshToken - Google refresh token (unused)
   * @param profile - Google profile object
   * @param done - Passport callback
   */
  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<void> {
    const email: string = profile.emails[0].value;
    const googleId: string = profile.id;

    // 1. Account already linked to this Google ID
    const existingAccount = await this.prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: AccountProvider.GOOGLE,
          providerAccountId: googleId,
        },
      },
      include: { user: true },
    });

    if (existingAccount) {
      return done(null, existingAccount.user);
    }

    // 2. Email matches an existing user — link the Google account
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      await this.prisma.account.create({
        data: {
          userId: existingUser.id,
          provider: AccountProvider.GOOGLE,
          providerAccountId: googleId,
        },
      });
      return done(null, existingUser);
    }

    // 3. Brand new user — create user + account together
    const newUser = await this.prisma.user.create({
      data: {
        email,
        name: profile.displayName,
        avatar: profile.photos?.[0]?.value ?? null,
        accounts: {
          create: {
            provider: AccountProvider.GOOGLE,
            providerAccountId: googleId,
          },
        },
      },
    });

    done(null, newUser);
  }
}
