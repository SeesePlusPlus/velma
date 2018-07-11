import { LibSdbRuntime } from "../runtime";
import { LibSdbCompilationProcessor } from "../compilation/processor";
import { LibSdbTypes } from "../types/types";

const uuidv4 = require("uuid").v4;

/*
 * This is the interface to EVM implementations (i.e. ethereumjs-vm via ganache-core/cli, geth, parity, etc.)
 */
export class LibraryInterface {

  private _debuggerMessages: Map<string, Function | undefined>;

  public evm: any | undefined;

  private _runtime: LibSdbRuntime;

  constructor() {
      this._runtime = LibSdbRuntime.instance();
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

  public requestInjectCode(bytecode: string, pc: number, vmData: any = undefined): Promise<void> {
      return new Promise<void>((resolve, reject) => {
          const msgId = uuidv4();

          let request: any = {
              "id": msgId,
              "messageType": "request",
              "content": {
                  "type": "injectNewCode",
                  "code": bytecode,
                  "pc": pc
              }
          };

          if (vmData !== undefined) {
              request.content.state = {
                  "stack": vmData.stack,
                  "memory": vmData.memory,
                  "gasLeft": vmData.gasLeft
              }
          }

          this._debuggerMessages.set(msgId, resolve);

          if (this.evm !== undefined) {
              this.evm.handleMessage(request);
          }
      });
  }

  public requestRunUntilPc(pc: number): Promise<any> {
      return new Promise<void>((resolve, reject) => {
          const msgId = uuidv4();

          let request: any = {
              "id": msgId,
              "messageType": "request",
              "content": {
                  "type": "runUntilPc",
                  "stepId": this._runtime._stepData!.debuggerMessageId,
                  "pc": pc
              }
          };

          this._debuggerMessages.delete(this._runtime._stepData!.debuggerMessageId);
          this._debuggerMessages.set(msgId, resolve);

          if (this.evm !== undefined) {
              this.evm.handleMessage(request);
          }
      });
  }

  public async requestEvaluation(evalRequest: LibSdbTypes.EvaluationRequest): Promise<any> {
      await this.requestInjectCode(evalRequest.evaluationBytecode, evalRequest.evaluationStartPc);

      const vmData = await this.requestRunUntilPc(evalRequest.evaluationEndPc);

      await this.requestInjectCode(evalRequest.runtimeBytecode, evalRequest.runtimePc, this._runtime._stepData!.vmData);

      return vmData;
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

  public async requestSendBreakpoint(id: number, address: string, pc: number, enabled: boolean, bpIsRuntime: boolean): Promise<any> {
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
                  "enabled": enabled,
                  "runtime": bpIsRuntime
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

  public async requestSendFunctionJumpDestinations(address: string, jumpDestinations: number[]) {
      return new Promise<any>((resolve, reject) => {
          const msgId = uuidv4();
          const request = {
              "id": msgId,
              "messageType": "request",
              "content": {
                  "type": "sendJumpDestinations",
                  "address": address,
                  "jumpDestinations": jumpDestinations
              }
          };

          this._debuggerMessages.set(msgId, resolve);

          if (this.evm !== undefined) {
              this.evm.handleMessage(request);
          }
      });
  }

  public async receiveFromEvm(data: any): Promise<void> {
    const triggerType = data.triggerType;
    const messageType = data.messageType;

    if (messageType === "request") {
        this._debuggerMessages.set(data.id, (message) => {
            this.evm.handleMessage(message);
        });

        if (triggerType === "linkCompilerOutput") {
            const compilationProcessor = new LibSdbCompilationProcessor();
            compilationProcessor.linkCompilerOutput(data.content.sourceRootPath, data.content.compilationResult);
            this.respondToDebugHook("stopOnBreakpoint", data.id);
        }
        else if (triggerType === "linkContractAddress") {
            const compilationProcessor = new LibSdbCompilationProcessor();
            const contract = compilationProcessor.linkContractAddress(data.content.contractName, data.content.address);
            if (contract !== null) {
                await this._runtime._breakpoints.verifyBreakpoints(contract.sourcePath);
                await this._runtime.sendVariableDeclarations(data.content.address.toLowerCase());
                await this._runtime.sendFunctionJumpDestinations(data.content.address.toLowerCase());
            }
            this.respondToDebugHook("stopOnBreakpoint", data.id);
        }
        else if (triggerType === "step" || triggerType === "exception") {
            await this._runtime.vmStepped(data);
        }
        else if (triggerType === "newContract") {
            const compilationProcessor = new LibSdbCompilationProcessor();
            const contract = compilationProcessor.linkContractAddressFromBytecode(data.content.code, data.content.address);
            if (contract !== null) {
                await this._runtime._breakpoints.verifyBreakpoints(contract.sourcePath);
                await this._runtime.sendVariableDeclarations(data.content.address.toLowerCase());
                await this._runtime.sendFunctionJumpDestinations(data.content.address.toLowerCase());
            }
            this.respondToDebugHook("stopOnBreakpoint", data.id);
        }
    }
    else if (messageType === "response") {
        const debuggerMessage = this._debuggerMessages.get(data.id)!;
        if (debuggerMessage instanceof Function) {
            debuggerMessage(data.content);
        }
        this._debuggerMessages.delete(data.id);

        if (triggerType === "runUntilPc") {
            // the step data id gets modified due to changes in sdbhook
            this._runtime._stepData!.debuggerMessageId = data.id;
            this._debuggerMessages.set(data.id, (message) => {
                this.evm.handleMessage(message);
            });
        }
    }
}
}