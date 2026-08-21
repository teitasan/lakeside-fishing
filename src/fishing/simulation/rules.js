import {
  REAL_FISH, depthFit, swimLayer, bedAffinity, structureBonus, baitPrefMult,
} from '../../data.js';
import { clamp01 } from '../../util.js';

export const LV_FLOOR = 0.008;
export const NEARBY_FISH_R = 18;
export const NEARBY_SPECIES_BONUS = 2.0;

export function speciesWeight(sp, ctx = {}) {
  const {
    depth = 0,
    band = 'day',
    weather = 'clear',
    useBait = false,
    bait = null,
    layer = 'mid',
    bed = null,
    nearStruct = false,
    nearSpecies = null,
    rodAttract = 1,
    level = 1,
  } = ctx;

  let w = sp.spawn || 0;
  if (w <= 0) return 0;
  const fit = depthFit(sp, depth, band);
  if (fit <= 0) return 0;
  w *= fit;
  w *= sp.times?.[band] ?? 1;
  w *= sp.weather?.[weather] ?? 1;

  if (useBait) {
    if (bait) w *= baitPrefMult(sp, bait);
    w *= swimLayer(sp, band)?.[layer] ?? 1;
    const bottomness = layer === 'bottom' ? 1 : layer === 'mid' ? 0.35 : 0.1;
    if (bed) w *= bedAffinity(sp, bed, bottomness);
    if (nearStruct) w *= structureBonus(sp);
    if (bait && sp.rarity >= 3) w *= bait.rare;
    w *= rodAttract;

    const gate = (from, span) => {
      const g = clamp01((level - from) / span);
      return sp.tags.includes('legend') ? g : Math.max(LV_FLOOR, g);
    };
    if (sp.rarity === 4) w *= gate(2, 5);
    if (sp.rarity === 5) w *= gate(5, 6);
    if (nearSpecies?.has?.(sp.id)) w *= NEARBY_SPECIES_BONUS;
  }
  return w;
}

export function pickSpecies(ctx = {}, rng = Math.random, list = REAL_FISH) {
  const weights = list.map((sp) => Math.max(0, speciesWeight(sp, ctx)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1] || null;
}
