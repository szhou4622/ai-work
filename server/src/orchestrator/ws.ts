import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { isAuthenticated, authRequired } from '../routes/auth.js';
import type { WsServerEvent } from '@workbench/shared';

/**
 * WebSocket 中枢（开发文档 §8.2 / §7.2）
 * - 客户端连接 /ws 后发送 {type:'subscribe', task_id} 订阅某任务事件
 * - 服务器向订阅者推送 agent.output / task.status 等
 * - 鉴权与 REST 一致：auth_required=false（默认）时不强制登录；
 *   auth_required=true 时校验会话 Cookie（浏览器同源 WS 自动携带）
 */
export class WsHub {
  private subs = new Map<string, Set<any>>(); // task_id -> sockets
  private sockets = new Map<any, Set<string>>(); // socket -> task_ids

  publish(event: WsServerEvent): void {
    const sockets = this.subs.get(event.task_id);
    if (!sockets) return;
    const msg = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        if (ws.readyState === 1) ws.send(msg);
      } catch { /* ignore */ }
    }
  }

  register(app: FastifyInstance): void {
    app.register(fastifyWebsocket);
    app.register(async (fastify) => {
      fastify.get('/ws', { websocket: true }, (socket: any, req: any) => {
        if (authRequired() && !isAuthenticated(req)) {
          socket.close(4001, 'unauthorized');
          return;
        }
        const myTasks = new Set<string>();
        this.sockets.set(socket, myTasks);

        socket.on('message', (raw: any) => {
          try {
            const data = JSON.parse(String(raw));
            if (data.type === 'subscribe' && data.task_id) {
              myTasks.add(data.task_id);
              let set = this.subs.get(data.task_id);
              if (!set) { set = new Set(); this.subs.set(data.task_id, set); }
              set.add(socket);
              socket.send(JSON.stringify({ type: 'subscribed', task_id: data.task_id } as any));
            }
          } catch { /* ignore */ }
        });

        socket.on('close', () => {
          for (const t of myTasks) {
            const set = this.subs.get(t);
            if (set) { set.delete(socket); if (set.size === 0) this.subs.delete(t); }
          }
          this.sockets.delete(socket);
        });
      });
    });
  }
}
