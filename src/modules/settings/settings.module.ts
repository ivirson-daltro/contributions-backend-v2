import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { LogoService } from "./logo.service";
import { CatalogsService } from "./catalogs.service";
import { CatalogsController } from "./catalogs.controller";

@Module({ controllers: [SettingsController, CatalogsController], providers: [SettingsService, LogoService, CatalogsService], exports: [LogoService] })
export class SettingsModule {}
