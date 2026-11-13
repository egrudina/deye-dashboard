// Push notifications (step 6). Placeholder until then: nothing is sent.
import type { GridTransition } from "./ingest.ts";
import type { ScheduleChange } from "./jobs.ts";

export async function onIngest(_env: Env, _t: GridTransition[]): Promise<void> {}
export async function onCron(_env: Env, _now: number, _changes: ScheduleChange[]): Promise<unknown> { return null; }
export async function pushEndpoints(_r: Request, _env: Env, _url: URL, _email: string, _body: unknown): Promise<Response | null> { return null; }
