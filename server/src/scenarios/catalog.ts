import type { Store, StoredScenario } from "../db/store.js";

/** Scenarios from the database, cached in memory. Admin edits call refresh(). */
export class ScenarioCatalog {
  private all: StoredScenario[] = [];

  constructor(private store: Store) {}

  async refresh(): Promise<void> {
    this.all = await this.store.listScenarios();
  }

  /** Every scenario, including disabled ones (admin view). */
  list(): StoredScenario[] {
    return this.all;
  }

  /** Scenarios learners can see and practice. */
  enabled(): StoredScenario[] {
    return this.all.filter((s) => s.enabled);
  }

  get(id: string): StoredScenario | undefined {
    return this.all.find((s) => s.id === id && s.enabled);
  }
}
