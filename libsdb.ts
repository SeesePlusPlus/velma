import { readFileSync } from "fs";
import { EventEmitter } from "events";
import { Socket } from "net";
import { util, code } from "/home/mike/projects/remix/src/index";
import { compile } from "solc";
//import { StackFrame } from "../vscode-sdb-debug/node_modules/vscode-debugadapter/lib/main";

const CircularJSON = require("circular-json");
const BigNumber = require("bignumber.js");
const VM = require("/home/mike/projects/ethereumjs-vm");
const sourceMappingDecoder = new util.SourceMappingDecoder();

// bytecode is a hex string of the bytecode without the preceding '0x'
// methodId is the SHA3 hash of the ABI for this function
// returns the first occurence of the following bytecode sequence:
// DUP1, PUSH4 methodId, EQ, PUSH1 pc
// TODO: this could maybe not work depending on the different compiler optimization levels
export function GetFunctionProgramCount(bytecode, methodId) {
  const bytecodeSequence = "63" + methodId + "1460";
  const pos = bytecode.indexOf(bytecodeSequence);
  const pc = bytecode[pos + bytecodeSequence.length] + bytecode[pos + bytecodeSequence.length + 1];
  return parseInt(pc, 16);
}

export interface SdbBreakpoint {
  id: number;
  line: number;
  verified: boolean;
}

export interface SdbStackFrame {
  name: string;
  file: string;
  line: number;
  pc: number;
}

export interface SdbVariable {
  name: string;
  type: string;
  scope: number;
  position: number | null;
}

export class LibSdb extends EventEmitter {

  // maps from sourceFile to array of Mock breakpoints
  private _breakPoints: Map<string, SdbBreakpoint[]>;

  // since we want to send breakpoint events, we will assign an id to every event
  // so that the frontend can match events with breakpoints.
  private _breakpointId: number;

  private _socket: Socket;

  private _compilationResult: any;

  private _stepData: any;

  private _callStack: SdbStackFrame[];

  private _priorStepData: any | null;
  private _priorUiStepData: any | null;
  
  private _priorUiCallStack: SdbStackFrame[] | null;

  private _variables: Map<number, SdbVariable[]>;
  
  // private _traceManager: trace.traceManager;
  // private _codeManager: code.codeManager;
  // private _solidityProxy: solidity.proxy;
  // private _internalCallTree: util.internalCallTree;

  constructor() {
    super();
    this._stepData = null;
    this._socket = new Socket();
    this._breakPoints = new Map<string, SdbBreakpoint[]>();
    this._breakpointId = 1;
    this._priorStepData = null;
    this._callStack = [];
    this._priorUiCallStack = [];
    this._priorUiStepData = null;
    this._variables = new Map<number, SdbVariable[]>();

    // this._traceManager = new trace.traceManager();
    // this._codeManager = new code.codeManager(this._traceManager);
    // this._solidityProxy = new solidity.proxy(this._traceManager, this._codeManager);
    // this._internalCallTree = new util.internalCallTree(this, this._traceManager, this._solidityProxy, this._codeManager, { includeLocalVariables: true });
  }

  private contractsChanged(data: any) {
    // addresses changed
    this._compilationResult = data.content;
    //this._solidityProxy.reset(this._compilationResult);
    this.sendEvent("solidityProxyLoaded");
    
    let contracts = this._compilationResult.contracts;
    Object.keys(contracts).forEach((key) => {
      if(contracts[key].sourcePath !== null) {
        contracts[key].pcMap = code.util.nameOpCodes(new Buffer(contracts[key].runtimeBytecode.substring(2), 'hex'))[1];

        const inputContents = readFileSync(contracts[key].sourcePath).toString();
        contracts[key].lineBreaks = sourceMappingDecoder.getLinebreakPositions(inputContents);

        contracts[key].functionNames = {};
        Object.keys(contracts[key].functionHashes).forEach((functionName) => {
          const pc = GetFunctionProgramCount(contracts[key].bytecode, contracts[key].functionHashes[functionName]);
          contracts[key].functionNames[pc] = functionName;
        })
      }
    });

    const astWalker = new util.AstWalker();
    astWalker.walk(this._compilationResult.sources["DebugContract.sol"].AST, (node) => {
      if (node.id) {
        this._variables[node.id] = [];
        if (node.name === "VariableDeclaration") {
          const variable = <SdbVariable> {
            name: node.attributes.name,
            type: node.attributes.type,
            scope: node.attributes.scope,
            position: null
          };
          this._variables[variable.scope].push(variable);
        }
      }

      return true;
    });
    
    const response = {
      "status": "ok",
      "id": data.id,
      "messageType": "response",
      "content": null
    };
    this._socket.write(CircularJSON.stringify(response));
  }

