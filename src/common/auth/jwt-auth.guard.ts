import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { environment } from "../../config/env";
import { AuthenticatedRequest } from "./authenticated-user";
import { OPTIONAL_AUTH_KEY } from "./optional-auth.decorator";
import { IS_PUBLIC_KEY } from "./public.decorator";

const supabaseJwks = createRemoteJWKSet(new URL(environment.SUPABASE_JWKS_URL));

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const optionalAuth = this.reflector.getAllAndOverride<boolean>(
      OPTIONAL_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const bearerMatch = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? "",
    );
    const token = bearerMatch?.[1];

    if (!token) {
      if (optionalAuth) return true;
      throw new UnauthorizedException({ code: "UNAUTHENTICATED" });
    }

    try {
      const { payload } = await jwtVerify(token, supabaseJwks, {
        issuer: `${environment.SUPABASE_URL}/auth/v1`,
        audience: "authenticated",
      });

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("Missing subject claim");
      }

      request.authenticatedUser = {
        userId: payload.sub,
        ...(typeof payload.aal === "string" ? { aal: payload.aal } : {}),
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      };
      return true;
    } catch {
      throw new UnauthorizedException({ code: "UNAUTHENTICATED" });
    }
  }
}
