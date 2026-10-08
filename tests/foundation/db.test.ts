import { createDb, migrate } from "../../server/db.ts";
import { createTestDb, type TestDb } from "../helpers/db.ts";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let handle: TestDb;

beforeEach(async () => {
  handle = await createTestDb();
});
afterEach(async () => {
  await handle.close();
});

async function rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const res = (await handle.db.execute(query)) as unknown as { rows: Record<string, unknown>[] };
  return res.rows;
}

async function insertApp(id: string, extra: { posting_url?: string } = {}) {
  await handle.db.execute(sql`
    insert into applications
      (id, company, role_title, posting_url, work_arrangement, status, discovered_at, created_at, updated_at, updated_by)
    values
      (${id}, 'Acme', 'Engineer', ${extra.posting_url ?? null}, 'remote', 'watching', '2026-10-07',
       '2026-10-07T14:03:22.123Z', '2026-10-07T14:03:22.123Z', 'dakota')`);
}

async function count(table: string, where: string, value: string): Promise<number> {
  const r = await rows(sql.raw(`select count(*)::int as n from ${table} where ${where} = '${value}'`));
  return r[0].n as number;
}

describe("createDb and migrate", () => {
  it("migrate is idempotent: a second and third run do not throw", async () => {
    await expect(migrate(handle.db)).resolves.toBeUndefined();
    await expect(migrate(handle.db)).resolves.toBeUndefined();
  });

  it("creates all five tables", async () => {
    const r = await rows(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('applications','events','contacts','application_contacts','settings')
      order by table_name`);
    expect(r.map((x) => x.table_name)).toEqual([
      "application_contacts",
      "applications",
      "contacts",
      "events",
      "settings",
    ]);
  });

  it("seeds settings with comp_floor = 150000", async () => {
    const r = await rows(sql`select key, value from settings order by key`);
    expect(r).toEqual([{ key: "comp_floor", value: 150000 }]);
  });

  it("each createDb('pglite://memory') is an isolated database", async () => {
    await insertApp("iso--one--2026-10-07");
    const other = await createDb("pglite://memory");
    try {
      await migrate(other.db);
      const res = (await other.db.execute(sql`select count(*)::int as n from applications`)) as unknown as {
        rows: { n: number }[];
      };
      expect(res.rows[0].n).toBe(0);
    } finally {
      await other.close();
    }
  });

  it("enforces unique posting_url", async () => {
    await insertApp("a--one--2026-10-07", { posting_url: "https://example.com/jobs/1" });
    await expect(insertApp("b--two--2026-10-07", { posting_url: "https://example.com/jobs/1" })).rejects.toThrow();
    expect(await count("applications", "id", "b--two--2026-10-07")).toBe(0);
  });

  it("allows many applications with a null posting_url", async () => {
    await insertApp("a--one--2026-10-07");
    await insertApp("b--two--2026-10-07");
    const r = await rows(sql`select count(*)::int as n from applications`);
    expect(r[0].n).toBe(2);
  });

  it("deleting an application cascades to its events and application_contacts rows", async () => {
    await insertApp("acme--eng--2026-10-07");
    await handle.db.execute(sql`
      insert into events (application_id, at, type, by)
      values ('acme--eng--2026-10-07', '2026-10-07T14:03:22.123Z', 'discovered', 'dakota')`);
    await handle.db.execute(sql`
      insert into contacts (id, name, created_at, updated_at, updated_by)
      values ('jane', 'Jane', '2026-10-07T14:03:22.123Z', '2026-10-07T14:03:22.123Z', 'dakota')`);
    await handle.db.execute(sql`
      insert into application_contacts (application_id, contact_id) values ('acme--eng--2026-10-07', 'jane')`);
    expect(await count("events", "application_id", "acme--eng--2026-10-07")).toBe(1);
    expect(await count("application_contacts", "application_id", "acme--eng--2026-10-07")).toBe(1);

    await handle.db.execute(sql`delete from applications where id = 'acme--eng--2026-10-07'`);

    expect(await count("events", "application_id", "acme--eng--2026-10-07")).toBe(0);
    expect(await count("application_contacts", "application_id", "acme--eng--2026-10-07")).toBe(0);
    expect(await count("contacts", "id", "jane")).toBe(1);
  });

  it("deleting a contact cascades to application_contacts but keeps the application", async () => {
    await insertApp("acme--eng--2026-10-07");
    await handle.db.execute(sql`
      insert into contacts (id, name, created_at, updated_at, updated_by)
      values ('jane', 'Jane', '2026-10-07T14:03:22.123Z', '2026-10-07T14:03:22.123Z', 'dakota')`);
    await handle.db.execute(sql`
      insert into application_contacts (application_id, contact_id) values ('acme--eng--2026-10-07', 'jane')`);
    await handle.db.execute(sql`delete from contacts where id = 'jane'`);
    expect(await count("application_contacts", "contact_id", "jane")).toBe(0);
    expect(await count("applications", "id", "acme--eng--2026-10-07")).toBe(1);
  });

  it("generates an event id and defaults extra to {}", async () => {
    await insertApp("acme--eng--2026-10-07");
    await handle.db.execute(sql`
      insert into events (application_id, at, type, by)
      values ('acme--eng--2026-10-07', '2026-10-07T14:03:22.123Z', 'note', 'dakota')`);
    const e = await rows(sql`select id::text as id from events`);
    expect(String(e[0].id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const a = await rows(sql`select extra from applications`);
    expect(a[0].extra).toEqual({});
  });

  it("keeps millisecond precision for updated_at through a round trip", async () => {
    await insertApp("acme--eng--2026-10-07");
    const r = await rows(sql`
      select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as u,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as c
      from applications`);
    expect(r).toEqual([{ u: "2026-10-07T14:03:22.123Z", c: "2026-10-07T14:03:22.123Z" }]);
  });

  it("declares timestamp(3) on updated_at and created_at", async () => {
    const r = await rows(sql`
      select column_name, datetime_precision from information_schema.columns
      where table_name = 'applications' and column_name in ('created_at','updated_at')
      order by column_name`);
    expect(r).toEqual([
      { column_name: "created_at", datetime_precision: 3 },
      { column_name: "updated_at", datetime_precision: 3 },
    ]);
  });

  it("declares timestamp(3) on events.at and the contacts timestamps", async () => {
    const r = await rows(sql`
      select table_name, column_name, datetime_precision from information_schema.columns
      where (table_name = 'events' and column_name = 'at')
         or (table_name = 'contacts' and column_name in ('created_at','updated_at'))
      order by table_name, column_name`);
    expect(r).toEqual([
      { table_name: "contacts", column_name: "created_at", datetime_precision: 3 },
      { table_name: "contacts", column_name: "updated_at", datetime_precision: 3 },
      { table_name: "events", column_name: "at", datetime_precision: 3 },
    ]);
  });

  it("creates the spec C indexes", async () => {
    const r = await rows(sql`
      select tablename, indexdef from pg_indexes where schemaname = 'public'
      and tablename in ('applications','events')`);
    const defs = r.map((x) => `${x.tablename}: ${x.indexdef}`);
    for (const col of ["status", "next_action_due", "follow_up_date", "updated_at"]) {
      expect(
        defs.some((d) => d.startsWith("applications: ") && new RegExp(`\\(\\"?${col}\\"?\\)`).test(d)),
        `applications index on ${col}`,
      ).toBe(true);
    }
    expect(
      defs.some((d) => d.startsWith("events: ") && /\("?application_id"?, "?at"?\)/.test(d)),
      "events index on (application_id, at)",
    ).toBe(true);
  });
});

describe("createDb on-disk PGlite with a missing parent directory", () => {
  async function roundTrip(url: string, dir: string) {
    const first = await createDb(url);
    try {
      await migrate(first.db);
      await first.db.execute(sql`update settings set value = '175000'::jsonb where key = 'comp_floor'`);
    } finally {
      await first.close();
    }
    expect(existsSync(dir)).toBe(true);

    const second = await createDb(url);
    try {
      await migrate(second.db);
      const res = (await second.db.execute(sql`select value from settings where key = 'comp_floor'`)) as unknown as {
        rows: { value: unknown }[];
      };
      expect(res.rows).toEqual([{ value: 175000 }]);
    } finally {
      await second.close();
    }
  }

  it("creates every missing parent of an absolute path, and the data persists on reopen", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "jt-pglite-"));
    try {
      const dir = join(tmp, "does", "not", "exist", "yet", "db");
      await roundTrip(`pglite://${dir}`, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("creates every missing parent of a relative path (resolved against the cwd)", async () => {
    const rel = `.tmp-pglite-test-${process.pid}-${Date.now()}`;
    try {
      const relDir = `${rel}/a/b/db`;
      await roundTrip(`pglite://${relDir}`, join(process.cwd(), relDir));
    } finally {
      await rm(join(process.cwd(), rel), { recursive: true, force: true });
    }
  });

  it("pglite://memory creates no 'memory' entry in the cwd", async () => {
    const target = join(process.cwd(), "memory");
    expect(existsSync(target)).toBe(false);
    const h = await createDb("pglite://memory");
    try {
      await migrate(h.db);
    } finally {
      await h.close();
    }
    expect(existsSync(target)).toBe(false);
  });

  it("a regular file at the pglite path makes createDb reject with an error naming the path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "jt-pglite-file-"));
    try {
      const file = join(tmp, "not-a-dir");
      await writeFile(file, "x");
      await expect(createDb(`pglite://${file}`)).rejects.toThrow(file);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
