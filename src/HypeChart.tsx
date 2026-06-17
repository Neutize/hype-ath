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
import { type ChartCandle, type ChartInterval, fetchSpotChartCandles } from "./hyperliquid";

type ChartStatus = "idle" | "loading" | "ready" | "error";

type HypeChartProps = {
  latestPrice?: number;
  visible: boolean;
};

const UP_COLOR = "#00D5C1";
const DOWN_COLOR = "#FF6687";
const INK = "#00241E";
const DEFAULT_INTERVAL: ChartInterval = "4h";
const REFRESH_INTERVAL_MS = 60_000;
const VISIBLE_BARS_BY_INTERVAL: Record<ChartInterval, number> = {
  "1m": 160,
  "15m": 120,
  "4h": 96,
};
const FUTURE_BARS_BY_INTERVAL: Record<ChartInterval, number> = {
  "1m": 20,
  "15m": 18,
  "4h": 16,
};
const CHART_INTERVALS: Array<{ label: string; value: ChartInterval }> = [
  { label: "1m", value: "1m" },
  { label: "15m", value: "15m" },
  { label: "4H", value: "4h" },
];

export function HypeChart({ latestPrice, visible }: HypeChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const hasAppliedInitialRangeRef = useRef(false);
  const requestIdRef = useRef(0);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [selectedInterval, setSelectedInterval] = useState<ChartInterval>(DEFAULT_INTERVAL);
  const [status, setStatus] = useState<ChartStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  const loadCandles = useCallback(async (showLoading = false) => {
    const requestId = requestIdRef.current + 1;

    requestIdRef.current = requestId;

    if (showLoading) {
      setStatus((current) => (current === "ready" ? current : "loading"));
    }

    try {
      const nextCandles = await fetchSpotChartCandles(selectedInterval);

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (nextCandles.length < 2) {
        throw new Error("Not enough HYPE candles yet.");
      }

      setCandles(nextCandles);
      setError(undefined);
      setStatus("ready");
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setError("HYPE chart is temporarily unavailable.");
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [selectedInterval]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadCandles(true);
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

    if (!visible || !container) {
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
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: FUTURE_BARS_BY_INTERVAL[selectedInterval],
        rightBarStaysOnScroll: false,
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

    resizeObserver.observe(container);
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;

    if (!chart || !series || chartData.length === 0) {
      return;
    }

    series.setData(chartData);

    if (!hasAppliedInitialRangeRef.current) {
      applyInitialVisibleRange(chart, chartData.length, selectedInterval);
      hasAppliedInitialRangeRef.current = true;
    }
  }, [chartData, selectedInterval]);

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

  const handleIntervalChange = (nextInterval: ChartInterval) => {
    if (nextInterval === selectedInterval) {
      return;
    }

    hasAppliedInitialRangeRef.current = false;
    requestIdRef.current += 1;
    setCandles([]);
    setError(undefined);
    setStatus("loading");
    setSelectedInterval(nextInterval);
  };

  if (!visible) {
    return null;
  }

  return (
    <div className="chart-panel" id="hype-chart-panel" aria-live="polite">
      <div className="chart-toolbar">
        <div className="chart-heading">
          <span className="chart-title">$HYPE Spot</span>
        </div>
        <div className="chart-timeframes" role="group" aria-label="Chart timeframe">
          {CHART_INTERVALS.map((interval) => (
            <button
              className="chart-timeframe"
              type="button"
              aria-pressed={selectedInterval === interval.value}
              key={interval.value}
              onClick={() => handleIntervalChange(interval.value)}
            >
              {interval.label}
            </button>
          ))}
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

function applyInitialVisibleRange(chart: IChartApi, dataLength: number, interval: ChartInterval) {
  const visibleBars = VISIBLE_BARS_BY_INTERVAL[interval];
  const futureBars = FUTURE_BARS_BY_INTERVAL[interval];
  const lastBarIndex = dataLength - 1;
  const sparseLeftPadding = Math.max(0, Math.round((visibleBars - dataLength) / 2));
  const from = dataLength < visibleBars ? -sparseLeftPadding : Math.max(0, dataLength - visibleBars + futureBars);
  const to = dataLength < visibleBars ? from + visibleBars : lastBarIndex + futureBars;

  chart.timeScale().setVisibleLogicalRange({ from, to });
}
