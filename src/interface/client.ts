import * as WebSocket from "ws";
import { LibSdbRuntime } from "../runtime";

const uuidv4 = require("uuid").v4;

/*
 * This is the interface to user interface clients (i.e. VS Code, CLI, Atom, etc.)
 */
export class ClientInterface {
  private _wss: WebSocket.Server;
  private _latestWs: WebSocket;

  private _runtime: LibSdbRuntime;

  private _debuggerMessages: Map<string, Function | undefined>;

  constructor() {
      this._runtime = LibSdbRuntime.instance();
      this._debuggerMessages = new Map<string, Function | undefined>();
  }

  private async messageHandler(ws: WebSocket, message: WebSocket.Data): Promise<void> {
      const data = JSON.parse(message.toString());

      if (data.isRequest) {
          switch (data.type) {
              // TODO: start?
              case "clearBreakpoints":
                  await this._runtime._breakpoints.clearBreakpoints(data.content.path);
                  {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {}
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
              case "setBreakpoint":
                  const breakpoint = await this._runtime._breakpoints.setBreakpoint(data.content.path, data.content.line);
                  {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {
                              "data": breakpoint
                          }
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
              case "stack":
                  const stack = this._runtime.stack(data.content.startFrame, data.content.endFrame);
                  {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {
                              "data": stack
                          }
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
              case "variables":
                  const variables = await this._runtime.variables(data.content);
                  {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {
                              "data": variables
                          }
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
              case "uiAction":
                  let error = "";
                  switch (data.content.action) {
                      case "continue":
                          this._runtime.continue();
                          break;
                      case "continueReverse":
                          this._runtime.continue(true);
                          break;
                      case "stepOver":
                          this._runtime.stepOver();
                          break;
                      case "stepBack":
                          this._runtime.stepOver(true);
                          break;
                      case "stepIn":
                          this._runtime.stepIn();
                          break;
                      case "stepOut":
                          this._runtime.stepOut();
                          break;
                      default:
                          error = "Unsupported Debugger Action (" + data.content.action + ")";
                          break;
                  }
                  {
                      let payload: any = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {}
                      };
                      if (error) {
                          payload.error = error;
                      }
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
              case "evaluate":
                  this._runtime._evaluator.evaluate(data.content.expression, data.content.context, data.content.frameId, (reply) => {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {
                              "data": reply
                          }
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  });
                  break;
              default:
                  // respond unsupported call?
                  {
                      const payload = {
                          "id": data.id,
                          "isRequest": false,
                          "type": data.type,
                          "content": {
                              "error": "Unsupported Request Type (" + data.type + ")"
                          }
                      };
                      const message = JSON.stringify(payload);
                      ws.send(message);
                  }
                  break;
          }
      }
      else {
          switch (data.type) {
              case "ping":
                  const debuggerMessage = this._debuggerMessages.get(data.id)!;
                  if (debuggerMessage instanceof Function) {
                      debuggerMessage(true);
                  }
                  this._debuggerMessages.delete(data.id);
                  break;
          }
      }
  }

  public sendEvent(event: string, ...args: any[]) {
      if (this._latestWs instanceof WebSocket) {
          const eventPayload = {
              "id": uuidv4(),
              "isRequest": true,
              "type": "event",
              "content": {
                  "event": event,
                  "args": args
              }
          };

          const message = JSON.stringify(eventPayload);
          this._latestWs.send(message);
      }
  }

  public ping(callback: Function) {
      if (this._latestWs instanceof WebSocket) {
          const payload = {
              "id": uuidv4(),
              "isRequest": true,
              "type": "ping",
              "content": {}
          };

          this._debuggerMessages.set(payload.id, callback);
          setTimeout(() => {
              this._debuggerMessages.delete(payload.id);
              callback(false);
          }, 1000);
          const message = JSON.stringify(payload);
          this._latestWs.send(message);
      }
      else {
          callback(false);
      }
  }

  public serve(host: string, port: number, callback) {
      const self = this;

      this._wss = new WebSocket.Server({
          host: host,
          port: port
      });

      this._wss.on("connection", function connection(ws: WebSocket) {
          callback();
          self._latestWs = ws;
          ws.on("message", (message) => {
              self.messageHandler(ws, message);
          });
          ws.on("close", (code: number, reason: string) => {
              self._wss.close();
              self._runtime.sendEvent("end");
          });
      });
  }
}