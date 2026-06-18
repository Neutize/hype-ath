import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AthSnapshot,
  fetchAthSnapshot,
  fetchCurrentSpotPrice,
  fetchSpotStats,
  formatUsd,
  HYPE_SPOT_COIN,
  HYPERLIQUID_WS_URL,
  type SpotStats,
} from "./hyperliquid";
import { HypeChart } from "./HypeChart";
import { Analytics } from "@vercel/analytics/react";

type RequestStatus = "loading" | "ready" | "stale" | "error";
type PriceDirection = "up" | "down";

type MarketState = {
  ath?: AthSnapshot;
  isOnline: boolean;
  isRefreshing: boolean;
  lastUpdated?: number;
  lastPriceAt?: number;
  lastSnapshotAt?: number;
  liveStatus: "connecting" | "connected" | "reconnecting";
  price?: number;
  priceError?: string;
  priceStatus: RequestStatus;
  snapshotError?: string;
  snapshotStatus: RequestStatus;
  stats?: SpotStats;
  statsError?: string;
  statsStatus: RequestStatus;
};

type HyperliquidWsMessage = {
  channel?: string;
  data?: unknown;
};

const TRADE_URL = "https://app.hyperliquid.xyz/join/NEUTIZE";
const PRICE_FALLBACK_INTERVAL_MS = 12_000;
const RECONNECT_DELAY_MS = 2_500;
const CHART_SCROLL_DELAY_MS = 90;
const CHART_SCROLL_DURATION_MS = 920;
const PRICE_COUNTER_DURATION_MS = 620;
const SNAPSHOT_REFRESH_INTERVAL_MS = 60_000;

const getInitialMarket = (): MarketState => ({
  isOnline: getOnlineStatus(),
  isRefreshing: false,
  liveStatus: "connecting",
  priceStatus: "loading",
  snapshotStatus: "loading",
  statsStatus: "loading",
});

