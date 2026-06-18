import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { SessionAuthGuard } from './session-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const user = await this.auth.validateUser(dto.email, dto.password);
    req.session.userId = user.id;
    req.session.actorLabel = user.displayName;
    req.session.mustChangePassword = user.mustChangePassword;

    const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? '12');
    await this.prisma.session
      .create({
        data: {
          id: req.sessionID,
          userId: user.id,
          expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      })
      .catch(() => undefined);

    await this.audit.record({
      action: 'auth.login',
      actorUserId: user.id,
      actorLabel: user.displayName,
      ip: req.ip,
      summary: `Login: ${user.email}`,
    });

    return this.auth.getProfile(user.id);
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    const userId = req.session.userId;
    const sid = req.sessionID;
    if (userId) {
      await this.audit.record({
        action: 'auth.logout',
        actorUserId: userId,
        actorLabel: req.session.actorLabel,
        ip: req.ip,
      });
    }
    await this.prisma.session
      .updateMany({ where: { id: sid }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  async me(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    return this.auth.getProfile(req.session.userId);
  }

  @Post('change-password')
  @UseGuards(SessionAuthGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const userId = req.session.userId as string;
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
    req.session.mustChangePassword = false;
    await this.audit.record({
      action: 'auth.change_password',
      actorUserId: userId,
      actorLabel: req.session.actorLabel,
      ip: req.ip,
    });
    return { ok: true };
  }
}
