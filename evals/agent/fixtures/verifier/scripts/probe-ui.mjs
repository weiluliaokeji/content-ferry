import { createConnection } from "node:net";
// 使用真实 socket 探测夹具的不可达端点，避免 fetch 的禁用端口规则
// 在发起连接前就抛错；不探测开发者已有的文渡端口 4317/5175。
const result = await new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port: 1 });
  const finish = (value) => { socket.destroy(); resolve(value); };
  socket.once("connect", () => finish({ reachable: true }));
  socket.once("error", (error) => finish({ reachable: false, reason: error.code }));
  socket.setTimeout(500, () => finish({ reachable: false, reason: "timeout" }));
});
console.log(JSON.stringify(result));
