import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AthSnapshot,
  fetchAthSnapshot,
  fetchCurrentSpotPrice,
  formatUsd,
  HYPE_SPOT_COIN,
  HYPERLIQUID_WS_URL,
} from "./hyperliquid";

type RequestStatus = "loading" | "ready" | "stale" | "error";

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
};

type AllMidsMessage = {
  channel: "allMids";
  data: {
    mids: Record<string, string>;
  };
};

const TRADE_URL = "https://app.hyperliquid.xyz/join/NEUTIZE";
const CHART_URL = "https://app.hyperliquid.xyz/trade/HYPE/USDC";
const PRICE_FALLBACK_INTERVAL_MS = 12_000;
const RECONNECT_DELAY_MS = 2_500;
const SNAPSHOT_REFRESH_INTERVAL_MS = 60_000;

const getInitialMarket = (): MarketState => ({
  isOnline: getOnlineStatus(),
  isRefreshing: false,
  liveStatus: "connecting",
  priceStatus: "loading",
  snapshotStatus: "loading",
});

export default function App() {
  const [market, setMarket] = useState<MarketState>(getInitialMarket);

  const refreshMarket = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setMarket((current) => ({
        ...current,
        isRefreshing: true,
        priceStatus: current.price ? current.priceStatus : "loading",
        snapshotStatus: current.ath ? current.snapshotStatus : "loading",
      }));
    }

    const [athResult, priceResult] = await Promise.allSettled([
      fetchAthSnapshot(),
      fetchCurrentSpotPrice(),
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
      });

      socket.addEventListener("message", (event) => {
        const message = safeParseMessage(event.data);

        if (message?.channel !== "allMids") {
          return;
        }

        const price = Number(message.data.mids[HYPE_SPOT_COIN]);

        if (Number.isFinite(price)) {
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

  const answer = market.ath?.hitNewAthToday;
  const isAnswerLoading = answer === undefined && market.snapshotStatus === "loading";
  const isPriceLoading = market.price === undefined && market.priceStatus === "loading";
  const answerText = answer === undefined ? "..." : answer ? "Yes." : "No";
  const answerClass = [
    "answer",
    answer === false ? "no" : answer === true ? "yes" : "pending",
    isAnswerLoading ? "is-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const priceClass = ["price", market.price === undefined ? "price-pending" : ""].filter(Boolean).join(" ");
  const priceText = useMemo(() => formatUsd(market.price), [market.price]);
  const notice = getMarketNotice(market);
  const isBusy = isAnswerLoading || isPriceLoading || market.isRefreshing;
  const statusText = getMarketStatus(market);

  return (
    <main className="page-shell">
      <div className="logo-field" aria-hidden="true">
        <div className="logo-mark logo-mark-a" />
        <div className="logo-mark logo-mark-b" />
        <div className="logo-mark logo-mark-c" />
        <div className="price-line price-line-a" />
        <div className="price-line price-line-b" />
      </div>

      <section className="content-stack" aria-busy={isBusy} aria-live="polite">
        <h1>Did $HYPE hit a new ATH today?</h1>
        <p className={answerClass} aria-label={isAnswerLoading ? "ATH check loading" : answerText}>
          {isAnswerLoading ? <span className="shimmer answer-shimmer" aria-hidden="true" /> : answerText}
        </p>
        <p className={priceClass}>
          Current price:{" "}
          {isPriceLoading ? <span className="shimmer price-shimmer" aria-hidden="true" /> : priceText}
        </p>
        <div className="actions-stack">
          <a className="trade-button" href={TRADE_URL} target="_blank" rel="noreferrer">
            Trade
          </a>
          <a className="chart-link" href={CHART_URL} target="_blank" rel="noreferrer">
            <span>Show chart</span>
            <span className="chart-arrow" aria-hidden="true" />
          </a>
        </div>
        {notice ? (
          <div className="market-notice" role="status">
            <div>
              <strong>{notice.title}</strong>
              <span>{notice.body}</span>
            </div>
            <button type="button" onClick={() => void refreshMarket(true)} disabled={market.isRefreshing}>
              {market.isRefreshing ? "Checking" : "Retry"}
            </button>
          </div>
        ) : null}
      </section>

      <p className="visually-hidden">{statusText}</p>
    </main>
  );
}

function foldPriceIntoState(state: MarketState, price: number, isRealtime: boolean, now = Date.now()): MarketState {
  const ath = state.ath ? { ...state.ath } : undefined;

  if (ath) {
    ath.todayHigh = Math.max(ath.todayHigh, price);
    ath.allTimeHigh = Math.max(ath.allTimeHigh, ath.todayHigh);
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

function safeParseMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView): AllMidsMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    return JSON.parse(data) as AllMidsMessage;
  } catch {
    return null;
  }
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

function shouldMockLiveFeed(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const mock = new URLSearchParams(window.location.search).get("mockMarket");

  return mock === "all" || mock === "price" || mock === "slow";
}
