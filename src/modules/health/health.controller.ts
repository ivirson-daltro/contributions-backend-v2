import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Kysely, sql } from "kysely";
import { Public } from "../../common/auth/public.decorator";
import { DATABASE, Database } from "../../common/database/database.module";

@ApiTags("health")
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: Kysely<Database>) {}

  @Get("health")
  @ApiOperation({ summary: "Verifica se o processo esta ativo" })
  getLiveness() {
    return { status: "ok" };
  }

  @Get("health/ready")
  @ApiOperation({ summary: "Verifica se a API consegue acessar o banco" })
  async getReadiness() {
    try {
      await sql`select 1`.execute(this.database);
      return { status: "ok", database: "ok" };
    } catch {
      throw new ServiceUnavailableException({
        status: "error",
        database: "unavailable",
      });
    }
  }
}
