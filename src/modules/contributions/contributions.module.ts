import { Module } from "@nestjs/common";
import { ContributionsController } from "./contributions.controller";
import { ContributionsService } from "./contributions.service";
import { ContributionsReportService } from "./contributions-report.service";
import { SettingsModule } from "../settings/settings.module";

@Module({
  imports: [SettingsModule],
  controllers: [ContributionsController],
  providers: [ContributionsService, ContributionsReportService],
})
export class ContributionsModule {}
