import { Module } from "@nestjs/common";
import { ContributionsController } from "./contributions.controller";
import { ContributionsService } from "./contributions.service";
import { ContributionsReportService } from "./contributions-report.service";

@Module({
  controllers: [ContributionsController],
  providers: [ContributionsService, ContributionsReportService],
})
export class ContributionsModule {}
