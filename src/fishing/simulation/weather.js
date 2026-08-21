export const WEATHER_RULES = {
  clear: { key: 'clear', weight: 44, bite: 1.0 },
  cloudy: { key: 'cloudy', weight: 34, bite: 1.12 },
  rain: { key: 'rain', weight: 22, bite: 1.3 },
};

export function weatherBite(key) {
  return WEATHER_RULES[key]?.bite ?? 1;
}

export function nextWeatherKey(currentKey, rng = Math.random) {
  const list = Object.values(WEATHER_RULES);
  let total = 0;
  for (const w of list) total += w.key === currentKey ? w.weight * 0.35 : w.weight;
  let r = rng() * total;
  for (const w of list) {
    r -= w.key === currentKey ? w.weight * 0.35 : w.weight;
    if (r <= 0) return w.key;
  }
  return list[list.length - 1].key;
}

export function nextWeatherHours(rng = Math.random) {
  return 2.5 + rng() * 4;
}

export function initialWeatherHours(rng = Math.random) {
  return 3 + rng() * 3;
}
