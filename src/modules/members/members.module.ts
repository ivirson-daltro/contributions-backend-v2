import { Module } from "@nestjs/common";
import { MembersController, MemberTypesController } from "./members.controller";
import { MembersService } from "./members.service";

@Module({
  controllers: [MembersController, MemberTypesController],
  providers: [MembersService],
})
export class MembersModule {}
