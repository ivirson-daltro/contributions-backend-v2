import { Module } from "@nestjs/common";
import { MembersController, MemberTypesController } from "./members.controller";
import { MembersService } from "./members.service";
import { ContributorsService } from "./contributors.service";
import { SettingsModule } from "../settings/settings.module";

@Module({
  imports: [SettingsModule],
  controllers: [MembersController, MemberTypesController],
  providers: [MembersService, ContributorsService],
})
export class MembersModule {}
