#!/usr/bin/env node
// Copia os arquivos dos anexos da v1 para o Storage do projeto NOVO, no layout por tenant:
//   tenants/{tenant_id}/{entidade}/{dono}/{id}-{arquivo}     (o caminho já está em etl.attachment_copy.dst_path)
// Marca etl.attachment_copy.status = COPIED e preenche size_bytes/mime_type em public.attachments.
// Não apaga nada na origem.
//
//   DATABASE_URL                       banco NOVO (dono)
//   SRC_SUPABASE_URL / SRC_SERVICE_KEY / SRC_BUCKET     projeto ANTIGO (v1) e bucket dos anexos
//   DST_SUPABASE_URL / DST_SERVICE_KEY / DST_BUCKET     projeto NOVO e bucket (padrão: SRC_BUCKET)
//
//   node copy-attachments.mjs [--dry-run] [--concurrency=5] [--retry-failed]
//
// Idempotente e reexecutável (rode de novo logo antes do corte para o delta).
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const E = process.env;
const DST_BUCKET = E.DST_BUCKET || E.SRC_BUCKET;
for (const k of ['DATABASE_URL', 'SRC_SUPABASE_URL', 'SRC_SERVICE_KEY', 'SRC_BUCKET', 'DST_SUPABASE_URL', 'DST_SERVICE_KEY']) {
  if (!E[k]) { console.error(`Variável obrigatória ausente: ${k}`); process.exit(1); }
}
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const retryFailed = argv.includes('--retry-failed');
const concurrency = Number((argv.find((a) => a.startsWith('--concurrency=')) ?? '--concurrency=5').split('=')[1]);

const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const src = createClient(E.SRC_SUPABASE_URL, E.SRC_SERVICE_KEY, opts);
const dst = createClient(E.DST_SUPABASE_URL, E.DST_SERVICE_KEY, opts);
const db = new pg.Client({ connectionString: E.DATABASE_URL });

// o caminho da v1 pode ser URL completa; extrai o caminho relativo ao bucket
function legacyObjectPath(p) {
  const m = p.match(/\/object\/(?:public|sign|authenticated)\/[^/]+\/(.+?)(?:\?.*)?$/);
  return decodeURIComponent(m ? m[1] : p.split('?')[0]);
}

async function copyOne(a) {
  if (dryRun) return console.log(`  [dry] ${a.src_path} -> ${a.dst_path}`);
  const { data: blob, error: dErr } = await src.storage.from(E.SRC_BUCKET).download(legacyObjectPath(a.src_path));
  if (dErr) {
    const missing = /not found|404|does not exist/i.test(dErr.message);
    await db.query(`update etl.attachment_copy set status = $2, error = $3, updated_at = now() where attachment_id = $1`,
      [a.attachment_id, missing ? 'MISSING' : 'FAILED', dErr.message]);
    throw new Error(`download ${a.src_path}: ${dErr.message}`);
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const { error: uErr } = await dst.storage.from(DST_BUCKET)
    .upload(a.dst_path, buf, { contentType: blob.type || undefined, upsert: true });
  if (uErr) {
    await db.query(`update etl.attachment_copy set status = 'FAILED', error = $2, updated_at = now() where attachment_id = $1`,
      [a.attachment_id, uErr.message]);
    throw new Error(`upload ${a.dst_path}: ${uErr.message}`);
  }
  await db.query(`update attachments set size_bytes = $2, mime_type = $3 where id = $1`,
    [a.attachment_id, buf.length, blob.type || null]);
  await db.query(`update etl.attachment_copy set status = 'COPIED', error = null, updated_at = now() where attachment_id = $1`,
    [a.attachment_id]);
}

await db.connect();
try {
  const states = retryFailed ? ['PLANNED', 'FAILED', 'MISSING'] : ['PLANNED', 'FAILED'];
  const { rows } = await db.query(
    `select attachment_id, src_path, dst_path from etl.attachment_copy where status = any($1) order by attachment_id`,
    [states]);
  console.log(`${rows.length} arquivo(s) a copiar${dryRun ? ' (DRY-RUN)' : ''}`);

  let ok = 0, failed = 0;
  const queue = [...rows];
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const a = queue.shift();
      try { await copyOne(a); ok++; }
      catch (e) { failed++; console.error(`  FALHA ${a.attachment_id}: ${e.message}`); }
    }
  }));
  console.log({ ok, failed });
  if (failed > 0) process.exitCode = 1;
} finally {
  await db.end();
}