export default function App() {
  const [market, setMarket] = useState<MarketState>(getInitialMarket);
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [displayPrice, setDisplayPrice] = useState<number | undefined>();
  const [priceMotion, setPriceMotion] = useState<{ direction?: PriceDirection; pulse: number }>({ pulse: 0 });
  const cursorCloudRef = useRef<HTMLDivElement | null>(null);
  const displayPriceRef = useRef<number | undefined>(undefined);
  const pendingChartScrollRef = useRef<(() => void) | undefined>(undefined);
  const priceAnimationFrameRef = useRef<number | undefined>(undefined);
  const previousPriceRef = useRef<number | undefined>(undefined);
  const scrollCleanupRef = useRef<(() => void) | undefined>(undefined);

  const refreshMarket = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setMarket((current) => ({
        ...current,
        isRefreshing: true,
        priceStatus: current.price ? current.priceStatus : "loading",
        snapshotStatus: current.ath ? current.snapshotStatus : "loading",
        statsStatus: current.stats ? current.statsStatus : "loading",
      }));
    }

    const [athResult, priceResult, statsResult] = await Promise.allSettled([
      fetchAthSnapshot(),
      fetchCurrentSpotPrice(),
      fetchSpotStats(),
    ]);
    const refreshedAt = Date.now();

    setMarket((current) => {
      const next: MarketState = {
        ...current,
        isRefreshing: false,
        lastUpdated: refreshedAt,
      };

      if (athResult.status === "fulfilled") {
        next.ath = athResult.value;
        next.lastSnapshotAt = refreshedAt;
        next.snapshotError = undefined;
        next.snapshotStatus = "ready";
      } else {
        next.snapshotError = "ATH history is temporarily unavailable.";
        next.snapshotStatus = current.ath ? "stale" : "error";
      }

      if (statsResult.status === "fulfilled") {
        next.stats = statsResult.value;
        next.statsError = undefined;
        next.statsStatus = "ready";
      } else {
        next.statsError = "HYPE market stats are temporarily unavailable.";
        next.statsStatus = current.stats ? "stale" : "error";
      }

      if (priceResult.status === "fulfilled") {
        return foldPriceIntoState(next, priceResult.value, false, refreshedAt);
      }

      next.priceError = current.price
        ? "Showing the last price while live data reconnects."
        : "Live price is temporarily unavailable.";
      next.priceStatus = current.price ? "stale" : "error";

      return next;
    });
  }, []);

  useEffect(() => {
    void refreshMarket(true);
    const refreshId = window.setInterval(() => void refreshMarket(false), SNAPSHOT_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(refreshId);
  }, [refreshMarket]);

  useEffect(() => {
    const handleOnline = () => {
      setMarket((current) => ({ ...current, isOnline: true }));
      void refreshMarket(true);
    };

    const handleOffline = () => {
      setMarket((current) => ({
        ...current,
        isOnline: false,
        liveStatus: "reconnecting",
        priceStatus: current.price ? "stale" : "error",
        snapshotStatus: current.ath ? "stale" : "error",
        statsStatus: current.stats ? "stale" : "error",
      }));
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshMarket]);

  useEffect(() => {
    let closedByApp = false;
    let reconnectId: number | undefined;
    let socket: WebSocket | undefined;

    if (shouldMockLiveFeed()) {
      setMarket((current) => ({
        ...current,
        liveStatus: "reconnecting",
      }));

      return () => {
        closedByApp = true;
      };
    }

    const applyPrice = (price: number) => {
      setMarket((current) => foldPriceIntoState(current, price, true));
    };

    const connect = () => {
      setMarket((current) => ({
        ...current,
        liveStatus: current.price ? "reconnecting" : "connecting",
      }));

      socket = new WebSocket(HYPERLIQUID_WS_URL);

      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
        socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: HYPE_SPOT_COIN } }));
      });

      socket.addEventListener("message", (event) => {
        const message = safeParseMessage(event.data);
        const price = message ? readHypePrice(message) : undefined;

        if (price !== undefined) {
          applyPrice(price);
        }
      });

      socket.addEventListener("error", () => {
        setMarket((current) => ({
          ...current,
          liveStatus: "reconnecting",
          priceStatus: current.price ? "stale" : current.priceStatus,
        }));
      });

      socket.addEventListener("close", () => {
        if (!closedByApp) {
          setMarket((current) => ({
            ...current,
            liveStatus: "reconnecting",
            priceStatus: current.price ? "stale" : current.priceStatus,
          }));
          reconnectId = window.setTimeout(connect, RECONNECT_DELAY_MS);
        }
      });
    };

    connect();

    const fallbackId = window.setInterval(async () => {
      try {
        applyPrice(await fetchCurrentSpotPrice());
      } catch {
        setMarket((current) => ({
          ...current,
          priceError: current.price
            ? "Showing the last price while live data reconnects."
            : "Live price is temporarily unavailable.",
          priceStatus: current.price ? "stale" : "error",
        }));
      }
    }, PRICE_FALLBACK_INTERVAL_MS);

    return () => {
      closedByApp = true;
      window.clearInterval(fallbackId);
      if (reconnectId) {
        window.clearTimeout(reconnectId);
      }
      socket?.close();
    };
  }, []);

  useEffect(
    () => () => {
      pendingChartScrollRef.current?.();
      if (priceAnimationFrameRef.current) {
        window.cancelAnimationFrame(priceAnimationFrameRef.current);
      }
      scrollCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const price = Number(market.price);

    if (!Number.isFinite(price)) {
      return;
    }

    const previousPrice = previousPriceRef.current;

    if (previousPrice !== undefined && Math.abs(price - previousPrice) > 0.0000001) {
      setPriceMotion((current) => ({
        direction: price > previousPrice ? "up" : "down",
        pulse: current.pulse + 1,
      }));
    }

    previousPriceRef.current = price;

    const startingPrice = displayPriceRef.current;

    if (startingPrice === undefined) {
      displayPriceRef.current = price;
      setDisplayPrice(price);
      return;
    }

    if (Math.abs(price - startingPrice) <= 0.0000001) {
      return;
    }

    if (priceAnimationFrameRef.current) {
      window.cancelAnimationFrame(priceAnimationFrameRef.current);
    }

    const animationStart = window.performance.now();
    const priceDelta = price - startingPrice;

    const stepPrice = (timestamp: number) => {
      const progress = Math.min((timestamp - animationStart) / PRICE_COUNTER_DURATION_MS, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const nextPrice = startingPrice + priceDelta * easedProgress;

      displayPriceRef.current = progress >= 1 ? price : nextPrice;
      setDisplayPrice(displayPriceRef.current);

      if (progress < 1) {
        priceAnimationFrameRef.current = window.requestAnimationFrame(stepPrice);
        return;
      }

      priceAnimationFrameRef.current = undefined;
    };

    priceAnimationFrameRef.current = window.requestAnimationFrame(stepPrice);
  }, [market.price]);

  useEffect(() => {
    const cloud = cursorCloudRef.current;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

    if (!cloud || prefersReducedMotion || coarsePointer) {
      return;
    }

    let frameId: number | undefined;
    let currentX = 0;
    let currentY = 0;
    let hasPosition = false;
    let isVisible = false;
    let targetX = 0;
    let targetY = 0;

    const followPointer = () => {
      currentX += (targetX - currentX) * 0.115;
      currentY += (targetY - currentY) * 0.115;
      cloud.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      frameId = window.requestAnimationFrame(followPointer);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }

      targetX = event.clientX;
      targetY = event.clientY;

      if (!hasPosition) {
        hasPosition = true;
        currentX = targetX;
        currentY = targetY;
        cloud.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      }

      if (!isVisible) {
        isVisible = true;
        cloud.dataset.visible = "true";
        frameId = window.requestAnimationFrame(followPointer);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  const answer = market.ath?.hitNewAthToday;
  const isAnswerLoading = answer === undefined && market.snapshotStatus === "loading";
  const isPriceLoading = displayPrice === undefined && market.priceStatus === "loading";
  const answerText = answer === undefined ? "..." : answer ? "Yes." : "No";
  const answerClass = [
    "answer",
    answer === false ? "no" : answer === true ? "yes" : "pending",
    isAnswerLoading ? "is-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const priceClass = ["price", displayPrice === undefined ? "price-pending" : ""].filter(Boolean).join(" ");
  const priceText = useMemo(() => formatUsd(displayPrice), [displayPrice]);
  const priceValueClass = [
    "price-value",
    priceMotion.direction === "up" ? "tick-up" : priceMotion.direction === "down" ? "tick-down" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const notice = getMarketNotice(market);
  const answerNotice = market.snapshotStatus === "error" ? notice : undefined;
  const secondaryNotice = answerNotice ? undefined : notice;
  const isBusy = isAnswerLoading || isPriceLoading || market.isRefreshing;
  const marketCap = useMemo(() => {
    if (market.stats?.circulatingSupply !== undefined && displayPrice !== undefined) {
      return market.stats.circulatingSupply * displayPrice;
    }

    return market.stats?.marketCap;
  }, [displayPrice, market.stats]);
  const statusText = getMarketStatus(market);
  useEffect(() => {
    if (!isChartOpen) {
      return;
    }

    pendingChartScrollRef.current?.();
    pendingChartScrollRef.current = scheduleChartScroll(scrollCleanupRef);

    return () => {
      pendingChartScrollRef.current?.();
      pendingChartScrollRef.current = undefined;
    };
  }, [isChartOpen]);

  const toggleChart = useCallback(() => {
    pendingChartScrollRef.current?.();
    scrollCleanupRef.current?.();

    if (!isChartOpen) {
      setIsChartOpen(true);
      return;
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion || getPageScroll() < 2) {
      setIsChartOpen(false);
      return;
    }

    scrollCleanupRef.current = animateWindowScroll(getPageScroll(), 0, CHART_SCROLL_DURATION_MS, () => {
      scrollCleanupRef.current = undefined;
      setIsChartOpen(false);
    });
  }, [isChartOpen]);

  return (
    <main className={isChartOpen ? "page-shell has-chart" : "page-shell"}>
      <div className="cursor-cloud" ref={cursorCloudRef} aria-hidden="true" />
      <div className="logo-field" aria-hidden="true">
        <div className="logo-mark logo-mark-a" />
        <div className="logo-mark logo-mark-b" />
        <div className="logo-mark logo-mark-c" />
      </div>

      <header className="topbar" aria-label="HYPE market summary">
        <div className="topbar-brand" aria-label="HYPE">
          <span className="topbar-mark" aria-hidden="true" />
          <span>$HYPE</span>
        </div>
        <div className="topbar-stats">
          <MarketStat
            label="ATH"
            value={market.ath ? formatUsd(market.ath.allTimeHigh) : undefined}
            detail={market.ath ? `set ${formatAthDate(market.ath.allTimeHighDay)}` : undefined}
            title={market.ath ? `Set ${formatAthDate(market.ath.allTimeHighDay)}` : undefined}
          />
          <MarketStat label="MCap" value={formatCompactUsd(marketCap, 2)} />
          <MarketStat label="24h Vol" value={formatCompactUsd(market.stats?.volume24h)} />
        </div>
        <div className="live-pill" data-live={market.liveStatus === "connected"}>
          <span className="live-dot" aria-hidden="true" />
          <span>{market.liveStatus === "connected" ? "Live" : "Syncing"}</span>
        </div>
      </header>

      <section className="content-stack" aria-busy={isBusy} aria-live="polite">
        <h1>
          Did <span className="ticker-highlight">$HYPE</span> hit a new ATH today?
        </h1>
        {answerNotice ? (
          <div className="market-notice answer-notice" role="status">
            <div>
              <strong>{answerNotice.title}</strong>
              <span>{answerNotice.body}</span>
            </div>
            <button type="button" onClick={() => void refreshMarket(true)} disabled={market.isRefreshing}>
              {market.isRefreshing ? "Checking" : "Retry"}
            </button>
          </div>
        ) : (
          <p className={answerClass} aria-label={isAnswerLoading ? "ATH check loading" : answerText}>
            {isAnswerLoading ? <span className="shimmer answer-shimmer" aria-hidden="true" /> : answerText}
          </p>
        )}
        <div className="price-stack">
          <p className={priceClass}>
            <span className="price-label">Current price:</span>{" "}
            {isPriceLoading ? (
              <span className="shimmer price-shimmer" aria-hidden="true" />
            ) : (
              <>
                <span className={priceValueClass} key={priceMotion.pulse}>
                  {priceText}
                </span>
                <span className="price-direction" data-direction={priceMotion.direction} aria-hidden="true">
                  {priceMotion.direction === "up" ? "▲" : priceMotion.direction === "down" ? "▼" : ""}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="actions-stack">
          <a className="trade-button" href={TRADE_URL} target="_blank" rel="noreferrer">
            <span>Trade</span>
            <span className="trade-arrow" aria-hidden="true">
              →
            </span>
          </a>
          <button
            className="chart-link"
            type="button"
            aria-controls="hype-chart-panel"
            aria-expanded={isChartOpen}
            onClick={toggleChart}
          >
            <span>{isChartOpen ? "Hide chart" : "Show chart"}</span>
            <svg className="chart-arrow" viewBox="0 0 16 10" aria-hidden="true">
              <path d="M2 2L8 8L14 2" />
            </svg>
          </button>
        </div>
        {secondaryNotice ? (
          <div className="market-notice" role="status">
            <div>
              <strong>{secondaryNotice.title}</strong>
              <span>{secondaryNotice.body}</span>
            </div>
            <button type="button" onClick={() => void refreshMarket(true)} disabled={market.isRefreshing}>
              {market.isRefreshing ? "Checking" : "Retry"}
            </button>
          </div>
        ) : null}
      </section>

      <div className="chart-region">
        <HypeChart latestPrice={market.price} visible={isChartOpen} />
      </div>

      <p className="visually-hidden">{statusText}</p>
      <Analytics />
    </main>
  );
}

function MarketStat({ detail, label, title, value }: { detail?: string; label: string; title?: string; value?: string }) {
  return (
    <div className="topbar-stat" title={title}>
      <span className="topbar-stat-main">
        <span>{label}</span>
        {value ? <strong>{value}</strong> : <span className="topbar-stat-empty">--</span>}
      </span>
      {detail ? <span className="topbar-stat-detail">{detail}</span> : null}
    </div>
  );
}

function formatCompactUsd(value: number | undefined, fractionDigits?: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const compactFractionDigits = fractionDigits ?? (Number(value) >= 1_000_000_000 ? 2 : 1);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compactFractionDigits,
    minimumFractionDigits: fractionDigits,
    notation: "compact",
  }).format(Number(value));
}

function foldPriceIntoState(state: MarketState, price: number, isRealtime: boolean, now = Date.now()): MarketState {
  const ath = state.ath ? { ...state.ath } : undefined;

  if (ath) {
    const nextTodayHigh = Math.max(ath.todayHigh, price);

    ath.todayHigh = nextTodayHigh;

    if (nextTodayHigh > ath.allTimeHigh) {
      ath.allTimeHigh = nextTodayHigh;
      ath.allTimeHighDay = ath.utcDay;
    }

    ath.hitNewAthToday = Number.isFinite(ath.priorAth) ? ath.todayHigh > ath.priorAth : true;
  }

  return {
    ...state,
    ath,
    lastPriceAt: now,
    lastUpdated: now,
    liveStatus: isRealtime ? "connected" : state.liveStatus,
    price,
    priceError: undefined,
    priceStatus: "ready",
  };
}

function safeParseMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView): HyperliquidWsMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readHypePrice(message: HyperliquidWsMessage): number | undefined {
  if (message.channel === "allMids" && isRecord(message.data) && isRecord(message.data.mids)) {
    return toFinitePrice(message.data.mids[HYPE_SPOT_COIN]);
  }

  if (message.channel === "trades" && Array.isArray(message.data)) {
    for (let index = message.data.length - 1; index >= 0; index -= 1) {
      const trade = message.data[index];

      if (isRecord(trade)) {
        const price = toFinitePrice(trade.px);

        if (price !== undefined) {
          return price;
        }
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toFinitePrice(value: unknown): number | undefined {
  const price = Number(value);

  return Number.isFinite(price) ? price : undefined;
}

function getMarketStatus(market: MarketState): string {
  const notice = getMarketNotice(market);

  if (notice) {
    return `${notice.title}. ${notice.body}`;
  }

  if (!market.lastUpdated) {
    return "Market data pending.";
  }

  return `Market data updated at ${new Date(market.lastUpdated).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}.`;
}

function getMarketNotice(market: MarketState): { body: string; title: string } | undefined {
  if (!market.isOnline) {
    return {
      title: "Offline mode",
      body: market.price
        ? "Showing the last price we received. Reconnect to refresh the ATH check."
        : "Connect to the internet to load HYPE market data.",
    };
  }

  if (market.snapshotStatus === "error" && market.priceStatus === "error") {
    return {
      title: "Market data is unavailable",
      body: "Hyperliquid is not responding right now. Try again in a moment.",
    };
  }

  if (market.snapshotStatus === "error") {
    return {
      title: "ATH check is unavailable",
      body: "Live price can still update, but the ATH answer needs candle history.",
    };
  }

  if (market.priceStatus === "error") {
    return {
      title: "Live price is unavailable",
      body: "The ATH check may still load, but the current price is not responding.",
    };
  }

  if (market.snapshotStatus === "stale" || market.priceStatus === "stale") {
    return {
      title: "Refreshing market data",
      body: "Showing the latest value we have while Hyperliquid reconnects.",
    };
  }

  return undefined;
}

function getOnlineStatus(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function formatAthDate(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number);

  if (![year, month, day].every(Number.isFinite)) {
    return isoDay;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function getChartScrollTarget(chartPanel: HTMLElement): number {
  const panelRect = chartPanel.getBoundingClientRect();
  const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const maxScroll = Math.max(0, documentHeight - window.innerHeight);
  const centeredScroll = getPageScroll() + panelRect.top - Math.max(24, (window.innerHeight - panelRect.height) / 2);

  return Math.min(Math.max(centeredScroll, 0), maxScroll);
}

function scheduleChartScroll(scrollCleanupRef: { current: (() => void) | undefined }): () => void {
  let frameId: number | undefined;
  const timeoutId = window.setTimeout(() => {
    const startChartScroll = (attempt = 0) => {
      const chartPanel = document.getElementById("hype-chart-panel");
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!chartPanel || chartPanel.getBoundingClientRect().height === 0) {
        if (attempt < 12) {
          frameId = window.requestAnimationFrame(() => startChartScroll(attempt + 1));
        }
        return;
      }

      const startScroll = getPageScroll();
      const targetScroll = getChartScrollTarget(chartPanel);

      if (attempt < 12 && targetScroll <= startScroll && chartPanel.getBoundingClientRect().bottom > window.innerHeight + 8) {
        frameId = window.requestAnimationFrame(() => startChartScroll(attempt + 1));
        return;
      }

      if (prefersReducedMotion) {
        setPageScroll(targetScroll);
        return;
      }

      scrollCleanupRef.current?.();
      scrollCleanupRef.current = animateWindowScroll(startScroll, targetScroll, CHART_SCROLL_DURATION_MS, () => {
        scrollCleanupRef.current = undefined;
      });
    };

    startChartScroll();
  }, CHART_SCROLL_DELAY_MS);

  return () => {
    window.clearTimeout(timeoutId);
    if (frameId) {
      window.cancelAnimationFrame(frameId);
    }
  };
}

function animateWindowScroll(
  startScroll: number,
  targetScroll: number,
  duration: number,
  onComplete?: () => void,
): () => void {
  const distance = targetScroll - startScroll;
  let animationId: number | undefined;
  let isCancelled = false;

  if (Math.abs(distance) < 1) {
    setPageScroll(targetScroll);
    onComplete?.();
    return () => undefined;
  }

  const startTime = window.performance.now();

  const animateScroll = (now: number) => {
    if (isCancelled) {
      return;
    }

    const progress = Math.min((now - startTime) / duration, 1);
    const nextScroll = startScroll + distance * easeInOutCubic(progress);

    setPageScroll(nextScroll);

    if (progress < 1) {
      animationId = window.requestAnimationFrame(animateScroll);
      return;
    }

    onComplete?.();
  };

  animationId = window.requestAnimationFrame(animateScroll);

  return () => {
    isCancelled = true;

    if (animationId) {
      window.cancelAnimationFrame(animationId);
    }
  };
}

function getPageScroll(): number {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function setPageScroll(nextScroll: number): void {
  window.scrollTo(0, nextScroll);
  document.documentElement.scrollTop = nextScroll;
  document.body.scrollTop = nextScroll;
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

function shouldMockLiveFeed(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const mock = new URLSearchParams(window.location.search).get("mockMarket");

  return mock === "all" || mock === "price" || mock === "slow";
}
