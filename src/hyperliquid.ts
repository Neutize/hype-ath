export const HYPE_SPOT_COIN = "@107";
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";

type MidsResponse = Record<string, string>;
const INFO_TIMEOUT_MS = 10_000;
const DAY_MS = 1000 * 60 * 60 * 24;
const CHART_LOOKBACK_MS_BY_INTERVAL: Record<ChartInterval, number> = {
  "1m": DAY_MS,
  "15m": DAY_MS * 14,
  "4h": DAY_MS * 120,
};

export type Candle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

export type AthSnapshot = {
  allTimeHigh: number;
  allTimeHighDay: string;
  hitNewAthToday: boolean;
  priorAth: number;
  todayHigh: number;
  utcDay: string;
};

export type ChartCandle = {
  close: number;
  high: number;
  low: number;
  open: number;
  time: number;
};

export type ChartInterval = "1m" | "15m" | "4h";

async function postInfo<TResponse>(body: unknown): Promise<TResponse> {
  await applyDevDelay();

  const devFailure = getDevFailureMode(body);

  if (devFailure) {
    throw new Error(devFailure);
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), INFO_TIMEOUT_MS);

  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid returned ${response.status}`);
    }

    return response.json() as Promise<TResponse>;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Hyperliquid request timed out");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchCurrentSpotPrice(): Promise<number> {
  const mids = await postInfo<MidsResponse>({ type: "allMids" });
  const rawPrice = mids[HYPE_SPOT_COIN];
  const price = Number(rawPrice);

  if (!Number.isFinite(price)) {
    throw new Error("HYPE spot price is unavailable");
  }

  return price;
}

export async function fetchAthSnapshot(now = Date.now()): Promise<AthSnapshot> {
  const rawCandles = await postInfo<Candle[]>({
    type: "candleSnapshot",
    req: {
      coin: HYPE_SPOT_COIN,
      interval: "1d",
      startTime: 0,
      endTime: now,
    },
  });
  const candles = normalizeCandles(rawCandles);

  if (candles.length === 0) {
    throw new Error("HYPE candle history is unavailable");
  }

  const currentDayStart = getUtcDayStart(now);
  const todayCandles = candles.filter((candle) => Number(candle.t) >= currentDayStart);
  const priorCandles = candles.filter((candle) => Number(candle.t) < currentDayStart);
  const activeTodayCandles = todayCandles.length > 0 ? todayCandles : [candles[candles.length - 1]];
  const priorAth = maxHigh(priorCandles);
  const todayHigh = maxHigh(activeTodayCandles);
  const allTimeCandle = candles.reduce((best, candle) =>
    Number(candle.h) > Number(best.h) ? candle : best,
  );
  const allTimeHigh = Number(allTimeCandle.h);

  return {
    allTimeHigh,
    allTimeHighDay: toIsoDate(allTimeCandle.t),
    hitNewAthToday: Number.isFinite(priorAth) ? todayHigh > priorAth : todayHigh >= allTimeHigh,
    priorAth,
    todayHigh,
    utcDay: toIsoDate(currentDayStart),
  };
}

export async function fetchSpotChartCandles(interval: ChartInterval = "4h", now = Date.now()): Promise<ChartCandle[]> {
  const rawCandles = await postInfo<Candle[]>({
    type: "candleSnapshot",
    req: {
      coin: HYPE_SPOT_COIN,
      interval,
      startTime: Math.max(0, now - CHART_LOOKBACK_MS_BY_INTERVAL[interval]),
      endTime: now,
    },
  });
  const candles = normalizeCandles(rawCandles)
    .map(toChartCandle)
    .filter((candle): candle is ChartCandle => candle !== undefined)
    .sort((a, b) => a.time - b.time);
  const uniqueByTime = new Map<number, ChartCandle>();

  for (const candle of candles) {
    uniqueByTime.set(candle.time, candle);
  }

  return [...uniqueByTime.values()];
}

export function formatUsd(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return "$--";
  }

  const safeValue = Number(value);
  const maximumFractionDigits = safeValue >= 100 ? 2 : safeValue >= 1 ? 4 : 6;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(safeValue);
}

function maxHigh(candles: Candle[]): number {
  return candles.reduce((max, candle) => Math.max(max, Number(candle.h)), Number.NEGATIVE_INFINITY);
}

function normalizeCandles(candles: Candle[]): Candle[] {
  if (!Array.isArray(candles)) {
    return [];
  }

  return candles.filter((candle) => {
    const values = [candle.t, candle.o, candle.h, candle.l, candle.c].map(Number);

    return values.every(Number.isFinite);
  });
}

function toChartCandle(candle: Candle): ChartCandle | undefined {
  const time = Math.floor(Number(candle.t) / 1000);
  const open = Number(candle.o);
  const high = Number(candle.h);
  const low = Number(candle.l);
  const close = Number(candle.c);

  if (![time, open, high, low, close].every(Number.isFinite)) {
    return undefined;
  }

  return {
    close,
    high,
    low,
    open,
    time,
  };
}

function getDevFailureMode(body: unknown): string | undefined {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return undefined;
  }

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mockMarket");

  if (!mode) {
    return undefined;
  }

  if (mode === "all") {
    return "Simulated Hyperliquid outage";
  }

  if (mode === "price" && isInfoType(body, "allMids")) {
    return "Simulated price outage";
  }

  if (mode === "history" && isInfoType(body, "candleSnapshot")) {
    return "Simulated candle history outage";
  }

  return undefined;
}

function isInfoType(body: unknown, type: string): boolean {
  return Boolean(body && typeof body === "object" && "type" in body && body.type === type);
}

async function applyDevDelay(): Promise<void> {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const explicitDelay = Number(params.get("mockDelay"));
  const delayMs =
    Number.isFinite(explicitDelay) && explicitDelay > 0
      ? Math.min(explicitDelay, 8_000)
      : params.get("mockMarket") === "slow"
        ? 4_000
        : 0;

  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function getUtcDayStart(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function toIsoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
