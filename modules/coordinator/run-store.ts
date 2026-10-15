import type { Pool } from "pg";
export type RunStep = {
  source: "crm" | "mercado";
  operationId: string;
  payload: Record<string, unknown>;
  state: string;
  receipt?: unknown;
};
export interface RunStore {
  create(
    owner: string,
    id: string,
    input: unknown,
    steps: RunStep[],
  ): Promise<void>;
  get(
    owner: string,
    id: string,
  ): Promise<{ id: string; steps: RunStep[]; updated_at: unknown }>;
  claim(
    owner: string,
    id: string,
    lease: string,
  ): Promise<RunStep[] | undefined>;
  save(id: string, lease: string, steps: RunStep[]): Promise<void>;
  release(id: string, lease: string): Promise<void>;
}
export class PostgresRunStore implements RunStore {
  constructor(private pool: Pool) {}
  async create(owner: string, id: string, input: unknown, steps: RunStep[]) {
    await this.pool.query(
      "INSERT INTO marketplace_runs(id,owner_id,input,steps) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [id, owner, input, JSON.stringify(steps)],
    );
    const row = (
      await this.pool.query(
        "SELECT input=$3::jsonb AS same FROM marketplace_runs WHERE id=$1 AND owner_id=$2",
        [id, owner, input],
      )
    ).rows[0];
    if (!row?.same) throw Error("Run ID conflict");
  }
  async get(owner: string, id: string) {
    const row = (
      await this.pool.query(
        "SELECT id,steps,updated_at FROM marketplace_runs WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!row) throw Error("Run not found");
    return row;
  }
  async claim(owner: string, id: string, lease: string) {
    return (
      await this.pool.query(
        "UPDATE marketplace_runs SET lease=$3,lease_until=now()+interval '90 seconds' WHERE id=$1 AND owner_id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING steps",
        [id, owner, lease],
      )
    ).rows[0]?.steps;
  }
  async save(id: string, lease: string, steps: RunStep[]) {
    await this.pool.query(
      "UPDATE marketplace_runs SET steps=$3,updated_at=now() WHERE id=$1 AND lease=$2",
      [id, lease, JSON.stringify(steps)],
    );
  }
  async release(id: string, lease: string) {
    await this.pool.query(
      "UPDATE marketplace_runs SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2",
      [id, lease],
    );
  }
}
