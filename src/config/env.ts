import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SUPABASE_DB_URL: z.string().url(),
  SUPABASE_DB_OWNER_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWKS_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_BUCKET: z.string().min(1).default("attachments"),
  APP_BASE_DOMAIN: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:4200"),
  WORKER: z.enum(["true", "false"]).default("false"),
});

export const environment = environmentSchema.parse(process.env);
