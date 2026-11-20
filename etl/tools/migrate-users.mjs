#!/usr/bin/env node
// Cria no Supabase Auth do projeto NOVO os usuários da v1 e depois liga associações/perfis (etl.link_users()).
//
//   DATABASE_URL=postgres://postgres:...@host:5432/postgres   (banco NOVO, conexão direta, dono)
//   SUPABASE_URL=https://<ref-novo>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=...
//
//   node migrate-users.mjs [--mode=create|keep-passwords|invite] [--dry-run]
//
//   create          (padrão) cria usuários confirmados, SEM senha e SEM e-mail. Seguro em ensaio.
//   keep-passwords  importa o hash bcrypt da v1 (legacy.app_users.password_hash). Teste antes no projeto de ensaio.
//   invite          envia e-mail de convite (dia do corte; defina INVITE_REDIRECT_URL).
//
// Idempotente: quem já existe no Auth é ignorado; etl.link_users() também é idempotente.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INVITE_REDIRECT_URL } = process.env;
for (const [k, v] of Object.entries({ DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Variável obrigatória ausente: ${k}`); process.exit(1); }
}
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const mode = (argv.find((a) => a.startsWith('--mode=')) ?? '--mode=create').split('=')[1];
if (!['create', 'keep-passwords', 'invite'].includes(mode)) {
  console.error('--mode deve ser create, keep-passwords ou invite'); process.exit(1);
}

const db = new pg.Client({ connectionString: DATABASE_URL });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

await db.connect();
try {
  const { rows } = await db.query(`
    select r.app_user_id, r.email, r.name, u.password_hash
      from etl.user_report r
      join legacy.app_users u on u.id = r.app_user_id
     where r.status = 'NO_AUTH_USER'
     order by r.email`);
  console.log(`${rows.length} usuário(s) a criar no Auth (modo ${mode}${dryRun ? ', DRY-RUN' : ''})`);

  let created = 0, existing = 0, failed = 0;
  for (const r of rows) {
    if (dryRun) { console.log(`  [dry] ${r.email}`); continue; }
    let error;
    if (mode === 'invite') {
      ({ error } = await admin.auth.admin.inviteUserByEmail(r.email, {
        data: { name: r.name }, redirectTo: INVITE_REDIRECT_URL,
      }));
    } else {
      const payload = { email: r.email, email_confirm: true, user_metadata: { name: r.name } };
      if (mode === 'keep-passwords') payload.password_hash = r.password_hash;
      ({ error } = await admin.auth.admin.createUser(payload));
    }
    if (!error) created++;
    else if (/already (been )?registered|already exists/i.test(error.message)) existing++;
    else { failed++; console.error(`  FALHA ${r.email}: ${error.message}`); }
  }
  console.log({ created, existing, failed });
  if (failed > 0) process.exitCode = 1;

  if (!dryRun) {
    const res = await db.query('select * from etl.link_users()');
    console.log('Situação após criar associações:');
    console.table(res.rows);
  }
} finally {
  await db.end();
}
