import { Module } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import { environment } from "../../config/env";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SUPABASE_ADMIN } from "./auth.tokens";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: SUPABASE_ADMIN,
      useFactory: () =>
        createClient(
          environment.SUPABASE_URL,
          environment.SUPABASE_SERVICE_KEY,
          {
            auth: { autoRefreshToken: false, persistSession: false },
          },
        ),
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
