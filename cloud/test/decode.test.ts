import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, REG_COUNT, REG_START } from "../src/decode.ts";

function regs(set: Record<number, number>): number[] {
  const r = new Array(REG_COUNT).fill(0);
  for (const [k, v] of Object.entries(set)) r[Number(k) - REG_START] = v & 0xffff;
  return r;
}

test("grid on + signed battery charge, same rules as the bot", () => {
  const d = decode(REG_START, regs({ 588: 87, 590: -1500, 607: 2300, 650: 400, 651: 500, 652: 600, 653: 1500, 672: 3000, 673: 1200 }));
  assert.equal(d.grid_on, 1);
  assert.equal(d.soc, 87);
  assert.equal(d.batt_w, -1500);
  assert.equal(d.load_total, 1500);
  assert.equal(d.pv_w, 4200);
});

test("grid off when reg 607 is 0; negative 607 counts as on (uint16 > 0, like the bot)", () => {
  assert.equal(decode(REG_START, regs({ 607: 0 })).grid_on, 0);
  const d = decode(REG_START, regs({ 607: -200 }));
  assert.equal(d.grid_on, 1);
  assert.equal(d.grid_w, -200);
});

test("scaled values", () => {
  const d = decode(REG_START, regs({ 598: 2301, 609: 5002 }));
  assert.equal(d.grid_v_a, 230.1);
  assert.equal(d.grid_hz, 50.02);
});

test("short sample throws", () => {
  assert.throws(() => decode(REG_START, [1, 2, 3]));
});
