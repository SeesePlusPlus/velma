import * as WebSocket from "ws";

import { LibSdbCompile } from "./compiler";
import { LibSdbRuntime } from "./runtime";

const uuidv4 = require("uuid").v4;

export class LibSdbInterface {
    private _wss: WebSocket.Server;
    private _latestWs: WebSocket;

    private _runtime: LibSdbRuntime;

    private _debuggerMessages: Map<string, Function | undefined>;

    public evm: any | undefined;

    constructor(runtime: LibSdbRuntime) {
        this._runtime = runtime;
        this._debuggerMessages = new Map<string, Function | undefined>();
    }

    public respondToDebugHook(stepEvent: string, messageId: string, content: any = null) {
        // don't respond if we don't actually need to
        if (!this._debuggerMessages.has(messageId)) {
            return;
        }

        if (stepEvent !== "skipEvent") {
            if (content === null) {
                content = {};
            }
            content.fastStep = stepEvent === "stopOnBreakpoint";
        }

        const response = {
            "status": "ok",
            "id": messageId,
            "messageType": "response",
            "content": content
        };
        const debuggerMessage = this._debuggerMessages.get(messageId)!;
        if (debuggerMessage instanceof Function) {
            debuggerMessage(response);
        }
        this._debuggerMessages.delete(messageId);
    }

    public requestContent(content: any, callback: Function | undefined = undefined) {
        const msgId = uuidv4();
        const request = {
            "id": msgId,
            "messageType": "request",
            "content": content
        };

        this._debuggerMessages.set(msgId, callback);

        if (this.evm !== undefined) {
            this.evm.handleMessage(request);
        }
    }

    public async requestStorage(address: any, position: any): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const msgId = uuidv4();
            const request = {
                "id": msgId,
                "messageType": "request",
                "content": {
                    "type": "getStorage",
                    "address": address,
                    "position": position
                }
            };

            this._debuggerMessages.set(msgId, resolve);

            if (this.evm !== undefined) {
                this.evm.handleMessage(request);
            }
        });
    }

    public async requestSendBreakpoint(id: number, address: string, pc: number, enabled: boolean): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const msgId = uuidv4();
            const request = {
                "id": msgId,
                "messageType": "request",
                "content": {
                    "type": "sendBreakpoint",
                    "id": id,
                    "address": address,
                    "pc": pc,
                    "enabled": enabled
                }
            };

            this._debuggerMessages.set(msgId, resolve);

            if (this.evm !== undefined) {
                this.evm.handleMessage(request);
            }
        });
    }

    public async requestSendVariableDeclarations(address: string, declarations: number[]) {
        return new Promise<any>((resolve, reject) => {
            const msgId = uuidv4();
            const request = {
                "id": msgId,
                "messageType": "request",
                "content": {
                    "type": "sendDeclarations",
                    "address": address,
                    "declarations": declarations
                }
            };

            this._debuggerMessages.set(msgId, resolve);

            if (this.evm !== undefined) {
                this.evm.handleMessage(request);
            }
        });
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
                    const variables = await this._runtime.variables();
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
    }

    public async receiveFromEvm(data: any): Promise<void> {
        const triggerType = data.triggerType;
        const messageType = data.messageType;

        if (messageType === "request") {
            this._debuggerMessages.set(data.id, (message) => {
                this.evm.handleMessage(message);
            });

            if (triggerType === "linkCompilerOutput") {
                LibSdbCompile.linkCompilerOutput(this._runtime._files, this._runtime._contractsByName, this._runtime._contractsByAddress, data.content.sourceRootPath, data.content.compilationResult);
                this.respondToDebugHook("stopOnBreakpoint", data.id);
            }
            else if (triggerType === "linkContractAddress") {
                const contract = LibSdbCompile.linkContractAddress(this._runtime._contractsByName, this._runtime._contractsByAddress, data.content.contractName, data.content.address);
                if (contract !== null) {
                    await this._runtime._breakpoints.verifyBreakpoints(contract.sourcePath);
                    await this._runtime.sendVariableDeclarations(contract.address);
                }
                this.respondToDebugHook("stopOnBreakpoint", data.id);
            }
            else if (triggerType === "step" || triggerType === "exception") {
                this._runtime.vmStepped(data);
            }
        }
        else if (messageType === "response") {
            const debuggerMessage = this._debuggerMessages.get(data.id)!;
            if (debuggerMessage instanceof Function) {
                debuggerMessage(data.content);
            }
            this._debuggerMessages.delete(data.id);
        }
    }

    public sendEvent(event: string, ...args: any[]) {
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