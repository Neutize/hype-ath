import { useEffect, useMemo, useState } from "react";
import {
  type AthSnapshot,
  fetchAthSnapshot,
  fetchCurrentSpotPrice,
  formatUsd,
  HYPE_SPOT_COIN,
  HYPERLIQUID_WS_URL,
} from "./hyperliquid";

type MarketState = {
  ath?: AthSnapshot;
  error?: string;
  lastUpdated?: number;
  price?: number;
};

type AllMidsMessage = {
  channel: "allMids";
  data: {
    mids: Record<string, string>;
  };
};

const TRADE_URL = "https://app.hyperliquid.xyz/join/NEUTIZE";

export default function App() {
  const [market, setMarket] = useState<MarketState>({});

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const [ath, price] = await Promise.all([fetchAthSnapshot(), fetchCurrentSpotPrice()]);

        if (!cancelled) {
          setMarket((current) => foldPriceIntoState({ ...current, ath }, price));
        }
      } catch (error) {
        if (!cancelled) {
          setMarket((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Market data unavailable",
          }));
        }
      }
    }

    void loadSnapshot();
    const refreshId = window.setInterval(loadSnapshot, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshId);
    };
  }, []);

  useEffect(() => {
    let closedByApp = false;
    let reconnectId: number | undefined;
    let socket: WebSocket | undefined;

    const applyPrice = (price: number) => {
      setMarket((current) => foldPriceIntoState(current, price));
    };

    const connect = () => {
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

      socket.addEventListener("close", () => {
        if (!closedByApp) {
          reconnectId = window.setTimeout(connect, 2500);
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
          error: current.price ? undefined : "Live price unavailable",
        }));
      }
    }, 12_000);

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
  const answerText = answer === undefined ? "..." : answer ? "Yes." : "No";
  const answerClass = answer === false ? "answer no" : "answer yes";
  const priceText = useMemo(() => formatUsd(market.price), [market.price]);
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

      <section className="content-stack" aria-live="polite">
        <h1>Did $HYPE hit a new ATH today?</h1>
        <p className={answerClass}>{answerText}</p>
        <p className="price">Current price: {priceText}</p>
        <a className="trade-button" href={TRADE_URL} target="_blank" rel="noreferrer">
          Trade
        </a>
      </section>

      <p className="visually-hidden">{statusText}</p>
    </main>
  );
}

function foldPriceIntoState(state: MarketState, price: number): MarketState {
  const ath = state.ath ? { ...state.ath } : undefined;

  if (ath) {
    ath.todayHigh = Math.max(ath.todayHigh, price);
    ath.allTimeHigh = Math.max(ath.allTimeHigh, ath.todayHigh);
    ath.hitNewAthToday = Number.isFinite(ath.priorAth) ? ath.todayHigh > ath.priorAth : true;
  }

  return {
    ...state,
    ath,
    error: undefined,
    lastUpdated: Date.now(),
    price,
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
  if (market.error) {
    return market.error;
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
