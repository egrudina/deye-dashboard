// Register decoding for Deye SUN-10K-SG04LP3-EU (3-phase LV hybrid, `deye_p3` map).
// Only 588, 590, 607, 619, 650-653 are proven by the bot. The rest is from the public map
// and must be checked against real data. Raw registers are kept 7 days, so fixes can re-decode.

export const REG_START = 588;
export const REG_COUNT = 88; // 588..675

export interface Decoded {
  grid_on: number;
  soc: number;
  batt_w: number;
  grid_w: number;
  ext_ct_w: number;
  grid_total_w: number;
  grid_v_a: number;
  grid_v_b: number;
  grid_v_c: number;
  grid_hz: number;
  load_a: number;
  load_b: number;
  load_c: number;
  load_total: number;
  pv1_w: number;
  pv2_w: number;
  pv_w: number;
}

export const DECODED_COLUMNS: (keyof Decoded)[] = [
  "grid_on", "soc", "batt_w", "grid_w", "ext_ct_w", "grid_total_w",
  "grid_v_a", "grid_v_b", "grid_v_c", "grid_hz",
  "load_a", "load_b", "load_c", "load_total", "pv1_w", "pv2_w", "pv_w",
];

const s16 = (v: number) => (v >= 0x8000 ? v - 0x10000 : v);

export function decode(start: number, regs: number[]): Decoded {
  const u = (reg: number): number => {
    const v = regs[reg - start];
    if (v === undefined) throw new Error(`register ${reg} not in sample`);
    return v;
  };
  const s = (reg: number) => s16(u(reg));
  const pv1 = u(672), pv2 = u(673);
  return {
    grid_on: u(607) > 0 ? 1 : 0,
    soc: u(588),
    batt_w: s(590),
    grid_w: s(607),
    ext_ct_w: s(619),
    grid_total_w: s(625),
    grid_v_a: u(598) / 10,
    grid_v_b: u(599) / 10,
    grid_v_c: u(600) / 10,
    grid_hz: u(609) / 100,
    load_a: s(650),
    load_b: s(651),
    load_c: s(652),
    load_total: s(653),
    pv1_w: pv1,
    pv2_w: pv2,
    pv_w: pv1 + pv2 + u(674) + u(675),
  };
}