  private findScope(index: number): number[] {
    let scope: number[] = [];
    const ast = this._compilationResult.sources["DebugContract.sol"].AST;

    const astWalker = new util.AstWalker();
    astWalker.walk(ast, (node) => {
      const src = node.src.split(":").map((s) => { return parseInt(s); });
      if (src.length >= 2 && src[0] <= index && index <= src[0] + src[1]) {
        scope.unshift(node.id);
        return true;
      }
      else {
        return false;
      }
    });

    return scope;
  }

  private vmStepped(data: any) {
    // step through code
    const pc = data.content.pc - 1;
    const address = (new Buffer(data.content.address.data)).toString("hex");
    
    /*if (!(address in this._contracts)) {
      console.log("address " + address + " not monitored");
      const response = {
        "status": "error",
        "id": data.id,
        "messageType": "response",
        "content": "address not monitored"
      };
      this._socket.write(CircularJSON.stringify(response));
      return;
    }*/

    if(typeof this._compilationResult === "undefined" || typeof this._compilationResult.contracts === "undefined") {
      this._stepData = {
        "debuggerMessageId": data.id,
        "source": null,
        "location": null,
        "contractAddress": address,
        "vmData": data.content
      };
      this.respondToDebugHook();
    }
    else {
      const contract = this._compilationResult.contracts[this._compilationResult.contractMap[address]];

      // get line number from pc
      const index = contract.pcMap[pc];
      const sourceLocation = sourceMappingDecoder.atIndex(index, contract.srcmapRuntime);
      const currentLocation = sourceMappingDecoder.convertOffsetToLineColumn(sourceLocation, contract.lineBreaks);

      if (this._priorStepData && this._priorStepData.source) {
        if (this._priorStepData.source.jump === "i") {
          // jump in

          // push the prior function onto the stack. the current location for stack goes on when requested
          const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._priorStepData.source, this._compilationResult.sources["DebugContract.sol"]);
          const functionName = node.attributes.name;
          const frame = <SdbStackFrame> {
            name: functionName,
            file: contract.sourcePath,
            line: this._priorStepData.location.start === null ? null : this._priorStepData.location.start.line,
            pc: pc
          };
          this._callStack.unshift(frame);
        }
        else if (this._priorStepData.source.jump === "o") {
          // jump out
          this._callStack.shift();
        }
        else if (pc in contract.functionNames) {
          // jump in to external function
          // this is the JUMPDEST of a function we just entered

          // TODO: figure this out
          // const functionName = contract.functionNames[pc];
          const frame = <SdbStackFrame> {
            name: "external place?",
            file: contract.sourcePath,
            line: 0, //currentLocation.start === null ? null : currentLocation.start.line,
            pc: pc
          };
          this._callStack.unshift(frame);
        }
      }

      // find current scope
      const currentScope = this.findScope(index);

      // is there a variable declaration here?
      if (sourceLocation) {
        const variableDeclarationNode = sourceMappingDecoder.findNodeAtSourceLocation("VariableDeclaration", sourceLocation, this._compilationResult.sources["DebugContract.sol"]);
        if (variableDeclarationNode) {
          const scope = variableDeclarationNode.attributes.scope;
          for (let i = 0; i < this._variables[scope].length; i++) {
            if (this._variables[scope][i].name === variableDeclarationNode.attributes.name) {
              this._variables[scope][i].position = data.content.stack.length
              break;
            }
          }
        }
      }

      this._stepData = {
        "debuggerMessageId": data.id,
        "source": sourceLocation,
        "location": currentLocation,
        "contractAddress": address,
        "vmData": data.content,
        "scope": currentScope
      };

      this.sendEvent("step");
    }
  }

  private socketHandler(dataSerialized: string) {
    const data = CircularJSON.parse(dataSerialized);
    const triggerType = data.triggerType;
  
    if (triggerType === "monitoredContractsChanged") {
      this.contractsChanged(data);
    }
    else if (triggerType === "step") {
      this.vmStepped(data);
    }
  }

  /**
   * Attach to SDB hook which interfaces to the EVM
   */
  public attach(host: string, port: number, callback) {
    this._socket.on('error', function(this: LibSdb, e) {
      if(e.code === 'ECONNREFUSED') {
        console.log('Is the server running at ' + port + '?');

        this._socket.setTimeout(5000, function(this: LibSdb) {
          this._socket.connect(port, host, function(){
            callback();
          });
        }.bind(this));

        console.log('Timeout for 5 seconds before trying port:' + port + ' again');

      }
    }.bind(this));

    this._socket.connect(port, host, () => {
      callback();
    });

    this._socket.on("data", this.socketHandler.bind(this));
  }

  /**
   * Start executing the given program.
   */
  public start(stopOnEntry: boolean) {

    this.verifyAllBreakpoints();

    if (stopOnEntry) {
      // we step once
      this.run(false, 'stopOnEntry');
    } else {
      // we just start to run until we hit a breakpoint or an exception
      this.continue();
    }
  }

  /**
   * Continue execution to the end/beginning.
   */
  public continue(reverse = false) {
    this.run(reverse, undefined);
  }

  /**
   * Step to the next/previous non empty line.
   */
  public stepOver(reverse = false, event = 'stopOnStepOver') {
    this.run(reverse, event);
  }

  public stepIn(reverse = false, event = 'stopOnStepIn') {
    this.run(reverse, event);
  }
  
  public stepOut(reverse = false, event = 'stopOnStepOut') {
    this.run(reverse, event);
  }

  /**
   * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
   */
  public stack(startFrame: number, endFrame: number): any {
    const frames = new Array<any>();

    const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, this._compilationResult.sources["DebugContract.sol"]);
    const functionName = node.attributes.name;
    if (startFrame === 0 && this._stepData.location && this._stepData.location.start) {
      frames.push({
        "index": startFrame,
        "name": functionName,
        "file": this._compilationResult.contracts["DebugContract.sol:DebugContract"].sourcePath,
        "line": this._stepData.location.start.line
      });
    }

    for (let i = startFrame; i < Math.min(endFrame, this._callStack.length); i++) {
      frames.push({
        "index": i + 1, // offset by one due to the current line "at the top of the stack", but not in the callstack variable
        "name": this._callStack[i].name,
        "file": this._callStack[i].file,
        "line": this._callStack[i].line
      });
    }

    return {
      frames: frames,
      count: frames.length
    };
  }

  public variables(): any[] {
    let variables: any[] = [];

    const stack = this._stepData.vmData.stack;
    for (let i = 0; i < this._stepData.scope.length; i++) {
      const scope = this._stepData.scope[i];
      const scopeVars = this._variables[scope];
      for (let j = 0; j < scopeVars.length; j++) {
        if (scopeVars[j].position && stack.length > scopeVars[j].position) {
          const buf = new Buffer(stack[scopeVars[j].position].data);
          const num = new BigNumber("0x" + buf.toString("hex"));
          variables.push({
            name: scopeVars[j].name,
            type: scopeVars[j].type,
            value: num.toString(),
            variablesReference: 0
          });
        }
      }
    }

    return variables;
  }

  /*
   * Set breakpoint in file with given line.
   */
  public setBreakPoint(path: string, line: number) : SdbBreakpoint {

    const bp = <SdbBreakpoint> { verified: false, line, id: this._breakpointId++ };
    let bps = this._breakPoints.get(path);
    if (!bps) {
      bps = new Array<SdbBreakpoint>();
      this._breakPoints.set(path, bps);
    }
    bps.push(bp);

    this.verifyBreakpoints(path);

    return bp;
  }

  /*
   * Clear breakpoint in file with given line.
   */
  public clearBreakPoint(path: string, line: number) : SdbBreakpoint | undefined {
    let bps = this._breakPoints.get(path);
    if (bps) {
      const index = bps.findIndex(bp => bp.line === line);
      if (index >= 0) {
        const bp = bps[index];
        bps.splice(index, 1);
        return bp;
      }
    }
    return undefined;
  }

  /*
   * Clear all breakpoints for file.
   */
  public clearBreakpoints(path: string): void {
    this._breakPoints.delete(path);
  }

  // private methods

  /**
   * Run through the file.
   * If stepEvent is specified only run a single step and emit the stepEvent.
   */
  private run(reverse = false, stepEvent?: string) : void {
    this._priorUiCallStack = CircularJSON.parse(CircularJSON.stringify(this._callStack));
    this._priorUiStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

    // We should be stopped currently, which is why we're calling this function
    // so we should continue on now
    this.respondToDebugHook();

    if (reverse) {
      // TODO: implement reverse running

      /*for (let ln = this._currentLine-1; ln >= 0; ln--) {
        if (this.fireEventsForLine(ln, stepEvent)) {
          this._currentLine = ln;
          return;
        }
      }
      // no more lines: stop at first line
      this._currentLine = 0;
      this.sendEvent('stopOnEntry');*/
    } else {
      this.on("step", function handler(this: LibSdb) {
        if (this.fireEventsForStep(stepEvent)) {
          // we've stopped for some reason. let's not continue
          this.removeListener("step", handler);

          // TODO: handle end of evm?
          /*if (this.) {
            // we've finished the evm
            this.sendEvent("end");
          }*/
        }
        else {
          // this is not the step we're looking for; move along
          this.respondToDebugHook();
        }
      });
    }
  }

  private respondToDebugHook(content = null) {
    // don't respond if we don't actually need to
    if (this._stepData === null) {
      return;
    }

    this._priorStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

    const response = {
      "status": "ok",
      "id": this._stepData.debuggerMessageId,
      "messageType": "response",
      "content": content
    };
    this._socket.write(CircularJSON.stringify(response));
    this._stepData = null;
  }
  
  private verifyAllBreakpoints() : void {
    this._breakPoints.forEach((bps, path) => {
      this.verifyBreakpoints(path);
    })
  }

  private verifyBreakpoints(path: string) : void {
    let bps = this._breakPoints.get(path);
    if (bps) {
      bps.forEach(bp => {
        // Temporarily validate each breakpoint
        bp.verified = true;
        this.sendEvent('breakpointValidated', bp);

        // TODO: real breakpoint verification
        /*if (!bp.verified && bp.line < this._sourceLines.length) {
          const srcLine = this._sourceLines[bp.line].trim();

          // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
          if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
            bp.line++;
          }
          // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
          if (srcLine.indexOf('-') === 0) {
            bp.line--;
          }
          // don't set 'verified' to true if the line contains the word 'lazy'
          // in this case the breakpoint will be verified 'lazy' after hitting it once.
          if (srcLine.indexOf('lazy') < 0) {
            bp.verified = true;
            this.sendEvent('breakpointValidated', bp);
          }
        }*/
      });
    }
  }

  /**
   * Fire events if line has a breakpoint or the word 'exception' is found.
   * Returns true is execution needs to stop.
   */
  private fireEventsForStep(stepEvent?: string): boolean {
    if(this._stepData === null || this._stepData.location === null || this._stepData.location.start === null) {
      return false;
    }

    const ln = this._stepData.location.start.line;
    console.log(ln);

    if (this._priorUiCallStack && this._priorUiStepData) {
      const callDepthChange = this._callStack.length - this._priorUiCallStack.length;
      const differentLine = ln !== this._priorUiStepData.location.start.line;
      switch (stepEvent) {
        case "stopOnStepOver":
          if (callDepthChange === 0 && differentLine) {
            this.sendEvent("stopOnStepOver");
            return true;
          }
          break;
        case "stopOnStepIn":
          const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, this._compilationResult.sources["DebugContract.sol"]);
          if (callDepthChange > 0 && differentLine && node === null) {
            this.sendEvent("stopOnStepIn");
            return true;
          }
          break;
        case "stopOnStepOut":
          if (callDepthChange < 0 && differentLine) {
            this.sendEvent("stopOnStepOut");
            return true;
          }
          break;
        default:
          break;
      }
    }

    // TODO: do we need to do an output event send?
    // this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)

    // TODO: figure out if an exception happened? do exceptions happen in the VM?
    /*if (line.indexOf('exception') >= 0) {
      this.sendEvent('stopOnException');
      return true;
    }*/

    // TODO: Stop on out of gas. I'd call that an exception

    // is there a breakpoint?
    const breakpoints = this._breakPoints.get(this._compilationResult.contracts[this._compilationResult.contractMap[this._stepData.contractAddress]].sourcePath);
    if (breakpoints) {
      let priorLine = null;
      if (this._priorUiStepData && this._priorUiStepData.location.start) {
        priorLine = this._priorUiStepData.location.start.line;
      }
      const bps = breakpoints.filter(bp => bp.line === ln && (priorLine === null || ln !== priorLine));
      if (bps.length > 0) {

        // send 'stopped' event
        this.sendEvent('stopOnBreakpoint');

        // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
        // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
        if (!bps[0].verified) {
          bps[0].verified = true;
          this.sendEvent('breakpointValidated', bps[0]);
        }
        return true;
      }
    }

    // nothing interesting found -> continue
    return false;
  }

  public evaluate(expression: string, context: string | undefined, frameId: number | undefined): string {
    let value: string = "";
    const contract = this._compilationResult.contracts[this._compilationResult.contractMap[this._stepData.contractAddress]];

    if (this._stepData !== null && this._stepData.location !== null && this._stepData.location.start !== null) {
      const currentLine = this._stepData.location.start.line;
      let sourceCode = readFileSync(contract.sourcePath).toString();
      if (currentLine > 0) {
        const insertPosition = contract.lineBreaks[currentLine - 1] + 1;
        sourceCode = [sourceCode.slice(0, insertPosition), expression + ";\n", sourceCode.slice(insertPosition)].join('');
        let result = compile(sourceCode, 0);
        console.log(result);
      }
    }

    return value;
  }

  private sendEvent(event: string, ... args: any[]) {
    setImmediate(_ => {
      this.emit(event, ...args);
    });
  }
}