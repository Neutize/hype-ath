import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { type ChartCandle, fetchSpotChartCandles } from "./hyperliquid";

type ChartStatus = "idle" | "loading" | "ready" | "error";

type HypeChartProps = {
  latestPrice?: number;
  visible: boolean;
};

const UP_COLOR = "#00D5C1";
const DOWN_COLOR = "#FF6687";
const INK = "#00241E";
const REFRESH_INTERVAL_MS = 60_000;

export function HypeChart({ latestPrice, visible }: HypeChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const hasCandlesRef = useRef(false);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [status, setStatus] = useState<ChartStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  const loadCandles = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setStatus((current) => (current === "ready" ? current : "loading"));
    }

    try {
      const nextCandles = await fetchSpotChartCandles();

      if (nextCandles.length < 2) {
        throw new Error("Not enough HYPE candles yet.");
      }

      hasCandlesRef.current = true;
      setCandles(nextCandles);
      setError(undefined);
      setStatus("ready");
    } catch {
      setError("HYPE chart is temporarily unavailable.");
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadCandles(!hasCandlesRef.current);
    const refreshId = window.setInterval(() => void loadCandles(false), REFRESH_INTERVAL_MS);

    return () => window.clearInterval(refreshId);
  }, [loadCandles, visible]);

  const chartData = useMemo(
    () =>
      candles.map(
        (candle): CandlestickData<UTCTimestamp> => ({
          close: candle.close,
          high: candle.high,
          low: candle.low,
          open: candle.open,
          time: candle.time as UTCTimestamp,
        }),
      ),
    [candles],
  );

  useEffect(() => {
    const container = containerRef.current;

    if (!visible || !container || chartData.length === 0) {
      return;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        textColor: "rgba(0, 36, 30, 0.56)",
      },
      grid: {
        horzLines: { color: "rgba(0, 213, 193, 0.1)" },
        vertLines: { color: "rgba(0, 213, 193, 0.12)" },
      },
      crosshair: {
        mode: CrosshairMode.MagnetOHLC,
        horzLine: { color: "rgba(0, 36, 30, 0.34)", labelBackgroundColor: INK },
        vertLine: { color: "rgba(0, 36, 30, 0.26)", labelBackgroundColor: INK },
      },
      rightPriceScale: {
        borderColor: "rgba(0, 36, 30, 0.12)",
        scaleMargins: {
          bottom: 0.12,
          top: 0.14,
        },
      },
      timeScale: {
        borderColor: "rgba(0, 36, 30, 0.12)",
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 6,
        secondsVisible: false,
        timeVisible: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      localization: {
        priceFormatter: (price: number) =>
          price.toLocaleString("en-US", {
            maximumFractionDigits: price >= 100 ? 2 : 4,
            minimumFractionDigits: 2,
          }),
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, {
      borderDownColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      downColor: DOWN_COLOR,
      priceLineColor: UP_COLOR,
      priceLineWidth: 2,
      upColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
    });
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;

      chart.resize(Math.max(0, width), Math.max(0, height));
    });

    series.setData(chartData);
    chart.timeScale().fitContent();
    resizeObserver.observe(container);
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [chartData, visible]);

  useEffect(() => {
    const series = seriesRef.current;
    const lastCandle = candles[candles.length - 1];

    if (!series || !lastCandle || !Number.isFinite(latestPrice)) {
      return;
    }

    const liveCandle: CandlestickData<UTCTimestamp> = {
      close: Number(latestPrice),
      high: Math.max(lastCandle.high, Number(latestPrice)),
      low: Math.min(lastCandle.low, Number(latestPrice)),
      open: lastCandle.open,
      time: lastCandle.time as UTCTimestamp,
    };

    series.update(liveCandle);
  }, [candles, latestPrice]);

  if (!visible) {
    return null;
  }

  return (
    <div className="chart-panel" id="hype-chart-panel" aria-live="polite">
      <div className="chart-toolbar">
        <div>
          <span className="chart-title">$HYPE Spot</span>
          <span className="chart-subtitle">4H candles</span>
        </div>
        <span className="chart-badge">Hyperliquid</span>
      </div>

      <div className="chart-frame">
        {status === "loading" || status === "idle" ? (
          <div className="chart-skeleton" role="status" aria-label="Loading HYPE chart">
            <div className="chart-skeleton-line chart-skeleton-line-a" />
            <div className="chart-skeleton-line chart-skeleton-line-b" />
            <div className="chart-skeleton-bars">
              {Array.from({ length: 18 }, (_, index) => (
                <span key={index} style={{ height: `${34 + ((index * 17) % 56)}%` }} />
              ))}
            </div>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="chart-error" role="status">
            <strong>Chart paused</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void loadCandles(true)}>
              Retry
            </button>
          </div>
        ) : null}

        <div
          className="chart-canvas"
          ref={containerRef}
          aria-hidden={status !== "ready"}
          data-ready={status === "ready"}
        />
      </div>

      <div className="chart-footer">
        <span>{error && status === "ready" ? error : "Live price updates the latest candle between refreshes."}</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Powered by TradingView
        </a>
      </div>
    </div>
  );
}
