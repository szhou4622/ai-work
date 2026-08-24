import { useEffect, useRef, useState } from 'react';

export interface UseWebSocketOptions {
  onMessage?: (event: MessageEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

/**
 * WebSocket Hook with automatic reconnection
 * 用于实时接收任务输出流和状态更新
 */
export function useWebSocket(url: string, options: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onOpen,
    onClose,
    onError,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setIsConnected(true);
        setReconnectCount(0);
        onOpen?.();
      };

      ws.onmessage = (event) => {
        onMessage?.(event);
      };

      ws.onclose = () => {
        setIsConnected(false);
        onClose?.();

        // 自动重连
        if (shouldReconnectRef.current && reconnectCount < maxReconnectAttempts) {
          reconnectTimerRef.current = window.setTimeout(() => {
            setReconnectCount((c) => c + 1);
            connect();
          }, reconnectInterval);
        }
      };

      ws.onerror = (error) => {
        onError?.(error);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[WS] Connection failed:', error);
    }
  };

  const disconnect = () => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  const send = (data: string | object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  };

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [url]);

  return { isConnected, reconnectCount, send, disconnect };
}
